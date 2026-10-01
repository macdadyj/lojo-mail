import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { buildRawMessage, type MailSender, type OutboundMessage, type RawOutbound } from "@lojo/core";

/** Always Raw, so every header goes through the same sanitizer and threading headers survive. */
export function sesInput(message: OutboundMessage, configurationSet?: string): SendEmailCommandInput {
  return {
    FromEmailAddress: message.from.email,
    Destination: {
      ToAddresses: message.to.map((item) => item.email),
      CcAddresses: message.cc.map((item) => item.email),
      ...((message.bcc ?? []).length > 0 ? { BccAddresses: (message.bcc ?? []).map((item) => item.email) } : {}),
    },
    ConfigurationSetName: configurationSet,
    Content: { Raw: { Data: new TextEncoder().encode(buildRawMessage(message)) } },
  };
}

/**
 * Jon's client message as built, sent to every envelope recipient. The
 * Destination carries Bcc, which is why the message itself must not.
 */
export function sesRawInput(message: RawOutbound, configurationSet?: string): SendEmailCommandInput {
  return {
    FromEmailAddress: message.from,
    Destination: { ToAddresses: message.destinations },
    ConfigurationSetName: configurationSet,
    Content: { Raw: { Data: message.raw } },
  };
}

export class SesSender implements MailSender {
  constructor(
    private readonly client: { send: (command: SendEmailCommand) => Promise<{ MessageId?: string }> },
    private readonly configurationSet?: string,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SesSender {
    return new SesSender(new SESv2Client({ region: env.LOJO_REGION ?? env.AWS_REGION ?? "us-east-1" }), env.LOJO_CONFIG_SET);
  }

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    return this.dispatch(sesInput(message, this.configurationSet));
  }

  async sendRaw(message: RawOutbound): Promise<{ messageId: string }> {
    return this.dispatch(sesRawInput(message, this.configurationSet));
  }

  private async dispatch(input: SendEmailCommandInput): Promise<{ messageId: string }> {
    const out = await this.client.send(new SendEmailCommand(input));
    if (!out.MessageId) throw new Error("SES returned no MessageId");
    return { messageId: out.MessageId };
  }
}
