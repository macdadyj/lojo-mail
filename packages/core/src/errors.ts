/** `upstream`: the model provider failed or returned something unusable. */
export type MailErrorCode = "not_found" | "locked" | "forbidden" | "invalid" | "budget" | "conflict" | "upstream";

export class MailError extends Error {
  readonly code: MailErrorCode;

  constructor(message: string, code: MailErrorCode) {
    super(message);
    this.name = "MailError";
    this.code = code;
  }
}

export function assertNever(value: never, what = "value"): never {
  throw new Error(`Unexpected ${what}: ${JSON.stringify(value)}`);
}
