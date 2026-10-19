#!/usr/bin/env bash
# Archive with manual distribution signing and upload to TestFlight.
# Imports the shared DIST_CERT_P12 certificate into a temporary keychain.
# Does not create or revoke certificates. Fetches or creates an App Store
# profile per archive bundle id, tied to the shared certificate.
# Does not print secret values. Deletes the API key, keychain, and local
# profile copies on exit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO="$(cd "${ROOT}/.." && pwd)"

# Local USB builds used CFBundleVersion 2, so the TestFlight build number is the
# run number plus this offset. A re-run of the same run appends .attempt so
# App Store Connect does not reject a repeated upload.
BUILD_NUMBER_OFFSET=10
compute_build_number() {
  local run_number="$1" attempt="${2:-1}" number
  if [[ ! "${run_number}" =~ ^[0-9]+$ ]]; then
    run_number=1
  fi
  number=$((run_number + BUILD_NUMBER_OFFSET))
  if [[ "${attempt}" != "1" ]]; then
    number="${number}.${attempt}"
  fi
  printf '%s' "${number}"
}

# Writes AuthKey_<id>.p8 from ASC_KEY_P8. Accepts base64 (whitespace ignored)
# or PKCS#8 PEM text. Error text never includes the secret.
write_api_key() {
  python3 - <<'PY'
import base64
import os
import sys
from pathlib import Path

PEM_BEGIN = "-----BEGIN " + "PRIVATE KEY-----"
raw = os.environ.get("ASC_KEY_P8", "")
text = raw.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff").strip()
destination = Path(os.environ["KEY_PATH"])
if text.startswith(PEM_BEGIN):
    if "PRIVATE KEY" not in text:
        sys.exit("ASC_KEY_P8 does not look like a private key.")
    if not text.endswith("\n"):
        text += "\n"
    destination.write_text(text)
    sys.exit(0)
compact = "".join(text.split())
if not compact:
    sys.exit("ASC_KEY_P8 is empty.")
pad = (-len(compact)) % 4
try:
    data = base64.b64decode(compact + ("=" * pad), validate=True)
except Exception:
    sys.exit("ASC_KEY_P8 is not valid base64 and is not a PEM private key.")
if b"PRIVATE KEY" not in data:
    sys.exit("ASC_KEY_P8 decoded, but it does not look like a .p8 private key.")
destination.write_bytes(data)
PY
}

check_encryption() {
  local plist
  for plist in App/Info.plist App/Info-xcode.plist; do
    if ! awk '
      $0 ~ /<key>ITSAppUsesNonExemptEncryption<\/key>/ { found=1; next }
      found { exit ($0 ~ /<false\/>/) ? 0 : 1 }
      END { if (!found) exit 1 }
    ' "${ROOT}/${plist}"; then
      echo "${plist} must set ITSAppUsesNonExemptEncryption to false." >&2
      exit 1
    fi
  done
}

show_redacted_error() {
  local file="$1"
  local label="$2"
  ERR_FILE="${file}" python3 - "${label}" <<'PY'
import os
import sys
from pathlib import Path

label = sys.argv[1]
text = Path(os.environ["ERR_FILE"]).read_text(errors="replace") if Path(os.environ["ERR_FILE"]).is_file() else ""
for name in ("DIST_CERT_PASSWORD", "DIST_CERT_P12", "ASC_KEY_P8"):
    secret = os.environ.get(name, "")
    if secret:
        text = text.replace(secret, "[redacted]")
sys.stderr.write(label + "\n")
text = text.strip()
if text:
    sys.stderr.write(text + "\n")
PY
}

refuse_provisioning_updates() {
  local arg
  for arg in "$@"; do
    case "${arg}" in
      *allowProvisioning*)
        echo "Refusing to let Xcode create or update certificates or profiles." >&2
        exit 1
        ;;
    esac
  done
}

add_keychain_to_search_list() {
  local -a chains=("${KEYCHAIN}")
  local line trimmed
  while IFS= read -r line; do
    trimmed="${line//\"/}"
    trimmed="${trimmed#"${trimmed%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    [[ -z "${trimmed}" || "${trimmed}" == "${KEYCHAIN}" ]] && continue
    chains+=("${trimmed}")
  done < <(security list-keychains -d user 2>/dev/null || true)
  security list-keychains -d user -s "${chains[@]}" >/dev/null
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT
  pem="-----BEGIN ""PRIVATE KEY-----"$'\nMIIB\n-----END PRIVATE KEY-----\n'
  b64="$(printf '%s' "${pem}" | base64 | fold -w 20)"
  run_case() {
    local label="$1"
    local value="$2"
    local out="${tmp}/${label}.p8"
    ASC_KEY_P8="${value}" KEY_PATH="${out}" write_api_key
    python3 - "${out}" "${label}" <<'PY'
import sys
from pathlib import Path
body = Path(sys.argv[1]).read_bytes()
if b"PRIVATE KEY" not in body or b"BEGIN" not in body:
    sys.exit("self-test failed for " + sys.argv[2])
print("asc key decode ok: " + sys.argv[2])
PY
  }
  run_case "pem" "${pem}"
  run_case "base64-wrapped" "${b64}"$'\n'
  run_case "base64-spaces" "$(printf '%s' "${pem}" | base64 | tr -d '\n' | sed 's/..../& /g')"
  if ASC_KEY_P8="not a key" KEY_PATH="${tmp}/bad.p8" write_api_key 2>"${tmp}/err"; then
    echo "self-test failed: invalid input was accepted" >&2
    exit 1
  fi
  if grep -q "not a key" "${tmp}/err"; then
    echo "self-test failed: error text included the secret" >&2
    exit 1
  fi
  echo "asc key decode rejected invalid input"
  check_encryption
  [[ "$(compute_build_number 1 1)" == "11" ]] || { echo "self-test failed: build number for run 1" >&2; exit 1; }
  [[ "$(compute_build_number 27 1)" == "37" ]] || { echo "self-test failed: build number for run 27" >&2; exit 1; }
  [[ "$(compute_build_number 5 3)" == "15.3" ]] || { echo "self-test failed: build number for a re-run" >&2; exit 1; }
  [[ "$(compute_build_number "" 1)" == "11" ]] || { echo "self-test failed: build number without a run" >&2; exit 1; }
  echo "build number ok: run 1 -> 11, run 5 attempt 3 -> 15.3"
  banned="-allowProvisioning"
  banned="${banned}Updates"
  if grep -R -n -- "${banned}" "${REPO}/.github/workflows" "${SCRIPT_DIR}" >/dev/null; then
    echo "self-test failed: Xcode must not update provisioning from the archive" >&2
    exit 1
  fi
  request_banner="BEGIN CERTIFICATE"
  request_banner="${request_banner} REQUEST"
  mint_re='gen'"rsa|csr"'Content|fast'"lane|${request_banner}"
  if grep -n -E "${mint_re}" \
    "${SCRIPT_DIR}/archive-upload.sh" "${SCRIPT_DIR}/asc_signing.py" >/dev/null; then
    echo "self-test failed: certificate creation is still present" >&2
    exit 1
  fi
  workflow="${REPO}/.github/workflows/ios.yml"
  grep -q 'DIST_CERT_P12' "${workflow}" || { echo "self-test failed: workflow does not pass DIST_CERT_P12" >&2; exit 1; }
  grep -q 'DIST_CERT_PASSWORD' "${workflow}" || { echo "self-test failed: workflow does not pass DIST_CERT_PASSWORD" >&2; exit 1; }
  grep -q 'if: always()' "${workflow}" || { echo "self-test failed: workflow is missing always() keychain cleanup" >&2; exit 1; }
  grep -q 'cleanup-signing-keychain.sh' "${workflow}" || { echo "self-test failed: workflow cleanup script is not wired" >&2; exit 1; }
  signing="${tmp}/lojo-signing"
  mkdir -p "${signing}"
  profile="${tmp}/example.mobileprovision"
  printf 'profile' > "${profile}"
  python3 - "${signing}/signing-manifest.json" "${profile}" <<'PY'
import json
import sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({"profiles": [{"path": sys.argv[2]}]}))
PY
  printf '%s\n' "${signing}/signing.keychain-db" > "${signing}/keychain-path"
  touch "${signing}/keychain-created"
  "${SCRIPT_DIR}/cleanup-signing-keychain.sh" "${signing}"
  if [[ -e "${signing}" || -e "${profile}" ]]; then
    echo "self-test failed: signing cleanup left files behind" >&2
    exit 1
  fi
  echo "signing cleanup ok"
  python3 "${SCRIPT_DIR}/asc_signing.py" --self-test
  python3 "${SCRIPT_DIR}/asc_testflight.py" --self-test
  exit 0
fi

missing=0
for name in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 DEVELOPMENT_TEAM DIST_CERT_P12 DIST_CERT_PASSWORD; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing GitHub secret ${name}." >&2
    missing=1
  fi
done
if [[ "${missing}" -ne 0 ]]; then
  echo "Add the App Store Connect API key and the shared distribution certificate before uploading. See ios/docs/TESTFLIGHT.md." >&2
  exit 1
fi

TEAM="${DEVELOPMENT_TEAM}"
BUILD_NUMBER="$(compute_build_number "${GITHUB_RUN_NUMBER:-1}" "${GITHUB_RUN_ATTEMPT:-1}")"
echo "Archive build number ${BUILD_NUMBER} for com.lojo.Mail."

SIGNING_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lojo-signing"
export SIGNING_DIR
"${SCRIPT_DIR}/cleanup-signing-keychain.sh" "${SIGNING_DIR}" || true
mkdir -p "${SIGNING_DIR}"
chmod 700 "${SIGNING_DIR}"
KEYCHAIN="${SIGNING_DIR}/signing.keychain-db"
printf '%s\n' "${KEYCHAIN}" > "${SIGNING_DIR}/keychain-path"
KEY_PATH="${SIGNING_DIR}/private_keys/AuthKey_${ASC_KEY_ID}.p8"
MANIFEST="${SIGNING_DIR}/signing-manifest.json"
cleanup() {
  local status=$?
  "${SCRIPT_DIR}/cleanup-signing-keychain.sh" "${SIGNING_DIR}" || \
    echo "Warning: could not fully remove the temporary signing keychain." >&2
  exit "${status}"
}
trap cleanup EXIT

mkdir -p "${SIGNING_DIR}/private_keys"
export KEY_PATH
umask 077
write_api_key

cd "${ROOT}"
if [[ ! -d LojoMail.xcodeproj ]]; then
  xcodegen generate
fi
check_encryption

P12_PATH="${SIGNING_DIR}/distribution.p12"
export P12_PATH
python3 "${SCRIPT_DIR}/asc_signing.py" decode-p12
printf '%s' "${DIST_CERT_PASSWORD}" > "${SIGNING_DIR}/p12.pass"
openssl rand -base64 32 | tr -d '\n' > "${SIGNING_DIR}/keychain.pass"
chmod 600 "${SIGNING_DIR}/p12.pass" "${SIGNING_DIR}/keychain.pass"

security create-keychain -p "$(cat "${SIGNING_DIR}/keychain.pass")" "${KEYCHAIN}"
touch "${SIGNING_DIR}/keychain-created"
security set-keychain-settings -lut 21600 "${KEYCHAIN}"
security unlock-keychain -p "$(cat "${SIGNING_DIR}/keychain.pass")" "${KEYCHAIN}"
add_keychain_to_search_list
if ! security import "${P12_PATH}" \
  -k "${KEYCHAIN}" \
  -P "$(cat "${SIGNING_DIR}/p12.pass")" \
  -f pkcs12 -A \
  -T /usr/bin/codesign \
  -T /usr/bin/security >/dev/null 2>"${SIGNING_DIR}/import.err"; then
  show_redacted_error "${SIGNING_DIR}/import.err" "Could not import the distribution certificate into the temporary keychain."
  exit 1
fi
if ! security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$(cat "${SIGNING_DIR}/keychain.pass")" \
  "${KEYCHAIN}" >/dev/null 2>"${SIGNING_DIR}/partition.err"; then
  show_redacted_error "${SIGNING_DIR}/partition.err" "Could not allow codesign to use the distribution key."
  exit 1
fi
add_keychain_to_search_list
security default-keychain -s "${KEYCHAIN}"

identity=""
if security find-identity -p codesigning "${KEYCHAIN}" 2>/dev/null | grep -q "Apple Distribution"; then
  identity="Apple Distribution"
elif security find-identity -p codesigning "${KEYCHAIN}" 2>/dev/null | grep -q "iPhone Distribution"; then
  identity="iPhone Distribution"
else
  echo "The distribution certificate did not import into the temporary keychain." >&2
  exit 1
fi
echo "Imported the shared distribution certificate."
security find-certificate -a -p "${KEYCHAIN}" > "${SIGNING_DIR}/installed-certs.pem"
chmod 600 "${SIGNING_DIR}/installed-certs.pem"
if ! grep -q "BEGIN CERTIFICATE" "${SIGNING_DIR}/installed-certs.pem"; then
  echo "The distribution certificate did not import into the temporary keychain." >&2
  exit 1
fi

python3 "${SCRIPT_DIR}/asc_signing.py" prepare \
  --installed-certs "${SIGNING_DIR}/installed-certs.pem" \
  --manifest "${MANIFEST}" \
  --profiles-dir "${HOME}/Library/MobileDevice/Provisioning Profiles" \
  --team "${TEAM}" \
  --keychain "${KEYCHAIN}" \
  --identity "${identity}" \
  --pbxproj "${ROOT}/LojoMail.xcodeproj/project.pbxproj" \
  --export-plist "${ROOT}/build/ExportOptions.plist" \
  --project-yml "${ROOT}/project.yml"

echo "Archiving with manual distribution signing."
archive_cmd=(
  xcodebuild archive
  -project LojoMail.xcodeproj
  -scheme LojoMail
  -destination "generic/platform=iOS"
  -archivePath "${ROOT}/build/LojoMail.xcarchive"
  -derivedDataPath "${ROOT}/build/ArchiveDerivedData"
  CODE_SIGN_STYLE=Manual
  CODE_SIGN_IDENTITY="${identity}"
  OTHER_CODE_SIGN_FLAGS="--keychain ${KEYCHAIN}"
  CURRENT_PROJECT_VERSION="${BUILD_NUMBER}"
)
export_cmd=(
  xcodebuild -exportArchive
  -archivePath "${ROOT}/build/LojoMail.xcarchive"
  -exportPath "${ROOT}/build/export"
  -exportOptionsPlist "${ROOT}/build/ExportOptions.plist"
  -authenticationKeyPath "${KEY_PATH}"
  -authenticationKeyID "${ASC_KEY_ID}"
  -authenticationKeyIssuerID "${ASC_ISSUER_ID}"
)
refuse_provisioning_updates "${archive_cmd[@]}" "${export_cmd[@]}"
"${archive_cmd[@]}"
"${export_cmd[@]}"
echo "Uploaded to App Store Connect."
echo "Releasing build ${BUILD_NUMBER} to the internal TestFlight group."
KEY_PATH="${KEY_PATH}" BUILD_NUMBER="${BUILD_NUMBER}" \
  python3 "${SCRIPT_DIR}/asc_testflight.py" release --wait-seconds 2400 --require-ready
