import type { Contact } from "@lojo/core";

export function parseVcards(raw: string): Contact[] {
  const cards = raw.split(/BEGIN:VCARD/i).slice(1);
  const contacts: Contact[] = [];
  for (const card of cards) {
    const email = card.match(/EMAIL[^:\r\n]*:([^\r\n]+)/i)?.[1]?.trim();
    if (!email) continue;
    const name = card.match(/(?:^|\n)FN:([^\r\n]+)/)?.[1]?.trim();
    const key = card.match(/(?:^|\n)KEY[^:]*:([^\r\n]+)/)?.[1]?.trim();
    const contact: Contact = { email: email.toLowerCase() };
    if (name) contact.name = name;
    if (key?.includes("BEGIN PGP")) contact.pgpPublicKey = key;
    contacts.push(contact);
  }
  return contacts;
}

export function parseContactsCsv(raw: string): Contact[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = lines[0]?.split(",").map((cell) => cell.trim().toLowerCase()) ?? [];
  const emailIndex = header.indexOf("email");
  const nameIndex = header.indexOf("name");
  if (emailIndex < 0) throw new Error("CSV contacts need an email column");
  const contacts: Contact[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const email = cells[emailIndex]?.trim().toLowerCase();
    if (!email) continue;
    const contact: Contact = { email };
    const name = nameIndex >= 0 ? cells[nameIndex]?.trim() : undefined;
    if (name) contact.name = name;
    contacts.push(contact);
  }
  return contacts;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}
