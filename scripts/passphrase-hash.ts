import { MIN_PASSPHRASE_LENGTH, hashPassphrase } from "@lojo/api/session";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/** Reads a line from the terminal without echoing it. */
async function prompt(label: string): Promise<string> {
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      for (const char of data.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

let passphrase: string;
if (process.stdin.isTTY) {
  passphrase = await prompt(`New passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters): `);
  if ((await prompt("Again: ")) !== passphrase) {
    console.error("Passphrases do not match.");
    process.exit(1);
  }
} else {
  passphrase = await readStdin();
}

try {
  const hash = hashPassphrase(passphrase);
  console.log(hash);
  console.error("\nStore it (SecureString) with:");
  console.error("  aws ssm put-parameter --name /lojo-mail/human-passphrase-hash --type SecureString --overwrite --value '<hash above>'");
  console.error("If the session secret does not exist yet:");
  console.error('  aws ssm put-parameter --name /lojo-mail/session-secret --type SecureString --value "$(openssl rand -base64 48)"');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
