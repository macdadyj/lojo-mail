import { readFileSync } from "node:fs";
import { ingestRaw, type IngestDeps } from "@lojo/core";

function fixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/emails/${name}`, import.meta.url), "utf8");
}

const extra = `From: Noah Patel <noah@example.com>
To: lojo@cyberphysical.us
Subject: Review the harbor notes Friday
Date: Mon, 22 Sep 2026 16:40:00 +0000
Message-ID: <harbor-1@example.com>
Content-Type: text/plain; charset=utf-8

Hi Jon,

Can you review the harbor notes before Friday, 3 October 2026? I left the open questions at the bottom.

Noah
`;

const receipt = `From: Northline Books <orders@northline.example>
To: lojo@cyberphysical.us
Subject: Your order is packed
Date: Tue, 23 Sep 2026 13:05:00 +0000
Message-ID: <order-1@northline.example>
Content-Type: text/plain; charset=utf-8

Your order of two notebooks shipped today. No action needed.
`;

export async function seedDemo(deps: IngestDeps): Promise<void> {
  const files = ["personal.eml", "reply.eml", "newsletter.eml", "phish.eml", "attachment.eml", "html-only.eml"];
  for (const name of files) {
    await ingestRaw(fixture(name), deps);
  }
  await ingestRaw(extra, deps);
  await ingestRaw(receipt, deps);
}
