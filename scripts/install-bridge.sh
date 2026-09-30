#!/usr/bin/env bash
# Installs the lojo-mail Thunderbird bridge for the current user as a
# systemd --user service. Safe to re-run: it rebuilds, reinstalls the bundle
# and unit, and restarts the service, keeping an existing bridge.json.
#
#   scripts/install-bridge.sh [--api-url URL] [--address ADDRESS] [--web-url URL]
#                             [--token-file PATH | --token-command JSON_ARGV]
#                             [--private-key-file PATH | --private-key-command JSON_ARGV]
#                             [--no-trash] [--no-start]
#
# The same values can come from LOJO_BRIDGE_API_URL, LOJO_BRIDGE_ADDRESS,
# LOJO_BRIDGE_WEB_URL, LOJO_BRIDGE_TOKEN_FILE, LOJO_BRIDGE_PRIVATE_KEY_FILE.
# Anything still missing is prompted for when a config has to be created.
set -euo pipefail

die() {
  printf 'install-bridge: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

if [[ "$(id -u)" -eq 0 ]]; then
  die "refusing to run as root; the bridge is a per-user service"
fi

api_url="${LOJO_BRIDGE_API_URL:-}"
address="${LOJO_BRIDGE_ADDRESS:-}"
web_url="${LOJO_BRIDGE_WEB_URL:-}"
token_file="${LOJO_BRIDGE_TOKEN_FILE:-}"
token_command=""
key_file="${LOJO_BRIDGE_PRIVATE_KEY_FILE:-}"
key_command=""
no_trash=0
start=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) api_url="${2:?--api-url needs a value}"; shift 2 ;;
    --address) address="${2:?--address needs a value}"; shift 2 ;;
    --web-url) web_url="${2:?--web-url needs a value}"; shift 2 ;;
    --token-file) token_file="${2:?--token-file needs a value}"; shift 2 ;;
    --token-command) token_command="${2:?--token-command needs a value}"; shift 2 ;;
    --private-key-file) key_file="${2:?--private-key-file needs a value}"; shift 2 ;;
    --private-key-command) key_command="${2:?--private-key-command needs a value}"; shift 2 ;;
    --no-trash) no_trash=1; shift ;;
    --no-start) start=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

command -v node >/dev/null 2>&1 || die "node is not installed (need Node.js 22 or newer)"
command -v npm >/dev/null 2>&1 || die "npm is not installed"
node_bin="$(command -v node)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${node_major}" -lt 22 ]]; then
  die "Node.js ${node_major} found; the bridge needs 22 or newer"
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/lojo-mail"
state_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/lojo-mail"
data_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/lojo-mail"
unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
bin_dir="${HOME}/.local/bin"
config_file="${config_dir}/bridge.json"

for path in "${config_dir}" "${state_dir}" "${data_dir}" "${node_bin}"; do
  [[ "${path}" =~ [[:space:]] ]] && die "paths with whitespace are not supported: ${path}"
done

umask 077

inside_repo() {
  local target
  target="$(realpath -m "$1")"
  [[ "${target}" == "${repo_dir}" || "${target}" == "${repo_dir}/"* ]]
}

cd "${repo_dir}"
if [[ ! -d node_modules/smtp-server || ! -d node_modules/esbuild ]]; then
  echo "Installing dependencies (npm ci)..."
  npm ci
fi
echo "Building the bridge..."
npm run --silent build:bridge
[[ -f packages/bridge/dist/bridge.mjs ]] || die "build did not produce packages/bridge/dist/bridge.mjs"

install -d -m 700 "${config_dir}" "${state_dir}" "${data_dir}"
chmod 700 "${config_dir}" "${state_dir}" "${data_dir}"
install -m 600 packages/bridge/dist/bridge.mjs "${data_dir}/bridge.mjs"
install -m 600 docs/THUNDERBIRD.md "${data_dir}/THUNDERBIRD.md"

install -d -m 700 "${bin_dir}"
cat >"${bin_dir}/lojo-bridge" <<EOF
#!/usr/bin/env bash
exec "${node_bin}" "${data_dir}/bridge.mjs" "\$@"
EOF
chmod 700 "${bin_dir}/lojo-bridge"

ask() {
  local prompt="$1" default="${2:-}" reply
  if [[ ! -t 0 ]]; then
    [[ -n "${default}" ]] || die "${prompt} is required (pass it as a flag or environment variable)"
    printf '%s' "${default}"
    return
  fi
  if [[ -n "${default}" ]]; then
    read -r -p "${prompt} [${default}]: " reply
    printf '%s' "${reply:-${default}}"
  else
    read -r -p "${prompt}: " reply
    printf '%s' "${reply}"
  fi
}

if [[ -f "${config_file}" ]]; then
  echo "Keeping existing ${config_file}"
else
  [[ -n "${api_url}" ]] || api_url="$(ask "lojo-mail API URL (https://...)")"
  [[ -n "${address}" ]] || address="$(ask "Mailbox address" "lojo@cyberphysical.us")"
  if [[ -z "${token_file}" && -z "${token_command}" ]]; then
    token_file="$(ask "Bridge token file (mode 600)" "${config_dir}/bridge-token")"
  fi
  if [[ -z "${key_file}" && -z "${key_command}" ]]; then
    key_file="$(ask "Envelope private key file (mode 600)" "${config_dir}/envelope.private.jwk")"
  fi
  init_args=(init --api-url "${api_url}" --address "${address}")
  [[ -n "${web_url}" ]] && init_args+=(--web-url "${web_url}")
  [[ "${no_trash}" -eq 1 ]] && init_args+=(--no-trash)
  if [[ -n "${token_command}" ]]; then
    init_args+=(--token-command "${token_command}")
  else
    inside_repo "${token_file}" && die "keep the bridge token outside the repository (${token_file})"
    [[ -f "${token_file}" ]] || die "${token_file} does not exist; create it with mode 600 first"
    init_args+=(--token-file "$(realpath "${token_file}")")
  fi
  if [[ -n "${key_command}" ]]; then
    init_args+=(--private-key-command "${key_command}")
  else
    inside_repo "${key_file}" && die "keep the envelope private key outside the repository (${key_file})"
    [[ -f "${key_file}" ]] || die "${key_file} does not exist; copy envelope.private.jwk there with mode 600 first"
    init_args+=(--private-key-file "$(realpath "${key_file}")")
  fi
  "${node_bin}" "${data_dir}/bridge.mjs" "${init_args[@]}"
fi

install -d -m 700 "${unit_dir}"
unit="${unit_dir}/lojo-mail-bridge.service"
sed \
  -e "s#^ExecStart=/usr/bin/node %h/.local/share/lojo-mail/bridge.mjs serve#ExecStart=${node_bin} ${data_dir}/bridge.mjs serve#" \
  -e "s#^ReadWritePaths=%h/.local/state/lojo-mail#ReadWritePaths=${state_dir}#" \
  -e "s#^Documentation=.*#Documentation=file://${data_dir}/THUNDERBIRD.md#" \
  integrations/systemd/lojo-mail-bridge.service >"${unit}.tmp"
if [[ -n "${XDG_CONFIG_HOME:-}" || -n "${XDG_STATE_HOME:-}" ]]; then
  sed -i "s#^UMask=0077#UMask=0077\nEnvironment=XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-${HOME}/.config}\nEnvironment=XDG_STATE_HOME=${XDG_STATE_HOME:-${HOME}/.local/state}#" "${unit}.tmp"
fi
chmod 644 "${unit}.tmp"
mv "${unit}.tmp" "${unit}"
echo "Installed ${unit}"

if [[ "${start}" -eq 1 ]]; then
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found; start it by hand: lojo-bridge serve"
  systemctl --user daemon-reload
  systemctl --user enable lojo-mail-bridge.service
  systemctl --user restart lojo-mail-bridge.service
  sleep 1
  systemctl --user --no-pager --lines=5 status lojo-mail-bridge.service || true
fi

cat <<EOF

Done. Next:
  ${bin_dir}/lojo-bridge check
  Thunderbird: IMAP 127.0.0.1:1143 and SMTP 127.0.0.1:1587, connection security None,
  normal password, user name = your address, password = the app password printed at init.
  Guide: ${data_dir}/THUNDERBIRD.md
EOF
