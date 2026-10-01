import type { Address } from "./types.ts";

export interface OutboundMessage {
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  /** Set when the body was OpenPGP-encrypted before handoff to SES. */
  armored?: string;
  /** Files sent as `multipart/mixed` after the text part. */
  attachments?: OutboundAttachment[];
  /**
   * PGP/MIME (RFC 3156): the whole MIME body, text and files, encrypted. When set, the message is
   * `multipart/encrypted` and `text`, `armored` and `attachments` are not sent in the clear.
   */
  pgpMime?: string;
  /** RFC 3834 `Auto-Submitted: auto-replied`, set on everything a rule sends. */
  autoReplied?: boolean;
  /**
   * Envelope-only. Never copied into the message headers, so the other
   * recipients cannot see who was blind-copied. SES gets them as BccAddresses.
   */
  bcc?: Address[];
  /**
   * Bot `send_new`: keep the approved subject, and add loop-suppression headers
   * instead of Auto-Submitted (that banner would hide a real test message).
   */
  botSendNew?: boolean;
}

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/** A finished RFC 5322 message from Jon's own client, with its SMTP envelope. Bcc is already stripped from `raw`. */
export interface RawOutbound {
  from: string;
  /** Every envelope recipient: To, Cc and Bcc. */
  destinations: string[];
  raw: Uint8Array;
}

export interface MailSender {
  send(message: OutboundMessage): Promise<{ messageId: string }>;
  /** Only Jon's client sends pre-built MIME (see client-send.ts). */
  sendRaw?(message: RawOutbound): Promise<{ messageId: string }>;
}

/** SES replaces the Message-ID with `<id@region.amazonses.com>`; the sent copy must carry the same one for threading. */
export function sesRfcId(sesMessageId: string, region: string): string {
  if (sesMessageId.includes("@")) return sesMessageId;
  const host = region === "us-east-1" ? "email.amazonses.com" : `${region}.amazonses.com`;
  return `${sesMessageId}@${host}`;
}

export class MemorySender implements MailSender {
  readonly sent: OutboundMessage[] = [];
  readonly rawSent: RawOutbound[] = [];
  failNext = false;

  private fail(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("MessageRejected: simulated SES failure");
    }
  }

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    this.fail();
    this.sent.push(message);
    return { messageId: `local-${this.sent.length}@memory` };
  }

  async sendRaw(message: RawOutbound): Promise<{ messageId: string }> {
    this.fail();
    this.rawSent.push(message);
    return { messageId: `raw-${this.rawSent.length}@memory` };
  }
}
