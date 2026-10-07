# Sourced by the phone scripts. Chooses which USB iPhone to talk to and exports it for xtool and pymobiledevice3.
#   LOJO_UDID=...           exact device (never commit it)
#   LOJO_PHONE="14 Pro Max" match on the model name ("11", "14 Pro Max", ...)
#   neither                 the only attached iPhone; with several attached, refuse and list the models
# The UDID is a device identifier: it is only held in the environment of the running script, never printed.

lojo_pick_phone() {
  if [[ -n "${LOJO_UDID:-}" ]]; then
    export PYMOBILEDEVICE3_UDID="$LOJO_UDID"
    return 0
  fi
  local picked
  picked="$(LOJO_PHONE="${LOJO_PHONE:-}" pymobiledevice3 usbmux list --usb 2>/dev/null | python3 -c '
import json, os, sys
models = {"iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max",
          "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus", "iPhone15,2": "iPhone 14 Pro",
          "iPhone15,3": "iPhone 14 Pro Max"}
want = os.environ.get("LOJO_PHONE", "").strip().lower()
devices = [(d["Identifier"], models.get(d.get("ProductType", ""), d.get("ProductType", "iPhone")), d.get("ProductVersion", "?"))
           for d in json.load(sys.stdin)]
match = [d for d in devices if want and (want == d[1].lower() or d[1].lower().endswith(" " + want))] if want else devices
if len(match) == 1:
    print(match[0][0]); print(f"{match[0][1]} (iOS {match[0][2]})", file=sys.stderr); sys.exit(0)
if not devices:
    print("No iPhone on USB. Plug it in, unlock it and tap Trust.", file=sys.stderr)
else:
    print(("No attached iPhone matches LOJO_PHONE=%r." % want) if want else "Several iPhones are attached; choose one with LOJO_PHONE.", file=sys.stderr)
    for _, model, version in devices:
        short = model.removeprefix("iPhone ")
        print(f"  LOJO_PHONE=\"{short}\"   {model}, iOS {version}", file=sys.stderr)
sys.exit(1)
')" || return 1
  export LOJO_UDID="$picked"
  export PYMOBILEDEVICE3_UDID="$picked"
}

# Installed LOJO Mail bundle (XTL-*.com.lojo.Mail). LOJO_BUNDLE overrides. Never hardcodes a team id.
# Reads `pymobiledevice3 apps list`.
lojo_mail_bundle() {
  if [[ -n "${LOJO_BUNDLE:-}" ]]; then
    printf '%s\n' "$LOJO_BUNDLE"
    return 0
  fi
  local ios
  ios="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  pymobiledevice3 apps list | python3 "$ios/mail-bundle.py"
}

# iOS 17+ `core-device launch-application` needs a tunnel (sudo tunneld). Missing that must not
# fail provisioning: the files are already in the app container.
lojo_launch_best_effort() {
  local bundle="$1"
  if pymobiledevice3 developer core-device launch-application --userspace --kill-existing "$bundle" '' >/dev/null 2>&1; then
    return 0
  fi
  echo "warning: open LOJO Mail on the phone to finish import" >&2
  return 0
}
