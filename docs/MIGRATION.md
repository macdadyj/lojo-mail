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

The importer is idempotent. It records the RFC `Message-ID` (or a SHA-256 of the raw file when a message has none) in an import ledger. A second run skips those keys and does not duplicate threads.

```bash
npm run import -- \
  --input imports/tuta \
  --contacts imports/tuta/contacts.vcf \
  --map config/tuta-folder-map.json \
  --store data/mailbox.json
```

`--store` is a JSON file for a local mailbox you can open with `npm run dev`. To import into AWS later, set `LOJO_STORE=dynamo` and the table names from Terraform output, with credentials in the environment. The script never embeds credentials.

Behavior:

- Folder names map through `config/tuta-folder-map.json`. Unknown folders become labels, and the message is filed in `archive` so it does not flood the inbox. Edit the map before the first real import.
- De-duplication is by `Message-ID`, then by hash of the raw bytes.
- Threads are reconstructed from `References` and `In-Reply-To`, then by a normalized subject fallback only when those headers are absent **and** the participants match. Re-running the import does not create a second thread for the same root.
- Attachments are kept inside the envelope.
- The importer does **not** call the LLM unless you pass `--analyze`. Bulk historical mail would burn the token budget and send years of mail to a provider. `--analyze` uses `LOJO_LLM_PROVIDER` (Grok needs `LOJO_GROK_API_KEY`; Ollama and Bedrock use their usual settings). If Grok is selected and the key is missing, the importer says so and uses the mock model. Default is off.
- Prefer `.eml` files. A classic mbox splits on any line that starts with `From `, which can cut a message whose body contains that prefix.

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
- Export one last time and re-run the importer (it will skip what it already has).
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
