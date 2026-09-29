import type { Draft } from "./types.ts";

export interface Fields {
  to: string;
  cc: string;
  subject: string;
  text: string;
  pgp: Draft["pgp"];
}

/** How long the send button stays disabled after a conflict, so a reflexive second click can't approve the new version. */
export const RECHECK_DELAY_MS = 3000;

const LABELS: Record<keyof Fields, string> = {
  to: "recipients (To)",
  cc: "recipients (Cc)",
  subject: "subject",
  text: "message text",
  pgp: "encryption",
};

function normalized(fields: Fields, name: keyof Fields): string {
  const value = fields[name];
  if (name === "to" || name === "cc") {
    return value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .join(",");
  }
  return value;
}

export function changedFields(reviewed: Fields, current: Fields): string[] {
  return (Object.keys(LABELS) as (keyof Fields)[]).filter((name) => normalized(reviewed, name) !== normalized(current, name)).map((name) => LABELS[name]);
}

type Writer = Draft["origin"];

function writer(who: Writer): string | null {
  switch (who) {
    case "human":
      return null;
    case "agent":
      return "an assistant";
    case "ai":
      return "the AI";
    default: {
      const unhandled: never = who;
      return unhandled;
    }
  }
}

/** Depends on who wrote the content, never on status, so an assistant's edit or a conflict reload can't hide it. */
export function authorNotice(draft: Pick<Draft, "origin" | "lastEditedBy" | "status">): string | null {
  const author = writer(draft.origin);
  const editor = draft.lastEditedBy && draft.lastEditedBy !== draft.origin ? writer(draft.lastEditedBy) : null;
  if (!author && !editor) return null;
  const parts: string[] = [];
  if (author) parts.push(`${author} wrote this draft`);
  if (editor) parts.push(`${editor} last changed ${author ? "it" : "this draft"}`);
  const sentence = parts.join(", and ");
  const asked = draft.status === "pending_approval" ? " It is waiting for your approval." : "";
  return `${sentence[0]?.toUpperCase()}${sentence.slice(1)}.${asked} Check the recipients and the text before you send.`;
}
