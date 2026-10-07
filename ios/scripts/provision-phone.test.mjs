import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = new URL("../..", import.meta.url).pathname;

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function fakePymobiledevice(listJson, launchCode = 1) {
  const dir = mkdtempSync(join(tmpdir(), "lojo-pmd3-"));
  const script = `#!/usr/bin/env python3
import sys
args = sys.argv[1:]
if args[:2] == ["apps", "list"]:
    sys.stdout.write(${JSON.stringify(listJson)})
    sys.exit(0)
if "launch-application" in args:
    sys.exit(${launchCode})
sys.stderr.write("unexpected " + " ".join(args) + "\\n")
sys.exit(2)
`;
  const path = join(dir, "pymobiledevice3");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

function bash(command, extraEnv = {}) {
  return spawnSync("bash", ["-c", command], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LOJO_BUNDLE: "", ...extraEnv },
  });
}

test("unlock screen options are buttons, not plain text", () => {
  const view = read("ios/App/Sources/LojoMail/Views/SignInView.swift");
  assert.match(view, /ForEach\(UnlockScreen\.loadButtons\)/);
  assert.match(view, /UnlockScreen\.saveButton/);
  assert.match(view, /UnlockScreen\.retry/);
  assert.match(view, /importProvisionedUSB\(\)/);
  assert.match(view, /importSharedKey\(action:/);
  assert.doesNotMatch(view, /func step\(/);
  const unlock = read("ios/App/Sources/LojoMailCore/Unlock.swift");
  assert.match(unlock, /USB from Santa Computa/);
  assert.match(unlock, /case \.envelopeKey:\s*\n\s*return \.afterFirstUnlock/);
});

test("test mode is not registered on, and session expiry keeps the key", () => {
  const model = read("ios/App/Sources/LojoMail/Model/AppModel.swift");
  assert.doesNotMatch(model, /"sendTestMode": true/);
  assert.match(model, /TestModePolicy\.isOn/);
  assert.match(model, /let kept = key/);
  assert.match(model, /key = kept/);
  const settings = read("ios/App/Sources/LojoMail/Views/SettingsView.swift");
  const compose = read("ios/App/Sources/LojoMail/Views/ComposeView.swift");
  const mailbox = read("ios/App/Sources/LojoMail/Views/MailboxView.swift");
  assert.match(settings, /Turn off test mode/);
  assert.match(compose, /Turn off test mode/);
  assert.match(mailbox, /Tap to turn it off/);
});

test("phone scripts do not hardcode a team bundle id", () => {
  const files = [
    "ios/scripts/provision-phone.sh",
    "ios/scripts/deploy-phone.sh",
    "ios/scripts/phone-shot.sh",
    "ios/scripts/phone-lib.sh",
    "ios/README.md",
  ];
  for (const file of files) {
    assert.doesNotMatch(read(file), /XTL-[A-Z0-9]{6,}\.com\.lojo\.Mail/, file);
  }
  for (const file of ["ios/scripts/provision-phone.sh", "ios/scripts/phone-lib.sh", "ios/scripts/deploy-phone.sh"]) {
    const syntax = spawnSync("bash", ["-n", join(root, file)], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("bundle detection uses pymobiledevice3 apps list", () => {
  const bin = fakePymobiledevice(
    JSON.stringify({
      "com.apple.MobileSMS": { CFBundleIdentifier: "com.apple.MobileSMS" },
      "com.lojo.Mail": { CFBundleIdentifier: "com.lojo.Mail" },
      "XTL-EXAMPLE.com.lojo.Mail": { CFBundleIdentifier: "XTL-EXAMPLE.com.lojo.Mail" },
    }),
  );
  const found = bash("source ios/scripts/phone-lib.sh && lojo_mail_bundle", { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.trim(), "XTL-EXAMPLE.com.lojo.Mail");

  const none = bash("source ios/scripts/phone-lib.sh && lojo_mail_bundle", {
    PATH: `${fakePymobiledevice(JSON.stringify({ "com.apple.MobileSMS": {} }))}:${process.env.PATH}`,
  });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /XTL-\*\.com\.lojo\.Mail/);

  const many = bash("source ios/scripts/phone-lib.sh && lojo_mail_bundle", {
    PATH: `${fakePymobiledevice(
      JSON.stringify({
        "XTL-ONE.com.lojo.Mail": {},
        "XTL-TWO.com.lojo.Mail": {},
      }),
    )}:${process.env.PATH}`,
  });
  assert.notEqual(many.status, 0);
  assert.match(many.stderr, /Several LOJO Mail apps/);

  const override = bash("source ios/scripts/phone-lib.sh && lojo_mail_bundle", {
    PATH: "/usr/bin:/bin",
    LOJO_BUNDLE: "XTL-EXAMPLE.com.lojo.Mail",
  });
  assert.equal(override.status, 0, override.stderr);
  assert.equal(override.stdout.trim(), "XTL-EXAMPLE.com.lojo.Mail");
});

test("launch without tunneld warns instead of failing", () => {
  const bin = fakePymobiledevice("{}", 1);
  const launched = bash(
    "source ios/scripts/phone-lib.sh && lojo_launch_best_effort XTL-EXAMPLE.com.lojo.Mail",
    { PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stderr, /open LOJO Mail on the phone to finish import/);
});
