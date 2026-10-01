import { MailError } from "../errors.ts";
import { newId, utcDay } from "../ids.ts";
import { ingestRaw, type IngestDeps } from "../ingest.ts";
import { buildRawMessage, cleanHeaderValue } from "../mime/compose.ts";
import type { RulesDocument } from "../rules/types.ts";
import { sesRfcId, type MailSender, type OutboundMessage } from "../send.ts";

/** The only address a bot can ever send to. Not configurable: the `test-send` scope means exactly this. */
export const LOJO_TEST_RECIPIENT = "lojo-test@cyberphysical.us";
export const TEST_SEND_SUBJECT_PREFIX = "[lojo-bot test] ";

export interface TestSendLimits {
  perHour: number;
  perDay: number;
  maxChars: number;
}

export const DEFAULT_TEST_SEND_LIMITS: TestSendLimits = { perHour: 5, perDay: 20, maxChars: 5000 };

export interface TestSendDeps extends Omit<IngestDeps, "now" | "llm" | "rules"> {
  sender?: MailSender | null;
  sendRules: () => Promise<RulesDocument>;
  now: () => Date;
  limits?: TestSendLimits;
}

export interface TestSendInput {
  /** `bot:<name>`, for the counters and the audit log. */
  bot: string;
  subject: string;
  text: string;
}

const HOUR_MS = 3_600_000;

/**
 * One plain-text message from Jon's mailbox to LOJO_TEST_RECIPIENT. The caller
 * never chooses a recipient. The global send kill switch stops it, it is rate
 * limited per bot, and it carries Auto-Submitted so no auto-responder answers it.
 */
export async function botTestSend(deps: TestSendDeps, input: TestSendInput): Promise<{ messageId: string; to: string }> {
  const limits = deps.limits ?? DEFAULT_TEST_SEND_LIMITS;
  const at = deps.now();
  const audit = (outcome: string, detail: string) =>
    deps.store.putAudit({ id: newId("aud"), day: utcDay(at), at: at.toISOString(), action: "bot.test_send", outcome, detail: `${input.bot} ${detail}`.slice(0, 300), actor: input.bot });
  const sender = deps.sender;
  if (!sender) throw new MailError("No sender is configured", "invalid");
  const subject = cleanHeaderValue(input.subject).slice(0, 200);
  if (!subject || !input.text.trim()) throw new MailError("subject and text are required", "invalid");
  if (input.text.length > limits.maxChars) throw new MailError(`A test message is at most ${limits.maxChars} characters`, "invalid");
  if ((await deps.sendRules()).sendKillSwitch) {
    await audit("kill_switch", "refused");
    throw new MailError("Sending is stopped: the global send kill switch is on", "forbidden");
  }
  const hour = Math.floor(at.getTime() / HOUR_MS);
  const perHour = await deps.store.bumpCounter(`testsend:${input.bot}:h${hour}`, new Date((hour + 2) * HOUR_MS));
  const day = utcDay(at);
  const perDay = await deps.store.bumpCounter(`testsend:${input.bot}:${day}`, new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000));
  if (perHour > limits.perHour || perDay > limits.perDay) {
    await audit("rate_limited", `hour:${perHour}/${limits.perHour} day:${perDay}/${limits.perDay}`);
    throw new MailError(`Test sends are limited to ${limits.perHour} an hour and ${limits.perDay} a day per bot`, "rate_limited");
  }
  const outbound: OutboundMessage = {
    from: { email: deps.config.mailbox, name: "Jon Hebert" },
    to: [{ email: LOJO_TEST_RECIPIENT }],
    cc: [],
    subject: subject.startsWith(TEST_SEND_SUBJECT_PREFIX) ? subject : `${TEST_SEND_SUBJECT_PREFIX}${subject}`,
    text: `${input.text.trim()}\n\n--\nTest message sent by ${input.bot} through lojo-mail's test-send scope.`,
    autoReplied: true,
  };
  let sent: { messageId: string };
  try {
    sent = await sender.send(outbound);
  } catch (error) {
    await audit("failed", (error instanceof Error ? error.message : "send failed").slice(0, 200));
    throw new MailError("SES did not accept the test message", "upstream");
  }
  await audit("sent", `to:${LOJO_TEST_RECIPIENT} ses:${sent.messageId}`);
  const copy = buildRawMessage(outbound, { messageId: sesRfcId(sent.messageId, deps.config.region), date: at });
  await ingestRaw(copy, { ...deps, llm: null, embedder: null, rules: null, now: at }, { origin: "sent", deliveryId: `sent:${sent.messageId}` });
  return { messageId: sent.messageId, to: LOJO_TEST_RECIPIENT };
}
