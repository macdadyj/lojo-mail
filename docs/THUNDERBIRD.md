# Thunderbird on Santa Computa

lojo-mail has no IMAP or SMTP server in the cloud. Thunderbird talks to a small bridge on the same machine (`packages/bridge`). The bridge speaks IMAP4rev1 and SMTP submission on `127.0.0.1`, calls the lojo-mail API over HTTPS with a least-privilege token, and decrypts mail locally with the envelope private key.

```text
Thunderbird ──IMAP 127.0.0.1:1143──┐
            ──SMTP 127.0.0.1:1587──┤  lojo-bridge (systemd --user)  ──HTTPS + bridge token──▶  lojo-mail API
                                   └─ decrypts with ~/.config/lojo-mail/envelope.private.jwk
```

Thunderbird is a full client for `lojo@cyberphysical.us`: you read, sort, reply, forward, attach, and send there, and never need the web app for normal mail. Three things are worth knowing:

- **Send means send.** With `bridge_send_enabled = true` (the default), Send in Thunderbird goes straight out through SES. No web approval: you at your own mail client are the approval. The global send kill switch, the From list, size limits, and rate limits still apply. With it off, Thunderbird sends go to the web approval queue as before.
- **Bot replies wait in Drafts.** Grok, Cursor, and local models can sort your mail and write replies, but they cannot send. Their replies appear in Drafts with the tag `bot-draft`. Open one, edit it if you like, and press Send: that is the approval. See [BOTS.md](BOTS.md).
- **Deleting moves to Trash, and Trash is emptied on a schedule.** A delete is a soft delete: the message stays in Trash, restorable, for the retention window (30 days by default, never less than 7). After that, the server-side trash purge may delete it for good, once Jon turns the purge on (`trash_purge_mode = purge`; it only reports until then). Details in section 4.

## 1. Prerequisites

1. **Node.js 22 or newer** and a checkout of this repository.
2. **The bridge token.** One random value, at least 32 characters, stored in two places:

   ```bash
   openssl rand -base64 36
   ```

   - In AWS: SSM SecureString parameter `/lojo-mail/bridge-token` (the API reads the parameter named by `LOJO_BRIDGE_TOKEN_PARAM`, default `/lojo-mail/bridge-token`; see [RUNBOOK.md](RUNBOOK.md#1-keys-and-parameters)). Wait about 5 minutes for the API to reload it.
   - On Santa, either in `pass` (`pass insert lojo/bridge-token`) or in a file only you can read:

     ```bash
     install -d -m 700 ~/.config/lojo-mail
     (umask 077; printf '%s\n' 'PASTE-THE-TOKEN' > ~/.config/lojo-mail/bridge-token)
     ```

   The API gives this token `read`, `write`, `body`, `compose`, plus `trash` (with `bridge_trash_enabled`) and `client-send` (with `bridge_send_enabled`). `client-send` is Jon at Thunderbird: no other token can hold it, not even `admin`, and `/mcp` refuses any token that has it. The bridge checks `GET /v1/session` at start and refuses to run with a token that has `send` or `admin`.
3. **The envelope private key**, `keys/envelope.private.jwk` from `npm run keygen`, the key the mailbox seals to. Copy it out of your password manager:

   ```bash
   install -m 600 /path/to/envelope.private.jwk ~/.config/lojo-mail/envelope.private.jwk
   ```

   Never commit it and never put it inside the repository; the installer refuses paths inside the checkout. `pass` works here too (`pass insert -m lojo/envelope-jwk`, then `--private-key-command '["pass","show","lojo/envelope-jwk"]'`).

   If the password manager holds only the wrapped key, rebuild the file with `lojo-bridge key import-wrapped --in wrapped.txt --out ~/.config/lojo-mail/envelope.private.jwk` (from a checkout: `npm run key -- import-wrapped …`).

   Once the bridge has the key, `lojo-bridge key export-wrapped` makes the wrapped key and key passphrase that unlock the web app on other devices, and `lojo-bridge key verify-wrapped --in FILE` checks a backup. See [WEB_KEY.md](WEB_KEY.md).

## 2. Install

```bash
scripts/install-bridge.sh \
  --api-url https://api.cyberphysical.us \
  --web-url https://mail.cyberphysical.us \
  --token-file ~/.config/lojo-mail/bridge-token \
  --private-key-file ~/.config/lojo-mail/envelope.private.jwk
```

Use your real API and web app URLs. With `pass`, replace the file flags with `--token-command '["pass","show","lojo/bridge-token"]'` and `--private-key-command '["pass","show","lojo/envelope-jwk"]'`. Commands are JSON argv arrays and run without a shell.

The script refuses to run as root. It builds `dist/bridge.mjs`, copies it to `~/.local/share/lojo-mail/`, writes a `~/.local/bin/lojo-bridge` wrapper, creates `~/.config/lojo-mail` and `~/.local/state/lojo-mail` (mode 700), runs `lojo-bridge init` if there is no config yet, installs `~/.config/systemd/user/lojo-mail-bridge.service`, and enables and starts it. Re-running it upgrades the bundle and restarts the service; it keeps your config.

`init` prints the **app password once**. Copy it into Thunderbird in the next step. Lost it? Run `lojo-bridge reset-password`, then `systemctl --user restart lojo-mail-bridge`.

Check everything:

```bash
lojo-bridge check
```

It checks file modes, reaches the API, shows the token's scopes, and opens the newest inbox message with your key.

## 3. Thunderbird account

Account Settings → Account Actions → Add Mail Account. Enter your name, `lojo@cyberphysical.us`, and the app password, then choose **Configure manually**:

| | Incoming (IMAP) | Outgoing (SMTP) |
| --- | --- | --- |
| Server | `127.0.0.1` | `127.0.0.1` |
| Port | `1143` | `1587` |
| Connection security | None | None |
| Authentication | Normal password | Normal password |
| Username | `lojo@cyberphysical.us` | `lojo@cyberphysical.us` |

Use `127.0.0.1`, not `localhost`: the bridge does not listen on IPv6.

Thunderbird warns that the connection is not encrypted. Confirm it. The bridge only listens on loopback, so the traffic never leaves the machine, and TLS on loopback would not stop anyone: a process that can read loopback traffic can also read `~/.config/lojo-mail`. A self-signed STARTTLS certificate would only add a certificate exception dialog.

### Folders

The bridge publishes the service's fixed folders with SPECIAL-USE flags, so Thunderbird usually maps them on its own:

| Thunderbird | lojo-mail folder |
| --- | --- |
| Inbox | inbox |
| Drafts | open drafts: yours, bots' (tagged `bot-draft`), and AI suggestions |
| Sent | sent |
| Archive | archive |
| Junk | spam |
| Trash | trash (delete moves here; move a message out to restore it) |

Check these under Account Settings:

- **Copies & Folders:** Sent in "Sent", Drafts in "Drafts". **Turn off "Place a copy in"**: the service files the Sent copy itself (sealed, with your Bcc list), and the bridge drops Thunderbird's copy, so leaving it on only makes Thunderbird upload every message twice.
- **Extra From addresses:** Account Settings → Manage Identities → Add, for each address in Terraform `send_from_addresses` (for example `jon@lojo.engineering`). Use the same outgoing server (`127.0.0.1:1587`). Any other From is refused.
- **Copies & Folders → Archive options:** choose **A single folder**. The default yearly subfolders need CREATE, which lojo-mail does not support.
- **Server Settings → When I delete a message:** choose **Move it to this folder: Trash**. "Just mark it as deleted" also works (the bridge moves the message to Trash on expunge). Avoid "Remove it immediately": the bridge treats it the same as a move to Trash, but Thunderbird will tell you the message is gone when it is not.
- **Junk Settings:** Junk in "Junk". Marking junk adds the `junk` label; moving to Junk moves the message to spam.

## 4. What each action does

**Sending.** Press Send and the message goes out through SES at once. SMTP answers `Sent through lojo-mail (SES ...)` and a sealed copy appears in Sent within seconds (it keeps your Bcc list, visible only to you). Everything Thunderbird composes works:

- **Several To and Cc recipients, and Bcc.** Bcc recipients get the message; the Bcc header is removed before it leaves.
- **Attachments**, inline images, vCards, and attached OpenPGP keys, up to **4 MB for the whole message** (about 3 MB of attachments after encoding). Thunderbird sees the limit through SMTP `SIZE` and warns before sending. Larger files: share a link.
- **Replies and forwards** keep `In-Reply-To` and `References`, so the recipient's client threads them, and the Sent copy joins the thread in lojo-mail.
- **From** is `lojo@cyberphysical.us` or one of the extra identities you listed in `send_from_addresses`; the envelope sender must match.

**Refused at send time** (Thunderbird shows the SMTP error and keeps the message in the compose window or Outbox):

- **The global send kill switch is on** (`550 ... kill switch`). It stops Thunderbird sends, approved drafts, and rule auto-send together. Turn it on or off in the web app under Rules → "Stop all sending". Agents may turn it on, never off.
- **Rate limits** (`451`, temporary, Thunderbird retries): by default 30 messages per 10 minutes, 200 messages and 500 recipients per UTC day, 50 recipients per message. Terraform `client_send_limits` changes them.
- **A From address that is not on the list**, or over 4 MB.

Bounces and complaints: the SES configuration set suppresses addresses that hard-bounced or complained, so a second send to them is dropped by SES instead of hurting the domain's reputation. Every send and every refusal is in the audit log (`send.client`) with counts only.

**Sending with `bridge_send_enabled = false`.** The bridge turns each submission into a client draft in the web approval queue and answers `Queued for Jon's approval as draft drf_...`. Nothing leaves until you approve it in the web app. In this mode Bcc and attachments are refused, because the approval covers the visible text only.

**Drafts.** The Drafts folder shows every open draft on the service:

- **Your own drafts.** Thunderbird saves drafts with IMAP APPEND; each save becomes a client draft on the service (so it also shows in the web app), keeps Thunderbird's Message-ID so Thunderbird finds it again, and replaces the previous version. Drafts are stored as plain text: a draft with an attachment is refused (`NO [CANNOT]`), so keep such drafts in Local Folders or just send them.
- **Bot drafts**, written by an agent (Grok, Cursor, a local model) or a rule, carry the tag `bot-draft`, so you can make a saved search or a colour for them. AI reply suggestions that the service writes at delivery for personal mail appear here too.
- **Approve and send a bot draft:** open it (double-click, or Edit Draft), check it, and press Send. The service matches the sent message to the draft by its hidden `X-Lojo-Draft-Id` header (removed before sending), marks the draft sent, and records whether you sent it unchanged or edited it. There is no separate approve button: the Send you pressed through the bridge is the approval, and only the bridge credential on Santa can do that.
- **Discard a draft:** delete it in Thunderbird. It is discarded on the service (not sent, kept in the audit log). Drafts can only be deleted, not moved elsewhere.

**Reading.** Opening a message marks it read in lojo-mail. Stars (`\Flagged`) become the `flagged` label, "Answered" becomes `answered`, and Thunderbird's tags become labels: Important `important`, Work `work`, Personal `personal`, To Do `todo`, Later `later`. Other tag keywords become labels of the same name when they are simple words. Labels such as `quarantined` cannot be changed from Thunderbird.

**Moving and copying.** Moves to Inbox, Archive, Junk, or Trash move the message in lojo-mail. Moving into Sent or Drafts is refused. lojo-mail keeps one copy of each message, so **Copy to another folder moves it** (the original disappears from the source folder; Thunderbird copes). Copy within the same folder does nothing.

**Searching.** Thunderbird's search (quick filter, Search Messages, saved searches with "search online") runs over IMAP SEARCH against headers, flags, dates, and the decrypted text: From, To, Cc, Bcc (Sent), Subject, body, and tags all work.

**New mail.** While Thunderbird idles on a folder (IMAP IDLE, on by default), the bridge checks the newest messages every 15 seconds (`newMailSeconds` in `bridge.json`, 5 to 600) and pushes new mail at once; a full resync of flags and moves runs every 60 seconds (`pollSeconds`). Bodies and attachments are decrypted locally by the bridge when Thunderbird opens them.

**Deleting.** Delete in Thunderbird (Delete key, move to Trash, or mark deleted and expunge) moves the message to Trash in lojo-mail. This is a soft delete, never a hard delete:

- The message keeps its sealed body and attachments and gets `trashedBy: bridge` and a `keepUntil` date (now plus the retention window, 30 days by default; set `trashRetentionDays` in the rules document, 7 to 365). The web app's Trash view shows the date.
- Every delete is in the audit log (`message.trashed`, `by:bridge`).
- **To restore,** move the message out of Trash in Thunderbird, or use Restore in the web app's Trash view. Restoring clears the date.
- **Deleting inside Trash** only hides the message in Thunderbird (label `thunderbird-deleted`). It stays in Trash on the service until the purge.
- **After the window,** the daily trash purge on the server may delete it for good, if Jon has set `trash_purge_mode = purge` (the default, `report`, only logs what would be deleted). For 30 days after a purge an operator can still restore it from backups (docs/RUNBOOK.md, Trash purge); after that it is gone.

This needs two things, both set by Jon: Terraform `bridge_trash_enabled = true` (the default), which gives the bridge token the `trash` scope, and `"deleteToTrash": true` in `bridge.json` (the default; `lojo-bridge init --no-trash` writes `false`). `lojo-bridge check` prints which behaviour is active. If either is off, delete falls back to the old behaviour: the message is archived with the hidden label `thunderbird-deleted`, and you recover it by removing the label in the web app.

The `trash` scope belongs to the bridge token alone. Agent tokens, `admin` tokens, and the MCP server cannot get it, and it cannot hard delete: only the server's purge policy can, and only after the window.

**Not supported:** creating, renaming, or deleting folders; drafts with attachments; messages over 4 MB; CONDSTORE/QRESYNC; server-side sort or threading. Thunderbird works without these.

## 5. Troubleshooting

```bash
systemctl --user status lojo-mail-bridge
journalctl --user -u lojo-mail-bridge -f
lojo-bridge check
```

The log is JSON lines with ids, counts, and status codes only: never tokens, passwords, addresses, or message content.

- **`is accessible to group or others`:** `chmod 600` the named file, or `chmod 700` the directory. The bridge refuses to start otherwise.
- **`The bridge token has the send scope`:** the configured token is not the bridge token. Use the value of `/lojo-mail/bridge-token`.
- **`The envelope key does not open the newest inbox message`:** wrong key file. Messages show a "could not be decrypted" placeholder instead of the body.
- **Login keeps failing:** after 10 failures in a row the bridge refuses all logins for 15 minutes. Restarting the service clears it.
- **Thunderbird shows a message twice or not at all after a restore:** right-click the folder → Properties → Repair Folder.
- **Service fails with `226/NAMESPACE` or similar:** your systemd cannot apply one of the sandboxing options in user units. Comment out the failing line in `~/.config/systemd/user/lojo-mail-bridge.service` and run `systemctl --user daemon-reload`.
- **Token or key in `pass`:** gpg-agent must hold the key unlocked; pinentry cannot prompt from a service. See the comments in the unit file.
- **Large folders:** each folder shows the newest 2000 messages (`folderLimit` in `bridge.json`, up to 5000).
- **New mail is slow to appear:** the bridge checks for new mail every `newMailSeconds` (15) while Thunderbird idles, and does a full resync every `pollSeconds` (60). Check that "Allow immediate server notifications when new messages arrive" is on (Server Settings) and "Check for new messages every" is set.
- **Send answers `Queued for Jon's approval`:** the API has `LOJO_BRIDGE_SEND` off (`bridge_send_enabled = false`), or it has not reloaded yet (up to 5 minutes). `lojo-bridge check` prints the send mode; the log says `token.no_client_send`.
- **`550 ... kill switch`:** someone engaged the global send kill switch. Release it in the web app (Rules → "Allow sending again"). Only your signed-in session can.
- **`451 ... rate limit`:** wait; Thunderbird's Outbox retries. Raise `client_send_limits` if the defaults are too low for you.
- **`552 Message is over 4000000 bytes`:** remove or shrink attachments.
- **An old draft stays in Drafts after sending:** it was edited so much that the service could not match it (different subject, recipients, and no `X-Lojo-Draft-Id`). Delete it.

## 6. Security notes

- **On disk:** `~/.config/lojo-mail/bridge.json` (API URL, address, secret sources, scrypt hash of the app password; mode 600), the bridge token and envelope key if you use files (mode 600), and `~/.local/state/lojo-mail/bridge-state.json` (message ids, UIDs, and sizes only; mode 600). Thunderbird keeps its own offline cache of your mail in its profile, so disable "Keep messages for this account on this computer" (Synchronization & Storage) if you do not want that.
- **In memory:** decrypted messages live in the bridge's memory cache (64 MB, least recently used). The bridge never writes plaintext to disk.
- **Network:** both listeners bind `127.0.0.1` only. The bridge refuses a config that asks for any other address, and it refuses a non-HTTPS API URL except `localhost` for development.
- **Who can read your mail:** anyone with your desktop session can use the bridge or read the key. Use full-disk encryption and lock the screen. `pass` with a gpg-agent timeout is better than plain files.
- **What the token can do:** read, change flags, labels, and folders, move mail to Trash (with `trash`; restorable for the window), read bodies, create drafts, and send as the addresses on the From list (with `client-send`), within the rate limits and only while the kill switch is off. It cannot hard delete, approve web drafts, change rules or settings, or administer. A stolen bridge token plus the ability to reach the API can send mail as you until you rotate it, so treat it like a mail password: keep it in `pass` or a mode-600 file, and rotate `/lojo-mail/bridge-token` if Santa is lost. Every send is audited (`send.client`), and the kill switch stops it at once. Every Trash move is audited with `by:bridge`, so a stolen token trashing mail shows up in the web app's Trash view and the audit log. If Santa is lost, delete `/lojo-mail/bridge-token` in SSM (or set a new value). The API stops accepting the old token when it reloads.

## 7. Uninstall

```bash
systemctl --user disable --now lojo-mail-bridge
rm ~/.config/systemd/user/lojo-mail-bridge.service
systemctl --user daemon-reload
rm -r ~/.local/share/lojo-mail ~/.local/state/lojo-mail ~/.local/bin/lojo-bridge
rm -r ~/.config/lojo-mail   # the config, and the token and key if you stored them there
```

Then remove the account in Thunderbird and rotate `/lojo-mail/bridge-token` in SSM.
