#!/usr/bin/env python3
"""Install App Store profiles for the shared iOS Distribution certificate.

Uses the App Store Connect REST API (ES256 JWT, audience appstoreconnect-v1).
The certificate itself is imported from the DIST_CERT_P12 secret. This module
never creates or revokes certificates. It only fetches an App Store profile
tied to that certificate, or creates one when the bundle id does not already
have one.
"""

import base64
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_ROOT = "https://api.appstoreconnect.apple.com"
PROFILE_TYPE = "IOS_APP_STORE"
DISTRIBUTION_CERTIFICATE_ID = "VJ5MXTN7UT"
OPTIONAL_PROFILE_TYPES = {"framework", "library.static", "library.dynamic"}
SIGNING_KEYS = (
    "CODE_SIGN_STYLE",
    "CODE_SIGN_IDENTITY",
    "DEVELOPMENT_TEAM",
    "PROVISIONING_PROFILE",
    "PROVISIONING_PROFILE_SPECIFIER",
    "OTHER_CODE_SIGN_FLAGS",
)


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text):
    pad = "=" * ((-len(text)) % 4)
    return base64.urlsafe_b64decode(text + pad)


def der_to_raw(der):
    """Turn an OpenSSL ECDSA DER signature into the 64-byte JWT form."""
    if len(der) < 8 or der[0] != 0x30:
        raise ValueError("not a DER signature")
    index = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    numbers = []
    for _ in range(2):
        if index >= len(der) or der[index] != 0x02:
            raise ValueError("expected an integer in the signature")
        index += 1
        length = der[index]
        index += 1
        if length & 0x80:
            count = length & 0x7F
            length = int.from_bytes(der[index:index + count], "big")
            index += count
        value = der[index:index + length]
        index += length
        value = value.lstrip(b"\x00")
        if len(value) > 32:
            raise ValueError("signature integer is too wide")
        numbers.append(value.rjust(32, b"\x00"))
    return numbers[0] + numbers[1]


def raw_to_der(raw):
    if len(raw) != 64:
        raise ValueError("expected a 64-byte signature")

    def encode(part):
        value = part.lstrip(b"\x00") or b"\x00"
        if value[0] & 0x80:
            value = b"\x00" + value
        return b"\x02" + bytes([len(value)]) + value

    body = encode(raw[:32]) + encode(raw[32:])
    return b"\x30" + bytes([len(body)]) + body


def sign_es256(pem, message):
    with tempfile.NamedTemporaryFile() as key_file:
        key_file.write(pem if pem.endswith(b"\n") else pem + b"\n")
        key_file.flush()
        signed = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", key_file.name],
            input=message,
            capture_output=True,
            check=False,
        )
    if signed.returncode != 0 or not signed.stdout:
        raise SystemExit("Could not sign the App Store Connect request.")
    return der_to_raw(signed.stdout)


def make_jwt(pem, key_id, issuer, now):
    header = b64url(json.dumps(
        {"alg": "ES256", "kid": key_id, "typ": "JWT"},
        separators=(",", ":"),
    ).encode())
    payload = b64url(json.dumps(
        {
            "iss": issuer,
            "iat": now,
            "exp": now + (19 * 60),
            "aud": "appstoreconnect-v1",
        },
        separators=(",", ":"),
    ).encode())
    signing_input = f"{header}.{payload}".encode()
    signature = b64url(sign_es256(pem, signing_input))
    return f"{header}.{payload}.{signature}"


def stop_api(status, body, context):
    text = body.strip() or f"HTTP {status}"
    sys.stderr.write(text)
    if not text.endswith("\n"):
        sys.stderr.write("\n")
    sys.stderr.write(
        f"{context} failed with HTTP {status}. Stopped without creating a certificate.\n"
    )
    raise SystemExit(1)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(token, method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    # Reads can time out after the upload has already succeeded. Retry those.
    # Writes are not retried, so a timeout cannot create a second certificate or profile.
    attempts = 4 if method == "GET" else 1
    for attempt in range(attempts):
        request = urllib.request.Request(API_ROOT + path, data=data, method=method)
        request.add_header("Authorization", "Bearer " + token)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        opener = urllib.request.build_opener(NoRedirect)
        try:
            with opener.open(request, timeout=60) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt + 1 == attempts:
                raise SystemExit(
                    "Could not reach App Store Connect. Stopped without creating a certificate."
                )
            time.sleep(2 * (attempt + 1))
    raise SystemExit("Could not reach App Store Connect. Stopped without creating a certificate.")


def api_path(url_or_path):
    if url_or_path.startswith(API_ROOT):
        return url_or_path[len(API_ROOT):]
    return url_or_path


def load_pem(path):
    return Path(path).read_bytes()


def jwt_from_env():
    pem = load_pem(os.environ["KEY_PATH"])
    return make_jwt(
        pem,
        os.environ["ASC_KEY_ID"],
        os.environ["ASC_ISSUER_ID"],
        int(time.time()),
    )


def parse_data(status, body, context):
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        stop_api(status, body, context)
    if status not in (200, 201) or "data" not in parsed:
        stop_api(status, body, context)
    return parsed


def parse_time(value):
    if not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def decode_p12():
    """Write DIST_CERT_P12 to P12_PATH. Error text never includes the secret."""
    text = os.environ.get("DIST_CERT_P12", "")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff").strip()
    if "PRIVATE KEY" in normalized or "BEGIN CERTIFICATE" in normalized:
        raise SystemExit("DIST_CERT_P12 must be a base64-encoded PKCS#12 file.")
    compact = "".join(normalized.split())
    if not compact:
        raise SystemExit("DIST_CERT_P12 is empty.")
    pad = "=" * ((-len(compact)) % 4)
    try:
        data = base64.b64decode(compact + pad, validate=True)
    except Exception:
        raise SystemExit("DIST_CERT_P12 is not valid base64.")
    if len(data) < 4 or data[0] != 0x30:
        raise SystemExit("DIST_CERT_P12 did not decode to a PKCS#12 file.")
    destination = Path(os.environ["P12_PATH"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    os.chmod(destination, 0o600)


def pem_to_der(pem_bytes):
    converted = subprocess.run(
        ["openssl", "x509", "-inform", "PEM", "-outform", "DER"],
        input=pem_bytes if pem_bytes.endswith(b"\n") else pem_bytes + b"\n",
        capture_output=True,
        check=False,
    )
    if converted.returncode != 0 or not converted.stdout:
        return None
    return converted.stdout


def load_der_certs(pem_text):
    ders = []
    for part in pem_text.split("-----END CERTIFICATE-----"):
        if "-----BEGIN CERTIFICATE-----" not in part:
            continue
        pem = part[part.index("-----BEGIN CERTIFICATE-----"):] + "-----END CERTIFICATE-----\n"
        der = pem_to_der(pem.encode())
        if der:
            ders.append(der)
    return ders


def fetch_certificate_der(token, certificate_id):
    status, body = api(token, "GET", "/v1/certificates/" + urllib.parse.quote(certificate_id))
    parsed = parse_data(status, body, "certificate lookup")
    data = parsed["data"]
    if data.get("id") != certificate_id:
        raise SystemExit(
            "App Store Connect returned a different certificate than the shared distribution certificate."
        )
    attributes = data.get("attributes") or {}
    if attributes.get("certificateType") != "IOS_DISTRIBUTION":
        raise SystemExit("The shared certificate is not an iOS Distribution certificate.")
    expires = parse_time(attributes.get("expirationDate"))
    if expires is not None and expires <= datetime.now(timezone.utc):
        raise SystemExit("The shared iOS Distribution certificate is expired.")
    content = attributes.get("certificateContent")
    if not content:
        stop_api(status, body, "certificate lookup")
    return base64.b64decode("".join(content.split()))


def find_bundle_id(token, identifier):
    query = urllib.parse.urlencode({"filter[identifier]": identifier, "limit": "5"})
    status, body = api(token, "GET", "/v1/bundleIds?" + query)
    parsed = parse_data(status, body, "bundle ID lookup")
    for item in parsed["data"]:
        if item.get("attributes", {}).get("identifier") == identifier:
            return item["id"]
    return None


def profile_records(items):
    records = []
    for item in items:
        attributes = item.get("attributes") or {}
        relationships = item.get("relationships") or {}
        bundle = ((relationships.get("bundleId") or {}).get("data") or {}).get("id")
        certificates = [
            cert.get("id")
            for cert in ((relationships.get("certificates") or {}).get("data") or [])
            if cert.get("id")
        ]
        records.append({
            "id": item.get("id"),
            "name": attributes.get("name") or "",
            "profile_type": attributes.get("profileType"),
            "state": attributes.get("profileState"),
            "expires": parse_time(attributes.get("expirationDate")),
            "bundle_resource_id": bundle,
            "certificate_ids": certificates,
        })
    return records


def list_profiles(token, name=None, profile_type=PROFILE_TYPE):
    query = {
        "include": "bundleId,certificates",
        "limit": "200",
    }
    if profile_type:
        query["filter[profileType]"] = profile_type
    if name:
        query["filter[name]"] = name
    path = "/v1/profiles?" + urllib.parse.urlencode(query)
    records = []
    pages = 0
    while path and pages < 20:
        pages += 1
        status, body = api(token, "GET", path)
        parsed = parse_data(status, body, "profile lookup")
        records.extend(profile_records(parsed.get("data") or []))
        path = api_path(((parsed.get("links") or {}).get("next")) or "")
    return records


def choose_profile(records, bundle_resource_id, certificate_id, now):
    matches = []
    for record in records:
        if record["bundle_resource_id"] != bundle_resource_id:
            continue
        if record["profile_type"] != PROFILE_TYPE:
            continue
        if record.get("state") not in (None, "", "ACTIVE"):
            continue
        if certificate_id not in record["certificate_ids"]:
            continue
        expires = record.get("expires")
        if expires is not None and expires <= now:
            continue
        matches.append(record)
    if not matches:
        return None

    def sort_key(item):
        return item.get("expires") or datetime.max.replace(tzinfo=timezone.utc)

    matches.sort(key=sort_key)
    return matches[-1]


def delete_profile(token, profile_id):
    status, body = api(token, "DELETE", "/v1/profiles/" + urllib.parse.quote(profile_id))
    if status in (204, 404):
        return
    stop_api(status, body, "profile delete")


def profile_payload(name, bundle_resource_id, certificate_id):
    return {
        "data": {
            "type": "profiles",
            "attributes": {
                "name": name,
                "profileType": PROFILE_TYPE,
            },
            "relationships": {
                "bundleId": {
                    "data": {"type": "bundleIds", "id": bundle_resource_id}
                },
                "certificates": {
                    "data": [{"type": "certificates", "id": certificate_id}]
                },
            },
        }
    }


def create_profile(token, name, bundle_resource_id, certificate_id):
    payload = profile_payload(name, bundle_resource_id, certificate_id)
    status, body = api(token, "POST", "/v1/profiles", payload)
    if status == 409 and "Multiple profiles" in body:
        return None
    parsed = parse_data(status, body, "profile")
    attributes = parsed["data"].get("attributes") or {}
    content = attributes.get("profileContent")
    if not content:
        stop_api(status, body, "profile")
    return parsed["data"]["id"], attributes.get("name") or name, base64.b64decode(content)


def download_profile(token, profile_id):
    status, body = api(token, "GET", "/v1/profiles/" + urllib.parse.quote(profile_id))
    parsed = parse_data(status, body, "profile")
    content = (parsed["data"].get("attributes") or {}).get("profileContent")
    if not content:
        stop_api(status, body, "profile")
    return base64.b64decode(content)


def profiles_to_replace(records, preferred_name):
    """Profiles that block a new one: same name, and not already chosen as usable."""
    return [
        record for record in records
        if record["name"] == preferred_name and record["profile_type"] in (None, "", PROFILE_TYPE)
    ]


def replace_named_profiles(token, records, bundle_id, preferred_name):
    stale = profiles_to_replace(records, preferred_name)
    for record in stale:
        print(
            f"Replacing the App Store profile for {bundle_id} so it is tied to the shared distribution certificate.",
            flush=True,
        )
        delete_profile(token, record["id"])
    return len(stale)


def fetch_or_create_profile(token, bundle_resource_id, bundle_id, preferred_name):
    records = list_profiles(token)
    chosen = choose_profile(
        records,
        bundle_resource_id,
        DISTRIBUTION_CERTIFICATE_ID,
        datetime.now(timezone.utc),
    )
    if chosen:
        print(f"Using the App Store profile for {bundle_id}.", flush=True)
        return chosen["id"], chosen["name"], download_profile(token, chosen["id"])
    replace_named_profiles(token, records, bundle_id, preferred_name)
    print(f"Creating an App Store profile for {bundle_id}.", flush=True)
    created = create_profile(
        token,
        preferred_name,
        bundle_resource_id,
        DISTRIBUTION_CERTIFICATE_ID,
    )
    if created is not None:
        return created
    # Apple refuses the name when more than one profile already uses it, even if the
    # typed list above did not return those rows.
    print(
        f"Removing duplicate App Store profiles named {preferred_name}.",
        flush=True,
    )
    replace_named_profiles(
        token,
        list_profiles(token, name=preferred_name, profile_type=None),
        bundle_id,
        preferred_name,
    )
    created = create_profile(
        token,
        preferred_name,
        bundle_resource_id,
        DISTRIBUTION_CERTIFICATE_ID,
    )
    if created is None:
        raise SystemExit(
            f"Multiple profiles are still named {preferred_name}. Stopped without creating a certificate."
        )
    return created


def decode_profile(raw):
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "profile.mobileprovision"
        decoded = Path(directory) / "profile.plist"
        source.write_bytes(raw)
        verified = subprocess.run(
            [
                "openssl", "cms", "-verify", "-inform", "DER", "-in", str(source),
                "-noverify", "-binary", "-out", str(decoded),
            ],
            capture_output=True,
            check=False,
        )
        payload = decoded.read_bytes() if decoded.is_file() else b""
        if not payload:
            payload = verified.stdout
        if payload:
            try:
                return plistlib.loads(payload)
            except Exception:
                payload = b""
        if shutil.which("security"):
            security = subprocess.run(
                ["security", "cms", "-D", "-i", str(source)],
                capture_output=True,
                check=False,
            )
            if security.stdout:
                try:
                    return plistlib.loads(security.stdout)
                except Exception:
                    pass
    raise SystemExit("Could not read the provisioning profile.")


def assert_profile_tied(plist, bundle_id, cert_der):
    certificates = list(plist.get("DeveloperCertificates") or [])
    if cert_der not in certificates:
        raise SystemExit(
            f"The App Store profile for {bundle_id} is not tied to the installed distribution certificate."
        )
    application_id = str((plist.get("Entitlements") or {}).get("application-identifier") or "")
    if not application_id.endswith("." + bundle_id):
        raise SystemExit(f"The App Store profile is not for {bundle_id}.")


def install_profile(raw, profile_uuid, directory):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{profile_uuid}.mobileprovision"
    path.write_bytes(raw)
    os.chmod(path, 0o644)
    return path


def profile_name_for(name, bundle_id):
    if bundle_id == "com.lojo.Mail":
        return "LOJO Mail App Store"
    return f"LOJO Mail {name} App Store"


def archive_targets(text):
    """Non-test targets from project.yml, in file order."""
    lines = text.splitlines()
    in_targets = False
    current = None
    found = []

    def finish():
        nonlocal current
        if current is not None:
            found.append(current)
            current = None

    for line in lines:
        if not in_targets:
            if line == "targets:" or line.startswith("targets:"):
                in_targets = True
            continue
        if line and not line.startswith(" ") and not line.startswith("\t"):
            finish()
            break
        name_match = re.match(r"^  ([A-Za-z0-9_.-]+):\s*$", line)
        if name_match:
            finish()
            current = {"name": name_match.group(1), "type": "", "bundle_id": ""}
            continue
        if current is None:
            continue
        type_match = re.match(r"^    type:\s*(\S+)\s*$", line)
        if type_match:
            current["type"] = type_match.group(1)
            continue
        bundle_match = re.match(r"^\s*PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)\s*$", line)
        if bundle_match:
            current["bundle_id"] = bundle_match.group(1).strip("\"'")
    finish()

    selected = []
    for item in found:
        kind = item["type"]
        if not kind or not item["bundle_id"]:
            raise SystemExit(f"Target {item['name']} is missing a type or bundle id.")
        if "test" in kind.lower():
            continue
        selected.append({
            "name": item["name"],
            "type": kind,
            "bundle_id": item["bundle_id"],
            "optional": kind in OPTIONAL_PROFILE_TYPES,
            "profile_name": profile_name_for(item["name"], item["bundle_id"]),
        })
    if not selected:
        raise SystemExit("No archive targets were found.")
    return selected


def split_build_settings(text):
    lines = text.splitlines(keepends=True)
    pieces = []
    index = 0
    while index < len(lines):
        if "buildSettings = {" not in lines[index]:
            pieces.append(lines[index])
            index += 1
            continue
        block = [lines[index]]
        index += 1
        depth = lines[index - 1].count("{") - lines[index - 1].count("}")
        while index < len(lines) and depth > 0:
            block.append(lines[index])
            depth += lines[index].count("{") - lines[index].count("}")
            index += 1
        pieces.append(block)
    return pieces


def bundle_in_block(text, bundle_id):
    return (
        f"PRODUCT_BUNDLE_IDENTIFIER = {bundle_id};" in text
        or f'PRODUCT_BUNDLE_IDENTIFIER = "{bundle_id}";' in text
    )


def assignment_for(block_text, assignments):
    ordered = sorted(assignments, key=lambda item: len(item[0]), reverse=True)
    for bundle_id, profile_name in ordered:
        if bundle_in_block(block_text, bundle_id):
            return profile_name
    return None


def count_signing_blocks(text, bundle_ids):
    assignments = [(bundle_id, "") for bundle_id in bundle_ids]
    count = 0
    for piece in split_build_settings(text):
        if isinstance(piece, list) and assignment_for("".join(piece), assignments) is not None:
            count += 1
    return count


def rewrite_settings(block, team, keychain, identity, profile_name):
    indent = "\t\t\t\t"
    for line in block:
        stripped = line.lstrip()
        if stripped.startswith("PRODUCT_BUNDLE_IDENTIFIER"):
            indent = line[:len(line) - len(stripped)]
            break
    kept = []
    for line in block[:-1]:
        stripped = line.strip()
        if any(stripped.startswith(key + " ") or stripped.startswith(key + "=") for key in SIGNING_KEYS):
            continue
        kept.append(line)
    flag = f"--keychain {keychain}"
    settings = [
        f"{indent}CODE_SIGN_STYLE = Manual;\n",
        f'{indent}CODE_SIGN_IDENTITY = "{identity}";\n',
    ]
    # A team without a profile makes Xcode demand one and can fall through to
    # automatic signing. Frameworks are signed with the distribution identity only.
    if profile_name:
        settings.append(f"{indent}DEVELOPMENT_TEAM = {team};\n")
        settings.append(f'{indent}PROVISIONING_PROFILE_SPECIFIER = "{profile_name}";\n')
    else:
        settings.append(f'{indent}PROVISIONING_PROFILE_SPECIFIER = "";\n')
    settings.append(f'{indent}OTHER_CODE_SIGN_FLAGS = "{flag}";\n')
    kept.extend(settings)
    kept.append(block[-1])
    return kept


def patch_pbxproj(text, team, keychain, identity, assignments):
    output = []
    for piece in split_build_settings(text):
        if isinstance(piece, str):
            output.append(piece)
            continue
        matched = assignment_for("".join(piece), assignments)
        if matched is None:
            output.extend(piece)
            continue
        output.extend(rewrite_settings(piece, team, keychain, identity, matched))
    return "".join(output)


def write_export_options(path, team, identity, assignments):
    profiles = {bundle_id: name for bundle_id, name in assignments if name}
    if "com.lojo.Mail" not in profiles:
        raise SystemExit("The App Store profile for com.lojo.Mail was not installed.")
    payload = {
        "method": "app-store-connect",
        "signingStyle": "manual",
        "signingCertificate": identity,
        "teamID": team,
        "destination": "upload",
        "uploadSymbols": True,
        "manageAppVersionAndBuildNumber": False,
        "provisioningProfiles": profiles,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        plistlib.dump(payload, handle)


def write_manifest(path, profiles):
    payload = {
        "certificateId": DISTRIBUTION_CERTIFICATE_ID,
        "profiles": profiles,
    }
    Path(path).write_text(json.dumps(payload))
    os.chmod(path, 0o600)


def prepare(argv):
    installed = load_der_certs(Path(argv["installed_certs"]).read_text())
    if not installed:
        raise SystemExit("The distribution certificate did not import into the temporary keychain.")
    token = jwt_from_env()
    remote = fetch_certificate_der(token, DISTRIBUTION_CERTIFICATE_ID)
    if remote not in installed:
        raise SystemExit(
            "The installed distribution certificate does not match "
            f"{DISTRIBUTION_CERTIFICATE_ID}. Stopped without creating a certificate."
        )
    print(
        f"Using the shared iOS Distribution certificate {DISTRIBUTION_CERTIFICATE_ID}.",
        flush=True,
    )
    targets = archive_targets(Path(argv["project_yml"]).read_text())
    if not any(item["bundle_id"] == "com.lojo.Mail" for item in targets):
        raise SystemExit("project.yml has no com.lojo.Mail target.")
    profiles_dir = Path(argv["profiles_dir"]).expanduser()
    manifest_path = Path(argv["manifest"])
    installed_profiles = []
    assignments = []
    try:
        for target in targets:
            bundle_id = target["bundle_id"]
            resource_id = find_bundle_id(token, bundle_id)
            if resource_id is None:
                if target["optional"]:
                    print(
                        f"No App ID for {bundle_id}. Signing that target with the distribution certificate and no profile.",
                        flush=True,
                    )
                    assignments.append((bundle_id, ""))
                    continue
                sys.stderr.write(
                    f"No App Store Connect bundle ID for {bundle_id}. "
                    "Create that App ID first. Stopped without creating a certificate.\n"
                )
                raise SystemExit(1)
            print(f"Fetching an App Store profile for {bundle_id}.", flush=True)
            profile_id, _name, raw = fetch_or_create_profile(
                token,
                resource_id,
                bundle_id,
                target["profile_name"],
            )
            plist = decode_profile(raw)
            assert_profile_tied(plist, bundle_id, remote)
            profile_uuid = str(plist.get("UUID") or "").strip()
            if not profile_uuid:
                raise SystemExit(f"The App Store profile for {bundle_id} has no UUID.")
            path = install_profile(raw, profile_uuid, profiles_dir)
            name = str(plist.get("Name") or target["profile_name"])
            installed_profiles.append({
                "id": profile_id,
                "name": name,
                "bundleId": bundle_id,
                "path": str(path),
            })
            assignments.append((bundle_id, name))
            write_manifest(manifest_path, installed_profiles)
    except SystemExit:
        write_manifest(manifest_path, installed_profiles)
        raise
    project = Path(argv["pbxproj"])
    original = project.read_text()
    patched = patch_pbxproj(
        original,
        argv["team"],
        argv["keychain"],
        argv["identity"],
        assignments,
    )
    expected = count_signing_blocks(original, [bundle_id for bundle_id, _name in assignments])
    if expected < 1 or patched.count("CODE_SIGN_STYLE = Manual;") != expected:
        raise SystemExit("Could not set manual signing on every archive target.")
    if argv["identity"] not in patched:
        raise SystemExit("Could not set the distribution signing identity.")
    project.write_text(patched)
    write_export_options(
        Path(argv["export_plist"]),
        argv["team"],
        argv["identity"],
        assignments,
    )
    write_manifest(manifest_path, installed_profiles)


def cleanup():
    """Delete local profile copies. Does not call App Store Connect."""
    manifest_path = Path(os.environ["SIGNING_MANIFEST"])
    if not manifest_path.is_file():
        return
    manifest = json.loads(manifest_path.read_text())
    for profile in manifest.get("profiles", []):
        path = profile.get("path")
        if path:
            Path(path).unlink(missing_ok=True)


def self_test():
    der_roundtrip()
    jwt_roundtrip()
    pbxproj_roundtrip()
    export_roundtrip()
    p12_roundtrip()
    targets_roundtrip()
    choose_profile_roundtrip()
    tied_roundtrip()
    prepare_roundtrip()
    cleanup_roundtrip()
    api_retry_roundtrip()
    no_mint_roundtrip()
    print("asc signing ok")


def der_roundtrip():
    raw = bytes(range(32)) + bytes(range(32, 64))
    raw = b"\x80" + raw[1:32] + b"\x7f" + raw[33:]
    der = raw_to_der(raw)
    if der_to_raw(der) != raw:
        raise SystemExit("DER signature roundtrip failed")


def jwt_roundtrip():
    with tempfile.TemporaryDirectory() as directory:
        key_path = Path(directory) / "key.pem"
        created = subprocess.run(
            ["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", str(key_path)],
            capture_output=True,
            check=False,
        )
        if created.returncode != 0:
            raise SystemExit("Could not generate a test signing key.")
        pem = key_path.read_bytes()
        token = make_jwt(pem, "KEYID1234", "issuer-id", 1_700_000_000)
        header_text, payload_text, signature_text = token.split(".")
        header = json.loads(b64url_decode(header_text))
        payload = json.loads(b64url_decode(payload_text))
        if header.get("alg") != "ES256" or header.get("kid") != "KEYID1234":
            raise SystemExit("JWT header was not ES256")
        if payload.get("aud") != "appstoreconnect-v1" or payload.get("iss") != "issuer-id":
            raise SystemExit("JWT audience was not appstoreconnect-v1")
        if b"BEGIN PRIVATE KEY" in token.encode() or b"BEGIN EC PRIVATE KEY" in token.encode():
            raise SystemExit("JWT included the private key")
        public_path = Path(directory) / "pub.pem"
        extracted = subprocess.run(
            ["openssl", "ec", "-pubout", "-in", str(key_path), "-out", str(public_path)],
            capture_output=True,
            check=False,
        )
        if extracted.returncode != 0:
            raise SystemExit("Could not read the test public key.")
        signature = raw_to_der(b64url_decode(signature_text))
        signature_path = Path(directory) / "sig.der"
        signature_path.write_bytes(signature)
        verified = subprocess.run(
            [
                "openssl", "dgst", "-sha256", "-verify", str(public_path),
                "-signature", str(signature_path),
            ],
            input=f"{header_text}.{payload_text}".encode(),
            capture_output=True,
            check=False,
        )
        if verified.returncode != 0:
            raise SystemExit("JWT signature did not verify")


def sample_pbxproj():
    return """
\t\tbuildSettings = {
\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\tDEVELOPMENT_TEAM = EXAMPLETEAM;
\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.lojo.Mail;
\t\t};
\t\tbuildSettings = {
\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.lojo.Mail;
\t\t};
\t\tbuildSettings = {
\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.lojo.Mail.core;
\t\t};
\t\tbuildSettings = {
\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.lojo.Mail.tests;
\t\t};
\t\tbuildSettings = {
\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.lojo.Mail.uitests;
\t\t};
"""


def pbxproj_roundtrip():
    assignments = [
        ("com.lojo.Mail", "LOJO Mail App Store"),
        ("com.lojo.Mail.core", ""),
    ]
    patched = patch_pbxproj(
        sample_pbxproj(),
        "EXAMPLETEAM",
        "/tmp/signing.keychain-db",
        "Apple Distribution",
        assignments,
    )
    if patched.count("CODE_SIGN_STYLE = Manual;") != 3:
        raise SystemExit("pbxproj did not set manual signing on the app and framework")
    if patched.count("CODE_SIGN_STYLE = Automatic;") != 2:
        raise SystemExit("pbxproj changed a test bundle")
    if patched.count('PROVISIONING_PROFILE_SPECIFIER = "LOJO Mail App Store";') != 2:
        raise SystemExit("pbxproj missed the iOS profile name")
    if patched.count("DEVELOPMENT_TEAM = EXAMPLETEAM;") != 2:
        raise SystemExit("pbxproj did not keep the team on the app configurations")
    if 'PROVISIONING_PROFILE_SPECIFIER = "";' not in patched:
        raise SystemExit("pbxproj gave the framework an App Store profile")
    if "Apple Distribution" not in patched or "/tmp/signing.keychain-db" not in patched:
        raise SystemExit("pbxproj missed the distribution identity or keychain")
    for piece in split_build_settings(patched):
        if not isinstance(piece, list):
            continue
        block = "".join(piece)
        if "com.lojo.Mail.core" in block and (
            "LOJO Mail App Store" in block or "DEVELOPMENT_TEAM" in block
        ):
            raise SystemExit("framework block reused the app profile or team")
        if bundle_in_block(block, "com.lojo.Mail") and 'PROVISIONING_PROFILE_SPECIFIER = "";' in block:
            raise SystemExit("app block lost its profile")


def export_roundtrip():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "ExportOptions.plist"
        write_export_options(path, "EXAMPLETEAM", "Apple Distribution", [
            ("com.lojo.Mail", "LOJO Mail App Store"),
            ("com.lojo.Mail.core", ""),
        ])
        with path.open("rb") as handle:
            payload = plistlib.load(handle)
        if payload["method"] != "app-store-connect" or payload["signingStyle"] != "manual":
            raise SystemExit("export options were not manual app-store-connect")
        if payload["signingCertificate"] != "Apple Distribution":
            raise SystemExit("export options missed Apple Distribution")
        if payload["destination"] != "upload" or payload["manageAppVersionAndBuildNumber"] is not False:
            raise SystemExit("export options did not keep the build number or upload destination")
        profiles = payload["provisioningProfiles"]
        if profiles.get("com.lojo.Mail") != "LOJO Mail App Store":
            raise SystemExit("export options missed the iOS profile")
        if "com.lojo.Mail.core" in profiles or len(profiles) != 1:
            raise SystemExit("export options included a target without a profile")


def p12_roundtrip():
    payload = b"\x30\x03\x02\x01\x01"
    encoded = base64.b64encode(payload).decode()
    wrapped = "\n".join(encoded[i:i + 8] for i in range(0, len(encoded), 8))
    previous_p12 = os.environ.get("DIST_CERT_P12")
    previous_path = os.environ.get("P12_PATH")
    try:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "distribution.p12"
            os.environ["DIST_CERT_P12"] = wrapped
            os.environ["P12_PATH"] = str(path)
            decode_p12()
            if path.read_bytes() != payload:
                raise SystemExit("p12 decode mismatch")
            os.environ["DIST_CERT_P12"] = "not-a-cert SECRETVALUE"
            try:
                decode_p12()
            except SystemExit as error:
                if "SECRETVALUE" in str(error) or "not-a-cert" in str(error):
                    raise SystemExit("p12 error included the secret")
            else:
                raise SystemExit("invalid p12 was accepted")
    finally:
        if previous_p12 is None:
            os.environ.pop("DIST_CERT_P12", None)
        else:
            os.environ["DIST_CERT_P12"] = previous_p12
        if previous_path is None:
            os.environ.pop("P12_PATH", None)
        else:
            os.environ["P12_PATH"] = previous_path


def targets_roundtrip():
    text = Path(__file__).resolve().parents[1].joinpath("project.yml").read_text()
    targets = archive_targets(text)
    bundles = {item["bundle_id"]: item for item in targets}
    if set(bundles) != {"com.lojo.Mail", "com.lojo.Mail.core"}:
        raise SystemExit("archive signing does not cover every non-test target")
    if bundles["com.lojo.Mail"]["optional"] or not bundles["com.lojo.Mail.core"]["optional"]:
        raise SystemExit("profile requirement mismatch")
    if bundles["com.lojo.Mail"]["profile_name"] != "LOJO Mail App Store":
        raise SystemExit("app profile name changed")
    if "com.lojo.Mail.tests" in bundles or "com.lojo.Mail.uitests" in bundles:
        raise SystemExit("test bundles were included in archive signing")


def choose_profile_roundtrip():
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    records = [
        {
            "id": "1",
            "name": "other-cert",
            "bundle_resource_id": "BID",
            "profile_type": PROFILE_TYPE,
            "state": "ACTIVE",
            "certificate_ids": ["OTHER"],
            "expires": datetime(2030, 1, 1, tzinfo=timezone.utc),
        },
        {
            "id": "2",
            "name": "invalid",
            "bundle_resource_id": "BID",
            "profile_type": PROFILE_TYPE,
            "state": "INVALID",
            "certificate_ids": [DISTRIBUTION_CERTIFICATE_ID],
            "expires": datetime(2030, 1, 1, tzinfo=timezone.utc),
        },
        {
            "id": "3",
            "name": "expired",
            "bundle_resource_id": "BID",
            "profile_type": PROFILE_TYPE,
            "state": "ACTIVE",
            "certificate_ids": [DISTRIBUTION_CERTIFICATE_ID],
            "expires": datetime(2020, 1, 1, tzinfo=timezone.utc),
        },
        {
            "id": "4",
            "name": "usable",
            "bundle_resource_id": "BID",
            "profile_type": PROFILE_TYPE,
            "state": "ACTIVE",
            "certificate_ids": [DISTRIBUTION_CERTIFICATE_ID],
            "expires": datetime(2028, 1, 1, tzinfo=timezone.utc),
        },
        {
            "id": "5",
            "name": "other-app",
            "bundle_resource_id": "OTHER",
            "profile_type": PROFILE_TYPE,
            "state": "ACTIVE",
            "certificate_ids": [DISTRIBUTION_CERTIFICATE_ID],
            "expires": datetime(2031, 1, 1, tzinfo=timezone.utc),
        },
    ]
    chosen = choose_profile(records, "BID", DISTRIBUTION_CERTIFICATE_ID, now)
    if chosen is None or chosen["id"] != "4":
        raise SystemExit("profile selection did not keep the shared certificate")
    payload = profile_payload("LOJO Mail App Store", "BID", DISTRIBUTION_CERTIFICATE_ID)
    certificates = payload["data"]["relationships"]["certificates"]["data"]
    if certificates != [{"type": "certificates", "id": DISTRIBUTION_CERTIFICATE_ID}]:
        raise SystemExit("new profiles must be tied only to the shared certificate")


def make_self_signed():
    with tempfile.TemporaryDirectory() as directory:
        key = Path(directory) / "key.pem"
        cert = Path(directory) / "cert.pem"
        der = Path(directory) / "cert.der"
        created = subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048",
                "-keyout", str(key), "-out", str(cert),
                "-days", "2", "-nodes", "-subj", "/CN=Apple Distribution Test",
            ],
            capture_output=True,
            check=False,
        )
        if created.returncode != 0:
            raise SystemExit("Could not generate a test certificate.")
        converted = subprocess.run(
            ["openssl", "x509", "-in", str(cert), "-outform", "DER", "-out", str(der)],
            capture_output=True,
            check=False,
        )
        if converted.returncode != 0:
            raise SystemExit("Could not convert the test certificate.")
        return cert.read_bytes(), der.read_bytes(), key.read_bytes()


def cms_sign(content):
    with tempfile.TemporaryDirectory() as directory:
        key = Path(directory) / "key.pem"
        cert = Path(directory) / "cert.pem"
        data = Path(directory) / "content"
        signed = Path(directory) / "signed.der"
        data.write_bytes(content)
        created = subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048",
                "-keyout", str(key), "-out", str(cert),
                "-days", "1", "-nodes", "-subj", "/CN=Profile Test",
            ],
            capture_output=True,
            check=False,
        )
        if created.returncode != 0:
            raise SystemExit("Could not sign a test profile.")
        signed_cmd = subprocess.run(
            [
                "openssl", "cms", "-sign", "-binary", "-nodetach",
                "-signer", str(cert), "-inkey", str(key),
                "-in", str(data), "-outform", "DER", "-out", str(signed),
            ],
            capture_output=True,
            check=False,
        )
        if signed_cmd.returncode != 0 or not signed.is_file():
            raise SystemExit("Could not sign a test profile.")
        return signed.read_bytes()


def make_profile(cert_der, bundle_id, name, profile_uuid):
    payload = {
        "Name": name,
        "UUID": profile_uuid,
        "DeveloperCertificates": [cert_der],
        "Entitlements": {"application-identifier": f"EXAMPLETEAM.{bundle_id}"},
        "ExpirationDate": datetime(2030, 1, 1, tzinfo=timezone.utc),
    }
    return cms_sign(plistlib.dumps(payload))


def tied_roundtrip():
    _pem, der, _key = make_self_signed()
    plist = decode_profile(make_profile(der, "com.lojo.Mail", "LOJO Mail App Store", "UUID-APP"))
    assert_profile_tied(plist, "com.lojo.Mail", der)
    try:
        assert_profile_tied(plist, "com.lojo.Mail", b"other")
    except SystemExit:
        pass
    else:
        raise SystemExit("a profile with the wrong certificate was accepted")
    try:
        assert_profile_tied(plist, "com.lojo.Mail.core", der)
    except SystemExit:
        pass
    else:
        raise SystemExit("a profile for the wrong bundle id was accepted")


def prepare_roundtrip():
    pem, der, _key = make_self_signed()
    other_pem, _other_der, _other_key = make_self_signed()
    profile_raw = make_profile(der, "com.lojo.Mail", "LOJO Mail App Store", "UUID-APP")
    calls = []
    mode = {"profiles": []}

    def fake_api(token, method, path, payload=None):
        calls.append((method, path, payload))
        if method == "GET" and path.startswith("/v1/certificates/"):
            return 200, json.dumps({
                "data": {
                    "type": "certificates",
                    "id": DISTRIBUTION_CERTIFICATE_ID,
                    "attributes": {
                        "certificateType": "IOS_DISTRIBUTION",
                        "certificateContent": base64.b64encode(der).decode(),
                        "expirationDate": "2030-01-01T00:00:00.000+00:00",
                    },
                }
            })
        if method == "GET" and path.startswith("/v1/bundleIds?"):
            query = urllib.parse.parse_qs(path.split("?", 1)[1])
            identifier = query["filter[identifier]"][0]
            if identifier == "com.lojo.Mail":
                return 200, json.dumps({
                    "data": [{"id": "BIDAPP", "attributes": {"identifier": identifier}}]
                })
            return 200, json.dumps({"data": []})
        if method == "GET" and path.startswith("/v1/profiles?"):
            if ("name%5D=" in path or "filter[name]" in path) and mode.get("named") is not None:
                return 200, json.dumps({"data": mode["named"], "links": {}})
            return 200, json.dumps({"data": mode["profiles"], "links": {}})
        if method == "GET" and path.startswith("/v1/profiles/"):
            return 200, json.dumps({
                "data": {
                    "type": "profiles",
                    "id": path.rsplit("/", 1)[-1],
                    "attributes": {
                        "name": "LOJO Mail App Store",
                        "profileContent": base64.b64encode(profile_raw).decode(),
                    },
                }
            })
        if method == "DELETE" and path.startswith("/v1/profiles/"):
            return 204, ""
        if method == "POST" and path == "/v1/profiles":
            if mode.get("conflict_posts", 0) > 0:
                mode["conflict_posts"] -= 1
                return 409, json.dumps({
                    "errors": [{
                        "status": "409",
                        "code": "ENTITY_ERROR",
                        "detail": "Multiple profiles found with the name 'LOJO Mail App Store'.  Please remove the duplicate profiles and try again.",
                    }]
                })
            certificates = payload["data"]["relationships"]["certificates"]["data"]
            if certificates != [{"type": "certificates", "id": DISTRIBUTION_CERTIFICATE_ID}]:
                raise SystemExit("profile was not tied to the shared certificate")
            return 201, json.dumps({
                "data": {
                    "type": "profiles",
                    "id": "PROF_NEW",
                    "attributes": {
                        "name": payload["data"]["attributes"]["name"],
                        "profileContent": base64.b64encode(profile_raw).decode(),
                    },
                }
            })
        raise SystemExit("unexpected API call " + method + " " + path)

    project_yml = """
name: LojoMail
targets:
  LojoMail:
    type: application
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.lojo.Mail
  LojoMailCore:
    type: framework
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.lojo.Mail.core
  LojoMailTests:
    type: bundle.unit-test
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.lojo.Mail.tests
"""
    real_api, real_jwt = globals()["api"], globals()["jwt_from_env"]
    globals()["api"] = fake_api
    globals()["jwt_from_env"] = lambda: "token"
    try:
        with tempfile.TemporaryDirectory() as directory:
            certs = Path(directory) / "certs.pem"
            certs.write_bytes(pem)
            manifest = Path(directory) / "signing-manifest.json"
            profiles = Path(directory) / "profiles"
            project = Path(directory) / "project.pbxproj"
            project.write_text(sample_pbxproj())
            export = Path(directory) / "ExportOptions.plist"
            yml = Path(directory) / "project.yml"
            yml.write_text(project_yml)
            argv = {
                "installed_certs": str(certs),
                "manifest": str(manifest),
                "profiles_dir": str(profiles),
                "team": "EXAMPLETEAM",
                "keychain": "/tmp/signing.keychain-db",
                "identity": "Apple Distribution",
                "pbxproj": str(project),
                "export_plist": str(export),
                "project_yml": str(yml),
            }
            prepare(argv)
            if any(method == "POST" and "/v1/certificates" in path for method, path, _payload in calls):
                raise SystemExit("prepare created a certificate")
            if any(method == "DELETE" and "/v1/certificates" in path for method, path, _payload in calls):
                raise SystemExit("prepare revoked a certificate")
            posts = [call for call in calls if call[0] == "POST"]
            if posts != [("POST", "/v1/profiles", posts[0][2])]:
                raise SystemExit("prepare did not create exactly one profile")
            patched = project.read_text()
            if patched.count("CODE_SIGN_STYLE = Manual;") != 3:
                raise SystemExit("prepare left an archive target on automatic signing")
            if "com.lojo.Mail.tests" not in patched or patched.count("CODE_SIGN_STYLE = Automatic;") != 2:
                raise SystemExit("prepare changed a test bundle")
            if not (profiles / "UUID-APP.mobileprovision").is_file():
                raise SystemExit("prepare did not install the profile")
            with export.open("rb") as handle:
                options = plistlib.load(handle)
            if options["provisioningProfiles"] != {"com.lojo.Mail": "LOJO Mail App Store"}:
                raise SystemExit("prepare export options did not match the app profile")

            calls.clear()
            mode["profiles"] = [{
                "id": "PROF_EXISTING",
                "attributes": {
                    "name": "LOJO Mail App Store",
                    "profileType": PROFILE_TYPE,
                    "profileState": "ACTIVE",
                    "expirationDate": "2030-01-01T00:00:00.000+00:00",
                },
                "relationships": {
                    "bundleId": {"data": {"type": "bundleIds", "id": "BIDAPP"}},
                    "certificates": {
                        "data": [{"type": "certificates", "id": DISTRIBUTION_CERTIFICATE_ID}]
                    },
                },
            }]
            project.write_text(sample_pbxproj())
            prepare(argv)
            if any(method == "POST" for method, _path, _payload in calls):
                raise SystemExit("prepare created a profile that already exists")

            calls.clear()
            mode["profiles"] = [{
                "id": "PROF_STALE",
                "attributes": {
                    "name": "LOJO Mail App Store",
                    "profileType": PROFILE_TYPE,
                    "profileState": "ACTIVE",
                    "expirationDate": "2030-01-01T00:00:00.000+00:00",
                },
                "relationships": {
                    "bundleId": {"data": {"type": "bundleIds", "id": "BIDAPP"}},
                    "certificates": {"data": [{"type": "certificates", "id": "OLD"}]},
                },
            }]
            project.write_text(sample_pbxproj())
            prepare(argv)
            methods = [(method, path) for method, path, _payload in calls]
            if ("DELETE", "/v1/profiles/PROF_STALE") not in methods:
                raise SystemExit("prepare kept a profile that is not tied to the shared certificate")
            if not any(method == "POST" and path == "/v1/profiles" for method, path, _payload in calls):
                raise SystemExit("prepare did not replace the stale profile")
            if any("/v1/certificates" in path and method in ("POST", "DELETE") for method, path, _payload in calls):
                raise SystemExit("replacing a profile touched a certificate")

            calls.clear()
            mode["profiles"] = [
                {"id": "PROF_DUP_A", "attributes": {"name": "LOJO Mail App Store", "profileType": PROFILE_TYPE, "profileState": "ACTIVE"}},
                {"id": "PROF_DUP_B", "attributes": {"name": "LOJO Mail App Store", "profileType": PROFILE_TYPE, "profileState": "ACTIVE"}},
            ]
            project.write_text(sample_pbxproj())
            prepare(argv)
            methods = [(method, path) for method, path, _payload in calls]
            if ("DELETE", "/v1/profiles/PROF_DUP_A") not in methods or ("DELETE", "/v1/profiles/PROF_DUP_B") not in methods:
                raise SystemExit("prepare left duplicate profiles that share the App Store name")
            if not any(method == "POST" and path == "/v1/profiles" for method, path, _payload in calls):
                raise SystemExit("prepare did not create a profile after removing duplicates")

            calls.clear()
            mode["profiles"] = []
            mode["named"] = [
                {"id": "PROF_HIDDEN_A", "attributes": {"name": "LOJO Mail App Store"}},
                {"id": "PROF_HIDDEN_B", "attributes": {"name": "LOJO Mail App Store"}},
            ]
            mode["conflict_posts"] = 1
            project.write_text(sample_pbxproj())
            prepare(argv)
            methods = [(method, path) for method, path, _payload in calls]
            if ("DELETE", "/v1/profiles/PROF_HIDDEN_A") not in methods or ("DELETE", "/v1/profiles/PROF_HIDDEN_B") not in methods:
                raise SystemExit("prepare did not remove duplicate profiles that the typed list missed")
            if not any(method == "POST" and path == "/v1/profiles" for method, path, _payload in calls):
                raise SystemExit("prepare did not create a profile after the duplicate-name refusal")
            mode["named"] = None
            mode["conflict_posts"] = 0

            calls.clear()
            certs.write_bytes(other_pem)
            try:
                prepare(argv)
            except SystemExit as error:
                if DISTRIBUTION_CERTIFICATE_ID not in str(error):
                    raise
            else:
                raise SystemExit("prepare accepted a different certificate")
            if any(method == "POST" for method, _path, _payload in calls):
                raise SystemExit("a certificate mismatch still created a profile")
    finally:
        globals()["api"], globals()["jwt_from_env"] = real_api, real_jwt


def cleanup_roundtrip():
    def fake_api(*_args, **_kwargs):
        raise SystemExit("cleanup called the App Store Connect API")

    real_api = globals()["api"]
    globals()["api"] = fake_api
    previous = os.environ.get("SIGNING_MANIFEST")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "p.mobileprovision"
            profile.write_bytes(b"x")
            manifest = Path(tmp) / "m.json"
            write_manifest(manifest, [{
                "id": "P",
                "name": "n",
                "bundleId": "b",
                "path": str(profile),
            }])
            os.environ["SIGNING_MANIFEST"] = str(manifest)
            cleanup()
            if profile.exists():
                raise SystemExit("cleanup left the profile file behind")
    finally:
        globals()["api"] = real_api
        if previous is None:
            os.environ.pop("SIGNING_MANIFEST", None)
        else:
            os.environ["SIGNING_MANIFEST"] = previous


def api_retry_roundtrip():
    class Response:
        status = 200

        def read(self):
            return b'{"data":[]}'

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    class Flaky:
        def __init__(self):
            self.calls = 0

        def open(self, _request, timeout=60):
            self.calls += 1
            if self.calls == 1:
                raise TimeoutError("timed out")
            return Response()

    flaky = Flaky()
    real_opener = urllib.request.build_opener
    real_sleep = time.sleep
    urllib.request.build_opener = lambda *_args, **_kwargs: flaky
    time.sleep = lambda _seconds: None
    try:
        status, body = api("token", "GET", "/v1/apps")
        if status != 200 or body != '{"data":[]}' or flaky.calls != 2:
            raise SystemExit("GET did not retry a timeout")
        posts = Flaky()

        def post_opener(*_args, **_kwargs):
            return posts

        urllib.request.build_opener = post_opener
        try:
            api("token", "POST", "/v1/profiles", {"data": {}})
        except SystemExit as error:
            if "certificate" not in str(error):
                raise
        else:
            raise SystemExit("POST timeout was retried or accepted")
        if posts.calls != 1:
            raise SystemExit("POST timeout was retried")
    finally:
        urllib.request.build_opener = real_opener
        time.sleep = real_sleep


def no_mint_roundtrip():
    source = Path(__file__).read_text().split("def no_mint_roundtrip", 1)[0]
    phrases = (
        "csr" + "Content",
        "gen" + "rsa",
        "fast" + "lane",
        "revoke_own_" + "certificate",
        "allowProvisioning" + "Updates",
    )
    for phrase in phrases:
        if phrase in source:
            raise SystemExit("certificate minting is still present: " + phrase)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        self_test()
        return
    if len(sys.argv) > 1 and sys.argv[1] == "cleanup":
        cleanup()
        return
    if len(sys.argv) > 1 and sys.argv[1] == "decode-p12":
        decode_p12()
        return
    if len(sys.argv) > 1 and sys.argv[1] == "prepare":
        required = (
            "installed_certs",
            "manifest",
            "profiles_dir",
            "team",
            "keychain",
            "identity",
            "pbxproj",
            "export_plist",
            "project_yml",
        )
        values = {}
        args = sys.argv[2:]
        index = 0
        while index < len(args):
            name = args[index][2:].replace("-", "_")
            if index + 1 >= len(args):
                raise SystemExit("Missing a signing argument.")
            values[name] = args[index + 1]
            index += 2
        missing = [name for name in required if name not in values]
        if missing:
            raise SystemExit("Missing signing arguments.")
        prepare(values)
        return
    raise SystemExit("Usage: asc_signing.py --self-test | decode-p12 | prepare | cleanup")


if __name__ == "__main__":
    main()
