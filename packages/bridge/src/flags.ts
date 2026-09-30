import type { MessageView } from "@lojo/core";

/** EXPUNGE and MOVE-to-Trash add this label and archive the message; Archive and Trash hide it. */
export const HIDDEN_LABEL = "thunderbird-deleted";

/** Labels the service or the bridge set for their own reasons. IMAP flags can neither add nor remove them. */
const PROTECTED_LABELS = new Set([HIDDEN_LABEL, "quarantined"]);

const SAFE_LABEL = /^\$?[a-z0-9][a-z0-9_.-]{0,39}$/;

/** Label on the service, keyword as Thunderbird knows it. Thunderbird's default tags are $label1..$label5. */
const NAMED: Array<[string, string]> = [
  ["flagged", "\\Flagged"],
  ["answered", "\\Answered"],
  ["important", "$label1"],
  ["work", "$label2"],
  ["personal", "$label3"],
  ["todo", "$label4"],
  ["later", "$label5"],
  ["$forwarded", "$Forwarded"],
  ["$mdnsent", "$MDNSent"],
  ["junk", "Junk"],
  ["nonjunk", "NonJunk"],
];

const LABEL_TO_FLAG = new Map(NAMED);
const FLAG_TO_LABEL = new Map(NAMED.map(([label, flag]) => [flag.toLowerCase(), label]));

export const SYSTEM_FLAGS = ["\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft"] as const;
export const DEFINED_FLAGS = [...SYSTEM_FLAGS, "$Forwarded", "$MDNSent", "Junk", "NonJunk", "$label1", "$label2", "$label3", "$label4", "$label5"];

export function labelToFlag(label: string): string | null {
  if (PROTECTED_LABELS.has(label)) return null;
  const named = LABEL_TO_FLAG.get(label);
  if (named) return named;
  return SAFE_LABEL.test(label) ? label : null;
}

export function flagToLabel(flag: string): string | null {
  const lower = flag.toLowerCase();
  const named = FLAG_TO_LABEL.get(lower);
  if (named) return named;
  if (lower.startsWith("\\") || PROTECTED_LABELS.has(lower) || !SAFE_LABEL.test(lower)) return null;
  return lower;
}

export function hasFlag(flags: readonly string[], flag: string): boolean {
  const lower = flag.toLowerCase();
  return flags.some((item) => item.toLowerCase() === lower);
}

export function flagsFor(view: Pick<MessageView, "unread" | "labels">, deleted: boolean): string[] {
  const flags: string[] = [];
  if (!view.unread) flags.push("\\Seen");
  if (deleted) flags.push("\\Deleted");
  for (const label of view.labels) {
    const flag = labelToFlag(label);
    if (flag && !hasFlag(flags, flag)) flags.push(flag);
  }
  return flags;
}

/** Labels IMAP cannot represent are kept; every representable label follows the flag set exactly. */
export function labelsFor(current: readonly string[], flags: readonly string[]): string[] {
  const labels = current.filter((label) => labelToFlag(label) === null);
  for (const flag of flags) {
    const label = flagToLabel(flag);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const lower = new Set(a.map((item) => item.toLowerCase()));
  return b.every((item) => lower.has(item.toLowerCase()));
}
