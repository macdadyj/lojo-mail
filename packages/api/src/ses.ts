import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import type { MailSender, OutboundMessage } from "@lojo/core";

export function sesInput(message: OutboundMessage, configurationSet?: string): SendEmailCommandInput {
  const from = message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email;
  const destination = {
    ToAddresses: message.to.map((item) => item.email),
    CcAddresses: message.cc.map((item) => item.email),
  };
  if (message.armored) {
    const raw = [
      `From: ${from}`,
      `To: ${destination.ToAddresses.join(", ")}`,
      message.cc.length ? `Cc: ${destination.CcAddresses.join(", ")}` : "",
      `Subject: ${message.subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      message.armored,
    ]
      .filter((line) => line !== "")
      .join("\r\n");
    return {
      FromEmailAddress: message.from.email,
      Destination: destination,
      ConfigurationSetName: configurationSet,
      Content: { Raw: { Data: new TextEncoder().encode(raw) } },
    };
  }
  return {
    FromEmailAddress: message.from.email,
    Destination: destination,
    ConfigurationSetName: configurationSet,
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: message.text, Charset: "UTF-8" },
          ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {}),
        },
      },
    },
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
    return { messageId: out.MessageId ?? "ses-unknown" };
  }
}
