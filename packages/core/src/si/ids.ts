/** Rules SI writes use this prefix. The kill switch skips them and leaves Jon's other rules alone. */
export const SI_RULE_PREFIX = "si-";

export function isSiRuleId(id: string): boolean {
  return id.startsWith(SI_RULE_PREFIX);
}

export function isSiBlockId(id: string): boolean {
  return id.startsWith(`${SI_RULE_PREFIX}block-`);
}

/** Rule ids are 1–64 of `a-z 0-9 -`. The slug is stable for the same sender, so a second block updates the first. */
export function siRuleId(kind: "block-sender" | "block-domain" | "file", value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const id = `${SI_RULE_PREFIX}${kind}-${slug || "x"}`;
  return id.slice(0, 64);
}
