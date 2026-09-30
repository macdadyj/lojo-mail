import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateIdentity, messageBodyContext, openJson, sealJson } from "@lojo/core";
import { unwrapPrivateKey } from "@lojo/core/wrap";
import { exportWrapped, importWrapped, verifyWrapped, type KeyToolIo } from "./keytool.ts";

class FakeIo implements KeyToolIo {
  readonly files = new Map<string, string>();
  readonly printed: string[] = [];
  secret = "";

  print(text: string): void {
    this.printed.push(text);
  }

  readSecret(): Promise<string> {
    return Promise.resolve(this.secret);
  }

  readText(path: string): string {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`${path} does not exist`);
    return text;
  }

  writePrivate(path: string, contents: string, force: boolean): void {
    if (this.files.has(path) && !force) throw new Error(`${path} already exists; use --force to replace it`);
    this.files.set(path, contents);
  }
}

describe("lojo-bridge key", () => {
  it("export-wrapped shows the passphrase once, writes only the blob, and the blob opens mail", async () => {
    const identity = await generateIdentity();
    const io = new FakeIo();
    const result = await exportWrapped(identity.privateJwk, { out: "/backup/lojo-key.txt" }, io);
    assert.equal(io.files.get("/backup/lojo-key.txt"), `${result.blob}\n`);
    assert.ok(![...io.files.values()].some((contents) => contents.includes(result.passphrase)), "the passphrase is never written");
    const shown = io.printed.join("\n");
    assert.equal(shown.split(result.passphrase).length - 1, 1, "shown exactly once");
    assert.ok(shown.includes(result.fingerprint));
    assert.ok(!shown.includes(identity.privateJwk.d));

    const sealed = await sealJson({ text: "hi" }, identity.publicJwk, messageBodyContext("m"));
    const unwrapped = await unwrapPrivateKey(result.blob, result.passphrase);
    assert.deepEqual(await openJson(sealed, unwrapped.privateKey, messageBodyContext("m")), { text: "hi" });

    await assert.rejects(() => exportWrapped(identity.privateJwk, { out: "/backup/lojo-key.txt" }, io), /already exists/);
    const second = await exportWrapped(identity.privateJwk, { out: "/backup/lojo-key.txt", force: true }, io);
    assert.notEqual(second.passphrase, result.passphrase, "every export gets a new passphrase");
  });

  it("verify-wrapped and import-wrapped recover the same key, and catch the wrong key or passphrase", async () => {
    const identity = await generateIdentity();
    const other = await generateIdentity();
    const io = new FakeIo();
    const { passphrase, fingerprint } = await exportWrapped(identity.privateJwk, { out: "/b" }, io);
    io.secret = passphrase;
    assert.equal(await verifyWrapped({ in: "/b", expected: identity.privateJwk }, io), fingerprint);
    await assert.rejects(() => verifyWrapped({ in: "/b", expected: other.privateJwk }, io), /different key/);
    await importWrapped({ in: "/b", out: "/new/envelope.private.jwk" }, io);
    assert.deepEqual(JSON.parse(io.files.get("/new/envelope.private.jwk") ?? ""), { kty: "EC", crv: "P-256", x: identity.privateJwk.x, y: identity.privateJwk.y, d: identity.privateJwk.d });
    io.secret = "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA";
    await assert.rejects(() => importWrapped({ in: "/b", out: "/other.jwk" }, io), /Wrong key passphrase/);
    assert.equal(io.files.has("/other.jwk"), false);
  });
});
