# Moving off Tuta

Source address: `lojo@tuta.io`. Tuta does not offer IMAP or an API. The import path is a desktop-client export, plus a manual cutover of every account that still has the Tuta address on file.

Do this before changing MX records for `cyberphysical.us`. The new address does not have to be the live MX in order to import a mailbox or to send tests from SES.

## What Tuta will and will not do

- The Tuta desktop client can export folders as `.eml` files or as mbox, depending on the client version. Export **all** folders, including Sent, Archive, and custom folders. Spam and Trash are optional; the importer can map them and you can skip the files.
- Contacts export as vCard. If you only have a CSV, the importer accepts a header row with `email` and `name`.
- There is no IMAP to "just sync." Do not spend time looking for a hidden bridge. People have reverse-engineered private APIs; this project does not use that, and it would break.
- Forwarding from Tuta during the transition is limited (filters exist but are not a reliable server-side forward-everything for every folder, and they will not move history). Treat forwarding as a safety net for new mail in Inbox, not as the migration.

## Export

1. Install or open the Tuta desktop client, signed in as `lojo@tuta.io`.
2. Export each folder to a directory, for example:

   ```text
   imports/tuta/
     Inbox/
     Sent/
     Archive/
     Drafts/
     Spam/
     Trash/
     Projects/
   ```

3. Export contacts to `imports/tuta/contacts.vcf` (or `.csv`).
4. Keep that directory **out of git**. The repo ignores `imports/`. The files are your old mailbox in the clear.

## Import

The importer is idempotent. Each message's id is derived from a SHA-256 of its bytes after line endings are normalized (CRLF and bare CR become LF, trailing blank lines and a leading UTF-8 byte-order mark are dropped), and writes are conditional. A second run, even from a new export that uses different line endings, skips everything it already has and does not duplicate threads or contacts. The same message exported into two folders is stored once. A re-export that actually changes a message (for example a client that rewrites headers) is a different message and is imported again.

Files that are empty, contain binary data in the header block, or do not start with a mail header are listed as errors with the reason (`empty file`, `binary file, not a message`, `no mail headers`) and are not stored. The command exits 1 when there are errors; the rest of the import still completes.

### Local first

Try the import locally before touching AWS:

```bash
npm run import -- \
  --input imports/tuta \
  --contacts imports/tuta/contacts.vcf \
  --map config/tuta-folder-map.json \
  --store data/mailbox.json
```

`--store` is a JSON index plus a `data/mailbox.json.blobs/` directory of sealed bodies and attachments. On the first run the importer generates an envelope keypair next to it (`data/mailbox.json.public.jwk` and `data/mailbox.json.private.jwk`, mode 600). Pass `--public-key keys/envelope.public.jwk` to seal to Jon's real key instead. The importer refuses a `--public-key` file that contains a private key. Browse the result with `LOJO_STORE_FILE=data/mailbox.json npm run dev`; the server is locked, so load the private JWK in Settings to read bodies.

### Into AWS

After `terraform apply`, with credentials for the apply principal in the environment (never in a file in the repo):

```bash
export LOJO_BUCKET=$(terraform -chdir=infra/terraform output -raw bucket)
npm run import -- --target aws \
  --input imports/tuta \
  --contacts imports/tuta/contacts.vcf \
  --public-key keys/envelope.public.jwk
```

`--target aws` (or `LOJO_STORE=dynamo`) writes sealed bodies and attachments to `s3://$LOJO_BUCKET/objects/` and the index to the DynamoDB tables. Table names default to the Terraform names (`lojo-mail-messages`, …); override them with `LOJO_TABLE_MESSAGES` and friends if you changed `project`. `--public-key` is required and must be the same public JWK that is in SSM, or the web app will not be able to open the imported mail. The command exits with a clear error if the bucket or key is missing.

### Behavior

- Folders come from the export. Each directory (or each `.mbox` file, by its name) maps through `config/tuta-folder-map.json`. Unknown folders become a label, and the message is filed in `archive` so it does not flood the inbox. Edit the map before the first real import.
- Imported history is marked read, so it does not flood triage.
- Threads are rebuilt from `References` and `In-Reply-To` across this run and earlier ones. There is no subject-based fallback; a message without those headers starts its own thread.
- Files are read as bytes, so Latin-1 and other 8-bit bodies decode correctly.
- Every body and attachment is sealed to the envelope public key and stored as its own object. A 20 MB attachment is fine.
- The importer does **not** call the LLM unless you pass `--analyze`. Bulk historical mail would burn the token budget and send years of mail to a provider. `--analyze` uses `LOJO_LLM_PROVIDER` (Grok needs `LOJO_GROK_API_KEY`; Ollama and Bedrock use their usual settings). If Grok is selected and the key is missing, the importer says so and uses the mock model. Default is off.
- `--embed` stores a vector per message for semantic search, independently of `--analyze`. It uses `LOJO_EMBED_PROVIDER` (Ollama's `nomic-embed-text` on labMachine by default, so the text stays on the tailnet) and counts against the daily token budget (100,000 tokens is only a few hundred messages; for a local Ollama run, raise `LOJO_DAILY_TOKEN_BUDGET` for that shell). Use the same provider, model, and `LOJO_EMBED_DIMENSIONS` as the deployed stack's `embed_provider`, or semantic search in AWS ignores the imported vectors. This is the only way to embed imported mail: the API cannot backfill it because it has no AI-context copy. See [INTEGRATIONS.md](INTEGRATIONS.md#semantic-search).
- mbox files are streamed, so a large export does not have to fit in memory. The splitter follows mboxrd: a new message starts only at a `From ` line with a date that follows a blank line, and `>From ` escapes are reversed. `.eml` files are still the safer export when the client offers them.

## Cutover plan

History and new mail are different problems. Import covers history. New mail needs the rest of the world to learn the new address.

### 1. Stand up lojo-mail without touching MX

Follow [RUNBOOK.md](RUNBOOK.md) through the receipt rule. The apex MX already points at SES in us-east-1, so do not change it. The audit script is how you confirm the zone still matches that picture before apply.

### 2. Keep Tuta alive

Keep `lojo@tuta.io` paid and logged in for at least two months after you start telling people about the new address. Delete it only after a week of empty inboxes and a second pass over accounts you forgot.

### 3. Tell people, in this order

1. Banks, government, domain registrars, Apple ID / Google account recovery, password manager, MFA backups. These are the ones that hurt if they stay on a dead mailbox.
2. Frequent correspondents.
3. Everyone else, as they write to you.

Use the template below. Send it from the new address once SES production access is granted, so the message itself trains their reply button. Until production access, you can only send to verified identities; use that window to test, not to announce.

### 4. Forwarding safety net

On Tuta, add a filter that forwards new Inbox mail to `lojo@cyberphysical.us` if the client still exposes that action for your account. Do not expect it to be complete. Each morning for the first two months, open Tuta once and check for stragglers. That manual check is the plan, not a failure of the plan.

### 5. Receiving starts when the receipt rule is active

DKIM, MAIL FROM, SPF, DMARC, and the apex MX are already in place for us-east-1. Inbound to `lojo@cyberphysical.us` starts when the `lojo-mail` receipt rule set is the active set, not when the MX changes. See the runbook. Do not add DKIM CNAMEs or a second SPF TXT.

### 6. Two months later

- Search Tuta for the latest week of mail.
- Confirm registrars and banks.
- Export one last time and re-run the importer. It skips what it already has, including messages whose only difference is CRLF vs LF line endings (`packages/importer/src/import.test.ts` covers this). Check the report: `skipped` should be most of the export and `imported` only the new mail.
- Then cancel Tuta.

## Contact notification template

Subject: New email address

```text
Hi,

I am moving off my old Tuta address. Please use this one from now on:

  lojo@cyberphysical.us

I will keep an eye on lojo@tuta.io for a couple of months, but mail sent only there will eventually stop reaching me. If you have me saved in a contact, an account recovery setting, or a billing profile, this is the address to put there.

Thanks,
Jon
```

Send yourself a copy. Keep a list, in the password manager or on paper, of accounts you updated. The list is the migration, more than the importer is.

## After the domain itself changes

If `cyberphysical.us` later gives way to `lojo.dev`, repeat the DNS plan for the new domain, add it as a second SES identity, and keep the old MX accepting into the same bucket for as long as you want mail to the old address to land. The store does not care which domain the recipient was. Contacts and account profiles have to be updated again; there is no shortcut for that.
