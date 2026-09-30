// Seals test envelopes with the same code the processor uses, into a directory outside the repo.
//   npx tsx ios/CoreTests/make-vectors.ts /tmp/lojo-mail-vectors
// The key pair is generated fresh on every run and never written inside the repo.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentContext, generateIdentity, keyFingerprint, messageBodyContext, sealBytes, sealJson } from "../../packages/core/src/crypto/envelope.ts";

const out = process.argv[2];
if (!out || out.startsWith(process.cwd())) {
  console.error("usage: make-vectors.ts <dir outside the repo>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const { publicJwk, privateJwk } = await generateIdentity();
const other = await generateIdentity();
const body = {
  text: "Hello Jon,\n\nThe gate sensor is back online. ✅ Ünïcödé survives.\n",
  html: "<p>Hello Jon,</p>",
  ai: { summary: "Gate sensor back online.", threadSummary: "", actionItems: [{ text: "Check the gate", deadline: null }], draftReply: "Thanks!", phishingReasons: [] },
};
const attachment = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);

writeFileSync(join(out, "key.jwk"), JSON.stringify(privateJwk));
writeFileSync(join(out, "other-key.jwk"), JSON.stringify(other.privateJwk));
writeFileSync(join(out, "key-fingerprint.txt"), await keyFingerprint(publicJwk));
writeFileSync(join(out, "body.json"), JSON.stringify({ id: "msg_test1", envelope: await sealJson(body, publicJwk, messageBodyContext("msg_test1")) }));
writeFileSync(join(out, "body-expected.json"), JSON.stringify(body));
writeFileSync(join(out, "attachment.bin.json"), JSON.stringify(await sealBytes(attachment, publicJwk, attachmentContext("msg_test1", "att1"))));
writeFileSync(join(out, "attachment-expected.bin"), attachment);
console.log(out);
