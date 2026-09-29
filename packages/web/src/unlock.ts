import { openJson, type EcPrivateJwk, type EnvelopeBlob } from "@lojo/core/crypto";
import type { DraftRow, Message } from "./types.ts";

const SESSION_KEY = "lojo-mail-private-jwk";
let privateJwk: EcPrivateJwk | null = null;

export function rememberKey(jwk: EcPrivateJwk | null, persist: boolean): void {
  privateJwk = jwk;
  if (persist && jwk) sessionStorage.setItem(SESSION_KEY, JSON.stringify(jwk));
  else sessionStorage.removeItem(SESSION_KEY);
}

export function loadRememberedKey(): EcPrivateJwk | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return privateJwk;
  try {
    privateJwk = JSON.parse(raw) as EcPrivateJwk;
    return privateJwk;
  } catch {
    return null;
  }
}

export function hasPrivateKey(): boolean {
  return privateJwk !== null || loadRememberedKey() !== null;
}

export async function openMessage(message: Message): Promise<Message> {
  if (!message.locked || !message.envelope) return message;
  const key = privateJwk ?? loadRememberedKey();
  if (!key) return message;
  const body = await openJson<{
    text: string;
    html: string;
    ai: {
      summary: string;
      threadSummary: string;
      actionItems: Array<{ text: string; deadline: string | null }>;
      draftReply: string;
      phishingReasons: string[];
    } | null;
  }>(message.envelope, key);
  return {
    ...message,
    locked: false,
    text: body.text,
    summary: body.ai?.summary,
    actionItems: body.ai?.actionItems,
    draftReply: body.ai?.draftReply,
    phishingReasons: body.ai?.phishingReasons,
  };
}

export function parsePrivateJwk(raw: string): EcPrivateJwk {
  const parsed = JSON.parse(raw) as Partial<EcPrivateJwk>;
  if (parsed.kty !== "EC" || parsed.crv !== "P-256" || !parsed.x || !parsed.y || !parsed.d) {
    throw new Error("Paste the envelope private JWK (P-256, including d).");
  }
  return { kty: "EC", crv: "P-256", x: parsed.x, y: parsed.y, d: parsed.d };
}

export async function openDraftText(row: DraftRow): Promise<string | null> {
  if (row.text) return row.text;
  return openEnvelopeText(row.draft.envelope);
}

async function openEnvelopeText(envelope: EnvelopeBlob | undefined): Promise<string | null> {
  if (!envelope) return null;
  const key = privateJwk ?? loadRememberedKey();
  if (!key) return null;
  const body = await openJson<{ text: string }>(envelope, key);
  return body.text;
}
