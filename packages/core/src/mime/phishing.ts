import type { Address } from "../types.ts";

const URGENT = /verify your account|password (expires|reset)|wire transfer|gift cards?|account (is )?suspended|urgent action required/i;

export interface PhishingSignal {
  score: number;
  reasons: string[];
}

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

export function heuristicPhishing(input: {
  from: Address;
  replyTo?: Address;
  subject: string;
  text: string;
}): PhishingSignal {
  const reasons: string[] = [];
  let score = 0;
  const fromDomain = domainOf(input.from.email);
  if (input.replyTo && domainOf(input.replyTo.email) !== fromDomain) {
    score += 25;
    reasons.push("Reply-To domain differs from From domain");
  }
  if (input.from.name && /@/.test(input.from.name)) {
    const named = input.from.name.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    if (named && domainOf(named) !== fromDomain) {
      score += 20;
      reasons.push("Display name contains a different email domain");
    }
  }
  if (URGENT.test(`${input.subject}\n${input.text}`)) {
    score += 35;
    reasons.push("Urgent or credential language");
  }
  const links = input.text.match(/https?:\/\/[^\s)]+/gi) ?? [];
  if (links.length >= 5) {
    score += 15;
    reasons.push("Unusually many links");
  }
  if (/xn--/i.test(input.text) || /xn--/i.test(input.from.email)) {
    score += 30;
    reasons.push("Punycode in the address or body");
  }
  return { score: Math.min(100, score), reasons };
}
