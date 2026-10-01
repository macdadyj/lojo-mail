/**
 * `upstream`: the model provider failed or returned something unusable.
 * `unavailable`: storage refused a read the deployment should allow (an IAM gap), so the answer is unknown.
 * `too_large`: the message would go over a size limit (HTTP 413).
 */
export type MailErrorCode =
  | "not_found"
  | "locked"
  | "forbidden"
  | "invalid"
  | "budget"
  | "conflict"
  | "upstream"
  | "unavailable"
  | "rate_limited"
  | "too_large";

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
