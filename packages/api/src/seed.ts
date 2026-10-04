import { readFileSync } from "node:fs";
import { ingestRaw, type IngestDeps, type MessageOrigin } from "@lojo/core";

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

const SEED: Array<[string, MessageOrigin]> = [
  ["personal.eml", "inbound"],
  ["reply.eml", "sent"],
  ["newsletter.eml", "inbound"],
  ["phish.eml", "inbound"],
  ["attachment.eml", "inbound"],
  ["html-only.eml", "inbound"],
  ["testflight.eml", "inbound"],
  ["link-other.eml", "inbound"],
];

export async function seedDemo(deps: IngestDeps): Promise<void> {
  for (const [name, origin] of SEED) {
    await ingestRaw(fixture(name), deps, { origin, deliveryId: `seed:${name}` });
  }
  await ingestRaw(extra, deps, { deliveryId: "seed:harbor" });
  await ingestRaw(receipt, deps, { deliveryId: "seed:receipt" });
}
