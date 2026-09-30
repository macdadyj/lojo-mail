import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { LoginGuard, hashPassword, verifyPassword } from "./auth.ts";
import { ScopeError } from "./bridge.ts";
import { ConfigError, bridgePaths, loadConfig, loadToken, parseConfig, saveConfig, type BridgeConfig } from "./config.ts";
import { harness } from "./testkit.ts";

const dir = mkdtempSync(join(tmpdir(), "lojo-bridge-config-"));
chmodSync(dir, 0o700);
const token = "t".repeat(40);

const base = {
  apiUrl: "https://mail-api.example.com",
  address: "lojo@cyberphysical.us",
  tokenFile: join(dir, "token"),
  privateKeyFile: join(dir, "key.jwk"),
  appPasswordHash: "scrypt$32768$8$1$c2FsdA$aGFzaA",
};

after(() => rmSync(dir, { recursive: true, force: true }));

describe("config", () => {
  it("binds loopback only", () => {
    assert.equal(parseConfig(base).host, "127.0.0.1");
    for (const host of ["0.0.0.0", "::", "::1", "192.168.1.5", "localhost"]) {
      assert.throws(() => parseConfig({ ...base, host }), ConfigError, host);
    }
  });

  it("requires https for a remote API", () => {
    assert.throws(() => parseConfig({ ...base, apiUrl: "http://mail-api.example.com" }), ConfigError);
    assert.equal(parseConfig({ ...base, apiUrl: "http://localhost:8787/" }).apiUrl, "http://localhost:8787");
  });

  it("needs exactly one source per secret", () => {
    assert.throws(() => parseConfig({ ...base, tokenCommand: ["pass", "show", "x"] }), ConfigError);
    assert.throws(() => parseConfig({ ...base, tokenFile: undefined }), ConfigError);
    assert.throws(() => parseConfig({ ...base, tokenFile: undefined, tokenCommand: "pass show x" }), ConfigError);
  });

  it("refuses group- or world-readable secret files", async () => {
    const path = join(dir, "token");
    writeFileSync(path, `${token}\n`, { mode: 0o644 });
    chmodSync(path, 0o644);
    await assert.rejects(() => loadToken(parseConfig(base)), /group or others/);
    chmodSync(path, 0o640);
    await assert.rejects(() => loadToken(parseConfig(base)), /group or others/);
    chmodSync(path, 0o600);
    assert.equal(await loadToken(parseConfig(base)), token);
  });

  it("runs a token command without a shell", async () => {
    const config = parseConfig({ ...base, tokenFile: undefined, tokenCommand: [process.execPath, "-e", `console.log("${token}"); console.log("second line")`] });
    assert.equal(await loadToken(config), token);
    const shellish = parseConfig({ ...base, tokenFile: undefined, tokenCommand: ["echo $HOME && true"] });
    await assert.rejects(() => loadToken(shellish), ConfigError);
  });

  it("refuses a config in a directory others can read", () => {
    const configDir = join(dir, "open");
    const path = join(configDir, "bridge.json");
    saveConfig(path, parseConfig(base) as BridgeConfig);
    assert.equal(loadConfig(path).address, "lojo@cyberphysical.us");
    chmodSync(configDir, 0o755);
    assert.throws(() => loadConfig(path), /group or others/);
    chmodSync(configDir, 0o700);
    chmodSync(path, 0o604);
    assert.throws(() => loadConfig(path), /group or others/);
  });

  it("honours XDG directories", () => {
    const paths = bridgePaths({ HOME: "/home/jon", XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/st" });
    assert.equal(paths.configFile, "/cfg/lojo-mail/bridge.json");
    assert.equal(paths.stateFile, "/st/lojo-mail/bridge-state.json");
    assert.equal(bridgePaths({ HOME: "/home/jon" }).stateFile, "/home/jon/.local/state/lojo-mail/bridge-state.json");
  });
});

describe("app password", () => {
  it("stores only a salted scrypt hash", async () => {
    const hash = await hashPassword("correct");
    assert.doesNotMatch(hash, /correct/);
    assert.notEqual(hash, await hashPassword("correct"));
    assert.equal(await verifyPassword("correct", hash), true);
    assert.equal(await verifyPassword("wrong", hash), false);
  });

  it("locks out after repeated failures", async () => {
    let now = 0;
    const guard = new LoginGuard("lojo@cyberphysical.us", await hashPassword("right"), { maxFailures: 3, lockMs: 1000, baseDelayMs: 1, maxDelayMs: 2, now: () => now });
    assert.equal(await guard.attempt("LOJO@cyberphysical.us", "right"), "ok");
    assert.equal(await guard.attempt("someone@else", "right"), "bad");
    for (let i = 0; i < 2; i += 1) assert.equal(await guard.attempt("lojo@cyberphysical.us", "wrong"), "bad");
    assert.equal(await guard.attempt("lojo@cyberphysical.us", "right"), "locked");
    now = 1001;
    assert.equal(await guard.attempt("lojo@cyberphysical.us", "right"), "ok");
  });
});

describe("token scopes", () => {
  for (const [token, pattern] of [
    ["send-token", /send/],
    ["admin-token", /admin/],
    ["read-token", /missing/],
  ] as const) {
    it(`refuses ${token}`, async () => {
      await assert.rejects(() => harness({ token }), (error: unknown) => error instanceof ScopeError && pattern.test(error.message));
    });
  }
});
