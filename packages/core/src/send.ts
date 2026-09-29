import type { Address } from "./types.ts";

export interface OutboundMessage {
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  html?: string;
  /** Set when the body was OpenPGP-encrypted before handoff to SES. */
  armored?: string;
}

export interface MailSender {
  send(message: OutboundMessage): Promise<{ messageId: string }>;
}

export class MemorySender implements MailSender {
  readonly sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `local-${this.sent.length}@memory` };
  }
}
