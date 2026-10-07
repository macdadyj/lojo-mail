#!/usr/bin/env python3
"""Choose the installed LOJO Mail bundle id from `pymobiledevice3 apps list` JSON on stdin.

Matches any XTL-*.com.lojo.Mail id. This file does not contain a team id.
"""

import json
import re
import sys


def bundle_ids(data):
    found = []
    if isinstance(data, dict):
        found.extend(str(key) for key in data)
        for value in data.values():
            if isinstance(value, dict):
                bid = value.get("CFBundleIdentifier")
                if isinstance(bid, str):
                    found.append(bid)
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, str):
                found.append(item)
            elif isinstance(item, dict):
                bid = item.get("CFBundleIdentifier") or item.get("bundleIdentifier")
                if isinstance(bid, str):
                    found.append(bid)
    return found


def main():
    raw = sys.stdin.read()
    starts = [index for index in (raw.find("{"), raw.find("[")) if index >= 0]
    if not starts:
        print("pymobiledevice3 apps list did not return JSON.", file=sys.stderr)
        return 1
    try:
        data = json.loads(raw[min(starts) :])
    except json.JSONDecodeError as exc:
        print(f"pymobiledevice3 apps list was not JSON ({exc}).", file=sys.stderr)
        return 1
    pattern = re.compile(r"^XTL-.+\.com\.lojo\.Mail$")
    matches = []
    for bid in bundle_ids(data):
        if pattern.match(bid) and bid not in matches:
            matches.append(bid)
    if len(matches) == 1:
        print(matches[0])
        return 0
    if not matches:
        print(
            "No installed app matches XTL-*.com.lojo.Mail. Install LOJO Mail, or set LOJO_BUNDLE.",
            file=sys.stderr,
        )
    else:
        print("Several LOJO Mail apps are installed. Set LOJO_BUNDLE to the one you want.", file=sys.stderr)
        for bid in matches:
            print(f"  {bid}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
