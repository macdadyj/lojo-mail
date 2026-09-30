import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { buildRawMessage, type MailSender, type OutboundMessage } from "@lojo/core";

/** Always Raw, so every header goes through the same sanitizer and threading headers survive. */
export function sesInput(message: OutboundMessage, configurationSet?: string): SendEmailCommandInput {
  return {
    FromEmailAddress: message.from.email,
    Destination: {
      ToAddresses: message.to.map((item) => item.email),
      CcAddresses: message.cc.map((item) => item.email),
    },
    ConfigurationSetName: configurationSet,
    Content: { Raw: { Data: new TextEncoder().encode(buildRawMessage(message)) } },
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
    const out = await this.client.send(new SendEmailCommand(sesInput(message, this.configurationSet)));
    if (!out.MessageId) throw new Error("SES returned no MessageId");
    return { messageId: out.MessageId };
  }
}
