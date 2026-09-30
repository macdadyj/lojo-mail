# Thunderbird on Santa Computa

lojo-mail has no IMAP or SMTP server in the cloud. Thunderbird talks to a small bridge on the same machine (`packages/bridge`). The bridge speaks IMAP4rev1 and SMTP submission on `127.0.0.1`, calls the lojo-mail API over HTTPS with a least-privilege token, and decrypts mail locally with the envelope private key.

```text
Thunderbird ──IMAP 127.0.0.1:1143──┐
            ──SMTP 127.0.0.1:1587──┤  lojo-bridge (systemd --user)  ──HTTPS + bridge token──▶  lojo-mail API
                                   └─ decrypts with ~/.config/lojo-mail/envelope.private.jwk
```

Two things work differently from ordinary mail:

- **Sending queues a draft.** Nothing leaves until you approve it in the lojo-mail web app.
- **Deleting archives.** The message is archived with the label `thunderbird-deleted` and hidden from Thunderbird. It stays recoverable in the web app.

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

   The API gives this token exactly `read`, `write`, `body`, `compose`. The bridge checks `GET /v1/session` at start and refuses to run with a token that has `send` or `admin`.
3. **The envelope private key**, `keys/envelope.private.jwk` from `npm run keygen`, the key the mailbox seals to. Copy it out of your password manager:

   ```bash
   install -m 600 /path/to/envelope.private.jwk ~/.config/lojo-mail/envelope.private.jwk
   ```

   Never commit it and never put it inside the repository; the installer refuses paths inside the checkout. `pass` works here too (`pass insert -m lojo/envelope-jwk`, then `--private-key-command '["pass","show","lojo/envelope-jwk"]'`).

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
| Drafts | drafts (Thunderbird's drafts stay local, see below) |
| Sent | sent |
| Archive | archive (minus messages deleted from Thunderbird) |
| Junk | spam |
| Trash | trash (read and restore; you cannot delete into it) |

Check these under Account Settings:

- **Copies & Folders:** Sent in "Sent", Drafts in "Drafts". You can turn off "Place a copy in", because the bridge drops that copy anyway (the real one appears in Sent after you approve).
- **Copies & Folders → Archive options:** choose **A single folder**. The default yearly subfolders need CREATE, which lojo-mail does not support.
- **Server Settings → When I delete a message:** "Move it to this folder: Trash" or "Just mark it as deleted" both work. See below.
- **Junk Settings:** Junk in "Junk". Marking junk adds the `junk` label; moving to Junk moves the message to spam.

## 4. What each action does

**Sending.** The bridge turns every submission into a draft (origin `client`) and puts it in the approval queue. SMTP answers `Queued for Jon's approval as draft drf_...`, and a desktop notification appears if `notify-send` is installed. **Nothing is sent until you approve it in the web app.** Replies keep their thread through `In-Reply-To`. The body is the plain-text part; HTML-only mail is converted to text.

The bridge never approves or sends by itself, and it cannot:

- Minting an approval needs a signed-in human session (your passphrase). The bridge would have to store the passphrase or prompt for it on Santa.
- A local "confirm send?" dialog is no protection: any process running as you, or malware, can spoof it or click it.
- The web app's approval binds the hash of the exact content you reviewed. A second approval path would weaken that.
- The bridge token has no `send` scope. The API returns 403 even if the bridge tried.

**Refused at send time** (Thunderbird shows the SMTP error):

- **Bcc.** The approval covers the To and Cc lines only, so every recipient must be visible there.
- **Attachments**, including inline images, attached OpenPGP keys, and vCards. The service cannot send attachments yet.
- **A From address other than `lojo@cyberphysical.us`.**
- **Messages over 10 MB.**

**Drafts.** Thunderbird saves drafts with IMAP APPEND. The bridge accepts and drops them, so drafts stay in Thunderbird's local copy only. They are not synced to the web app until you send.

**Reading.** Opening a message marks it read in lojo-mail. Stars (`\Flagged`) become the `flagged` label, "Answered" becomes `answered`, and Thunderbird's tags become labels: Important `important`, Work `work`, Personal `personal`, To Do `todo`, Later `later`. Other tag keywords become labels of the same name when they are simple words. Labels such as `quarantined` cannot be changed from Thunderbird.

**Moving.** Moves to Inbox, Archive, or Junk move the message in lojo-mail. Moving into Sent or Drafts is refused. COPY is refused: lojo-mail keeps one copy of each message.

**Deleting.** The bridge token cannot move mail to trash; only you, signed in to the web app, can. So when Thunderbird deletes (moves to Trash, or marks deleted and expunges), the bridge:

1. adds the label `thunderbird-deleted`,
2. archives the message (unless it is already in Archive or Trash),
3. hides messages with that label from Archive and Trash in Thunderbird.

To recover, open Archive in the web app and remove the label. To make deletes real trash, the bridge token would need a trash scope. That is a deliberate choice you can revisit; it would let anything with the bridge token trash mail.

**Not supported:** creating, renaming, or deleting folders; COPY; Bcc; sending attachments; CONDSTORE/QRESYNC; server-side sort or threading. Thunderbird works without these.

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
- **New mail is slow to appear:** the bridge checks the API every 60 seconds while Thunderbird idles (`pollSeconds`).

## 6. Security notes

- **On disk:** `~/.config/lojo-mail/bridge.json` (API URL, address, secret sources, scrypt hash of the app password; mode 600), the bridge token and envelope key if you use files (mode 600), and `~/.local/state/lojo-mail/bridge-state.json` (message ids, UIDs, and sizes only; mode 600). Thunderbird keeps its own offline cache of your mail in its profile, so disable "Keep messages for this account on this computer" (Synchronization & Storage) if you do not want that.
- **In memory:** decrypted messages live in the bridge's memory cache (64 MB, least recently used). The bridge never writes plaintext to disk.
- **Network:** both listeners bind `127.0.0.1` only. The bridge refuses a config that asks for any other address, and it refuses a non-HTTPS API URL except `localhost` for development.
- **Who can read your mail:** anyone with your desktop session can use the bridge or read the key. Use full-disk encryption and lock the screen. `pass` with a gpg-agent timeout is better than plain files.
- **What the token can do:** read, change flags, labels, and folders (never trash), read bodies, and create drafts to anyone. It cannot send, approve, or administer. If Santa is lost, delete `/lojo-mail/bridge-token` in SSM (or set a new value). The API stops accepting the old token when it reloads.

## 7. Uninstall

```bash
systemctl --user disable --now lojo-mail-bridge
rm ~/.config/systemd/user/lojo-mail-bridge.service
systemctl --user daemon-reload
rm -r ~/.local/share/lojo-mail ~/.local/state/lojo-mail ~/.local/bin/lojo-bridge
rm -r ~/.config/lojo-mail   # the config, and the token and key if you stored them there
```

Then remove the account in Thunderbird and rotate `/lojo-mail/bridge-token` in SSM.
