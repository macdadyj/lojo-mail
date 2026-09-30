import type { AddressInfo } from "node:net";
import { assertNever, parseMime } from "@lojo/core";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { ApiError, type ApiClient } from "./api.ts";
import type { LoginGuard } from "./auth.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { Notifier } from "./notify.ts";

export const MAX_SUBMISSION_BYTES = 10 * 1024 * 1024;
const MAX_RECIPIENTS = 50;

export interface SubmissionContext {
  api: ApiClient;
  guard: LoginGuard;
  logger: Logger;
  address: string;
  notify: Notifier | null;
  webUrl?: string;
}

type SmtpError = Error & { responseCode: number };

function smtpError(responseCode: number, message: string): SmtpError {
  return Object.assign(new Error(message), { responseCode });
}

function readAll(stream: SMTPServerDataStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * SMTP submission that never sends. Each message becomes a draft in Jon's
 * approval queue; only the web app, with Jon signed in, can approve and send it.
 */
export class SubmissionServer {
  private readonly server: SMTPServer;

  constructor(private readonly ctx: SubmissionContext) {
    this.server = new SMTPServer({
      name: "lojo-mail-bridge",
      banner: "lojo-mail bridge: submissions go to the approval queue, nothing is sent from here",
      secure: false,
      disabledCommands: ["STARTTLS"],
      allowInsecureAuth: true,
      authOptional: false,
      authMethods: ["PLAIN", "LOGIN"],
      size: MAX_SUBMISSION_BYTES,
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
        if (address.address.toLowerCase() !== this.ctx.address) {
          callback(smtpError(550, `5.7.1 The sender must be ${this.ctx.address}`));
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
        readAll(stream)
          .then((raw) => {
            if (stream.sizeExceeded) throw smtpError(552, `5.3.4 Message is over ${MAX_SUBMISSION_BYTES} bytes`);
            return this.submit(raw, session);
          })
          .then((reply) => callback(null, reply))
          .catch((error: unknown) => {
            if (error instanceof Error && "responseCode" in error) {
              callback(error);
              return;
            }
            this.ctx.logger.error("smtp.submit_failed", { reason: errorMessage(error) });
            callback(smtpError(451, "4.3.0 The bridge could not queue this message; try again"));
          });
      },
    });
    this.server.on("error", (error) => this.ctx.logger.warn("smtp.error", { reason: errorMessage(error) }));
  }

  private async submit(raw: Buffer, session: SMTPServerSession): Promise<string> {
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
      throw smtpError(550, "5.7.1 Attachments on outgoing mail are not supported by lojo-mail yet; send it without attachments");
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
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        throw smtpError(550, `5.7.1 lojo-mail refused the draft: ${error.message.replace(/[\r\n]/g, " ")}`);
      }
      if (error instanceof ApiError) throw smtpError(451, "4.3.0 The lojo-mail API is unavailable; try again later");
      throw error;
    }
    this.ctx.logger.info("smtp.queued_for_approval", { draftId, recipients: draftTo.length + draftCc.length });
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
