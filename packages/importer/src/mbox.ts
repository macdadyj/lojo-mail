/** Split a classic mbox file on "From " separator lines. */
export function splitMbox(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const messages: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("From ")) {
      if (current && current.some((item) => item.trim().length > 0)) messages.push(current);
      current = [];
      continue;
    }
    if (!current) current = [];
    current.push(line);
  }
  if (current && current.some((item) => item.trim().length > 0)) messages.push(current);
  return messages.map((message) => message.join("\n")).filter((message) => /message-id|^from:/im.test(message));
}
