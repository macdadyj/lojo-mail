import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TRUSTED_DOMAINS,
  domainTrusted,
  linksOpenDirectly,
  messageParts,
  parseTrustedDomainList,
  prepareLink,
  senderVerified,
  type LinkPart,
} from "./links.ts";

const apple = {
  from: { email: "testflight@email.apple.com" },
  verdicts: { dmarc: "pass", spam: "PASS", virus: "PASS" },
};

const invite = `
<html><body>
<p>You're invited to test Harbor.</p>
<p><a href="https://email.apple.com/click?link=https%3A%2F%2Ftestflight.apple.com%2Fjoin%2FAbCdEf12">View in TestFlight</a></p>
<p>The invite expires in 30 days.</p>
<img src="https://tracker.example/pixel.gif" alt="tracking pixel">
<script>alert("nope")</script>
</body></html>`;

test("a DMARC-passing sender on the trusted list opens links directly", () => {
  assert.equal(linksOpenDirectly(apple, DEFAULT_TRUSTED_DOMAINS), true);
  assert.equal(linksOpenDirectly({ ...apple, from: { email: "notifications@github.com" } }, DEFAULT_TRUSTED_DOMAINS), true);
  assert.equal(linksOpenDirectly({ ...apple, from: { email: "ci@mail.github.com" } }, DEFAULT_TRUSTED_DOMAINS), true);
});

test("DMARC failure, spam, or a domain off the list stays behind a confirm", () => {
  assert.equal(senderVerified({ ...apple, verdicts: { dmarc: "fail" } }), false);
  assert.equal(senderVerified({ ...apple, verdicts: { dmarc: "pass", spam: "FAIL" } }), false);
  assert.equal(senderVerified({ ...apple, labels: ["unverified-self"] }), false);
  assert.equal(linksOpenDirectly({ ...apple, from: { email: "ada@example.com" } }, DEFAULT_TRUSTED_DOMAINS), false);
  assert.equal(linksOpenDirectly(apple, []), false);
  assert.equal(domainTrusted("notgithub.com", ["github.com"]), false);
  assert.equal(domainTrusted("github.com.evil.com", ["github.com"]), false);
});

test("the Settings list accepts domain names and rejects everything else", () => {
  const parsed = parseTrustedDomainList(" Example.COM \n# note\nnews.example.com\n");
  assert.deepEqual(parsed, { ok: true, domains: ["example.com", "news.example.com"] });
  assert.equal(parseTrustedDomainList("https://apple.com").ok, false);
  assert.equal(parseTrustedDomainList("apple.com/path").ok, false);
  assert.equal(linksOpenDirectly({ ...apple, from: { email: "ada@news.example.com" } }, ["example.com"]), true);
});

test("an Apple invite keeps the button and unwraps the tracking hop", () => {
  const parts = messageParts({ html: invite });
  const link = parts.find((part): part is LinkPart => part.type === "link");
  assert.ok(link);
  assert.equal(link.text, "View in TestFlight");
  assert.equal(link.button, true);
  assert.equal(link.domain, "testflight.apple.com");
  assert.equal(link.href, "https://testflight.apple.com/join/AbCdEf12");
  const visible = parts.map((part) => part.text).join(" ");
  assert.match(visible, /You're invited to test Harbor/);
  assert.doesNotMatch(visible, /tracker\.example/);
  assert.doesNotMatch(visible, /alert/);
  assert.doesNotMatch(visible, /pixel\.gif/);
});

test("tracking redirects unwrap only when the next hop is inside the URL", () => {
  assert.equal(
    prepareLink("https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fgithub.com%2Forg%2Frepo&data=abc")?.href,
    "https://github.com/org/repo",
  );
  assert.equal(
    prepareLink("https://www.google.com/url?q=https%3A%2F%2Fgithub.com%2Forg&sa=D")?.domain,
    "github.com",
  );
  assert.equal(
    prepareLink("https://urldefense.proofpoint.com/v2/url?u=https-3A__example.com_path_file&d=Dw&e=")?.href,
    "https://example.com/path/file",
  );
  assert.equal(
    prepareLink("https://abc.r.us-east-1.awstrack.me/L0/https:%2F%2Fexample.com%2Fjoin/1/0100")?.href,
    "https://example.com/join",
  );
  assert.equal(prepareLink("https://bit.ly/not-unwrappable")?.domain, "bit.ly");
  assert.equal(prepareLink("https://email.apple.com/click/opaque-token")?.domain, "email.apple.com");
  assert.equal(prepareLink("https://t.co/abc")?.domain, "t.co");
});

test("unsafe targets are not links, and remote images are not addresses", () => {
  const html = [
    '<a href="javascript:alert(1)">click</a>',
    '<a href="https://user:pass@example.com/secret">creds</a>',
    '<a href="https://169.254.169.254/latest">meta</a>',
    '<a href="http://127.0.0.1/admin">local</a>',
    '<img src="https://images.example/a.png">',
    '<a href="https://example.com/ok"><img src="https://images.example/button.png" alt="Open notes"></a>',
  ].join("");
  const parts = messageParts({ html });
  const visible = parts.map((part) => (part.type === "link" ? `${part.text} ${part.href}` : part.text)).join("\n");
  assert.doesNotMatch(visible, /javascript|user:pass|169\.254|127\.0\.0\.1|images\.example/);
  const link = parts.find((part): part is LinkPart => part.type === "link");
  assert.equal(link?.text, "Open notes");
  assert.equal(link?.href, "https://example.com/ok");
});

test("plain text keeps a URL that the HTML view would have dropped", () => {
  const parts = messageParts({ text: "Notes at https://example.com/docs." });
  const link = parts.find((part): part is LinkPart => part.type === "link");
  assert.equal(link?.href, "https://example.com/docs");
  assert.equal(link?.button, false);
  assert.match(parts.map((part) => part.text).join(""), /\.$/);
});
