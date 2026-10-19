#!/usr/bin/env bash
# Remove the temporary signing keychain, the imported certificate, and local
# profile copies. Safe to run more than once. Does not talk to App Store
# Connect and does not print secrets.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
signing_dir="${1:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lojo-signing}"

if [[ -f "${signing_dir}/signing-manifest.json" ]]; then
  SIGNING_MANIFEST="${signing_dir}/signing-manifest.json" \
    python3 "${SCRIPT_DIR}/asc_signing.py" cleanup || true
fi

if [[ -f "${signing_dir}/keychain-created" ]] && command -v security >/dev/null 2>&1; then
  keychain="${signing_dir}/signing.keychain-db"
  if [[ -f "${signing_dir}/keychain-path" ]]; then
    keychain="$(<"${signing_dir}/keychain-path")"
  fi
  if [[ -n "${keychain}" ]]; then
    security delete-keychain "${keychain}" >/dev/null 2>&1 || true
  fi
  security list-keychains -d user -s login.keychain-db >/dev/null 2>&1 || true
  security default-keychain -s login.keychain-db >/dev/null 2>&1 || true
fi

rm -rf "${signing_dir}"
