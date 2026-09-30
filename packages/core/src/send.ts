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
  /** RFC 3834 `Auto-Submitted: auto-replied`, set on everything a rule sends. */
  autoReplied?: boolean;
}

export interface MailSender {
  send(message: OutboundMessage): Promise<{ messageId: string }>;
}

export class MemorySender implements MailSender {
  readonly sent: OutboundMessage[] = [];
  failNext = false;

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("MessageRejected: simulated SES failure");
    }
    this.sent.push(message);
    return { messageId: `local-${this.sent.length}@memory` };
  }
}
