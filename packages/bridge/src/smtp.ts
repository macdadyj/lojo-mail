import type { AddressInfo } from "node:net";
import { assertNever, DEFAULT_CLIENT_SEND_LIMITS, parseMime } from "@lojo/core";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { ApiError, type ApiClient } from "./api.ts";
import type { LoginGuard } from "./auth.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { Notifier } from "./notify.ts";

export const MAX_SUBMISSION_BYTES = 10 * 1024 * 1024;
/** What the API accepts for a direct send (base64 inside Lambda's request limit). Advertised as SIZE so Thunderbird warns first. */
export const MAX_SEND_BYTES = DEFAULT_CLIENT_SEND_LIMITS.maxBytes;
const MAX_RECIPIENTS = DEFAULT_CLIENT_SEND_LIMITS.maxRecipients;

/**
 * `send`: the bridge token holds `client-send`, so Send in Thunderbird goes out
 * through SES at once. `queue`: every message becomes a draft in the approval
 * queue, and only the web app, with Jon signed in, can send it.
 */
export type SubmissionMode = "send" | "queue";

export interface SubmissionContext {
  api: ApiClient;
  guard: LoginGuard;
  logger: Logger;
  address: string;
  mode: SubmissionMode;
  /** Every address MAIL FROM and From may use. Always includes `address`. */
  sendFrom: string[];
  notify: Notifier | null;
  webUrl?: string;
  /** Called after the service changed (a sent copy or a draft), so IMAP clients refresh. */
  onChange?: () => void;
}

type SmtpError = Error & { responseCode: number };

function smtpError(responseCode: number, message: string): SmtpError {
  return Object.assign(new Error(message), { responseCode });
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

function readAll(stream: SMTPServerDataStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** An API refusal as the SMTP reply Thunderbird shows. Rate limits and outages are transient (4xx) so it can retry. */
function apiRefusal(error: ApiError, action: string): SmtpError {
  const detail = oneLine(error.message);
  if (error.status === 429) return smtpError(451, `4.7.0 ${detail}`);
  if (error.status === 403) return smtpError(550, `5.7.1 lojo-mail refused ${action}: ${detail}`);
  if (error.status >= 400 && error.status < 500) return smtpError(554, `5.6.0 lojo-mail refused ${action}: ${detail}`);
  return smtpError(451, "4.3.0 The lojo-mail API is unavailable; try again later");
}

export class SubmissionServer {
  private readonly server: SMTPServer;
  private readonly allowedFrom: Set<string>;

  constructor(private readonly ctx: SubmissionContext) {
    this.allowedFrom = new Set([ctx.address, ...ctx.sendFrom].map((item) => item.toLowerCase()));
    const sending = ctx.mode === "send";
    this.server = new SMTPServer({
      name: "lojo-mail-bridge",
      banner: sending ? "lojo-mail bridge: mail you send here goes out through lojo-mail" : "lojo-mail bridge: submissions go to the approval queue, nothing is sent from here",
      secure: false,
      disabledCommands: ["STARTTLS"],
      allowInsecureAuth: true,
      authOptional: false,
      authMethods: ["PLAIN", "LOGIN"],
      size: sending ? MAX_SEND_BYTES : MAX_SUBMISSION_BYTES,
      maxClients: 16,
      closeTimeout: 2_000,
      logger: false,
      onAuth: (auth, _session, callback) => {
        this.ctx.guard
          .attempt(auth.username ?? "", auth.password ?? "")
          .then((outcome) => {
            switch (outcome) {
              case "ok":
                this.ctx.logger.info("smtp.login");
                callback(null, { user: this.ctx.address });
                return;
              case "bad":
                this.ctx.logger.warn("smtp.login_failed");
                callback(smtpError(535, "5.7.8 Invalid credentials"));
                return;
              case "locked":
                this.ctx.logger.warn("smtp.login_locked");
                callback(smtpError(454, "4.7.0 Too many failed logins; try again later"));
                return;
              default:
                assertNever(outcome, "login outcome");
            }
          })
          .catch((error: unknown) => callback(smtpError(454, `4.7.0 ${errorMessage(error)}`)));
      },
      onMailFrom: (address, _session, callback) => {
        if (!this.canSendAs(address.address)) {
          callback(smtpError(550, `5.7.1 The sender must be one of ${this.fromList()}`));
          return;
        }
        callback();
      },
      onRcptTo: (_address, session, callback) => {
        if (session.envelope.rcptTo.length >= MAX_RECIPIENTS) {
          callback(smtpError(452, "4.5.3 Too many recipients"));
          return;
        }
        callback();
      },
      onData: (stream, session, callback) => {
        const limit = sending ? MAX_SEND_BYTES : MAX_SUBMISSION_BYTES;
        readAll(stream)
          .then((raw) => {
            if (stream.sizeExceeded) throw smtpError(552, `5.3.4 Message is over ${limit} bytes including attachments`);
            return sending ? this.send(raw, session) : this.queue(raw, session);
          })
          .then((reply) => callback(null, reply))
          .catch((error: unknown) => {
            if (error instanceof Error && "responseCode" in error) {
              callback(error);
              return;
            }
            this.ctx.logger.error("smtp.submit_failed", { reason: errorMessage(error) });
            callback(smtpError(451, "4.3.0 The bridge could not handle this message; try again"));
          });
      },
    });
    this.server.on("error", (error) => this.ctx.logger.warn("smtp.error", { reason: errorMessage(error) }));
  }

  private canSendAs(address: string): boolean {
    return this.allowedFrom.has(address.toLowerCase());
  }

  private fromList(): string {
    return [...this.allowedFrom].join(", ");
  }

  private envelopeFrom(session: SMTPServerSession): string {
    const from = session.envelope.mailFrom;
    return from ? from.address.toLowerCase() : this.ctx.address;
  }

  /** Direct send. The API re-checks everything here and adds the kill switch and rate limits. */
  private async send(raw: Buffer, session: SMTPServerSession): Promise<string> {
    const parsed = await parseMime(raw);
    const from = parsed.from.email.toLowerCase();
    if (!this.canSendAs(from)) throw smtpError(550, `5.7.1 The From header must be one of ${this.fromList()}`);
    if (from !== this.envelopeFrom(session)) throw smtpError(550, "5.7.1 The From header must match MAIL FROM");
    const recipients = session.envelope.rcptTo.map((item) => item.address.toLowerCase());
    if (recipients.length === 0) throw smtpError(554, "5.5.1 No valid recipients");
    let reply;
    try {
      reply = await this.ctx.api.clientSend({ raw, envelopeFrom: from, recipients });
    } catch (error) {
      if (error instanceof ApiError) {
        this.ctx.logger.warn("smtp.send_refused", { status: error.status, reason: oneLine(error.message) });
        throw apiRefusal(error, "the message");
      }
      throw error;
    }
    this.ctx.logger.info("smtp.sent", {
      messageId: reply.messageId,
      recipients: recipients.length,
      bcc: reply.bcc,
      attachments: parsed.attachments.length,
      ...(reply.draftId ? { draftId: reply.draftId, draftUnchanged: String(reply.draftUnchanged) } : {}),
    });
    this.ctx.onChange?.();
    return `Sent through lojo-mail (SES ${oneLine(reply.messageId)})`;
  }

  /** Approval-queue mode: Jon's approval in the web app covers To, Cc and text only, so Bcc and attachments are refused. */
  private async queue(raw: Buffer, session: SMTPServerSession): Promise<string> {
    const parsed = await parseMime(raw);
    if (parsed.from.email.toLowerCase() !== this.ctx.address) {
      throw smtpError(550, `5.7.1 The From header must be ${this.ctx.address}`);
    }
    const envelope = session.envelope.rcptTo.map((item) => item.address.toLowerCase());
    const to = parsed.to.map((item) => item.email.toLowerCase());
    const cc = parsed.cc.map((item) => item.email.toLowerCase());
    const visible = new Set([...to, ...cc]);
    const hidden = envelope.filter((email) => !visible.has(email));
    if (hidden.length > 0) {
      throw smtpError(550, "5.7.1 Bcc is not supported: Jon's approval covers the To and Cc lines only, so every recipient must be visible there");
    }
    if (parsed.attachments.length > 0) {
      throw smtpError(550, "5.7.1 Attachments are not supported in approval-queue mode; send it without attachments");
    }
    const inEnvelope = new Set(envelope);
    let draftTo = [...new Set(to.filter((email) => inEnvelope.has(email)))];
    let draftCc = [...new Set(cc.filter((email) => inEnvelope.has(email) && !draftTo.includes(email)))];
    if (draftTo.length === 0) {
      draftTo = draftCc;
      draftCc = [];
    }
    if (draftTo.length === 0) throw smtpError(554, "5.5.1 No valid recipients");
    let draftId: string;
    try {
      const created = await this.ctx.api.createDraft({
        to: draftTo,
        cc: draftCc,
        subject: parsed.subject,
        text: parsed.text,
        ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
      });
      draftId = created.draft.id;
      await this.ctx.api.submitDraft(draftId);
    } catch (error) {
      if (error instanceof ApiError) throw apiRefusal(error, "the draft");
      throw error;
    }
    this.ctx.logger.info("smtp.queued_for_approval", { draftId, recipients: draftTo.length + draftCc.length });
    this.ctx.onChange?.();
    this.ctx.notify?.("Draft awaiting your approval", `A message from Thunderbird is in the lojo-mail approval queue.${this.ctx.webUrl ? ` Review it at ${this.ctx.webUrl}` : ""}`);
    return `Queued for Jon's approval as draft ${draftId}; nothing is sent until you approve it in the lojo-mail web app`;
  }

  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.server.off("error", reject);
        resolve((this.server.server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
