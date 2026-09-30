# Using the web app from any device

The web app (app.cyberphysical.us) opens sealed mail in the browser with the envelope private key. You don't want the raw key on a phone or on a borrowed laptop, so Santa Computa exports a **wrapped key**: the private key encrypted under a separate, generated **key passphrase**. The wrapped key is a single line of about 640 characters. It is safe to store in a password manager, and safe even if it leaks on its own, because it is useless without the key passphrase.

Nothing here changes AWS. The server never sees the unwrapped key or the key passphrase.

## 1. Export the wrapped key on Santa

The bridge reads the private key from `~/.config/lojo-mail/bridge.json` (its `privateKeyFile` or `privateKeyCommand`), or from the flags:

```bash
lojo-bridge key export-wrapped
# or, from a repo checkout, with the key somewhere else:
npm run key -- export-wrapped --private-key-file keys/envelope.private.jwk
npm run key -- export-wrapped --private-key-command '["pass","show","lojo-mail/envelope-private-jwk"]'
```

It prints three things, once:

- **The wrapped key**, starting `lojo-key-v1.`.
- **The key passphrase**, 30 characters in groups of five, for example `V6P3W-Q68D6-…`. It is 150 random bits. It is not written anywhere; copy it now.
- **The key fingerprint**, for example `4b03-1ae8-2ab2-0349-faf4`. The web app shows the same fingerprint for the mailbox, so you can see that the two match.

`--out PATH` also writes the wrapped key to a file with mode 0600. It refuses to overwrite an existing file unless you pass `--force`. The export unwraps its own output before printing, so a blob that doesn't round-trip is never shown.

Check a stored copy at any time (a good backup drill):

```bash
lojo-bridge key verify-wrapped --in wrapped.txt    # prompts for the key passphrase without echo
```

With `bridge.json` present, `verify-wrapped` also checks that the blob holds the same key the bridge uses.

## 2. Unlock in the web app

1. Sign in with the web sign-in passphrase.
2. Open **Settings**, section **Envelope key**.
3. Paste the wrapped key, or upload the file.
4. Type the key passphrase. Dashes, spaces and case don't matter, and `O`/`I`/`L` are read as `0`/`1`.
5. Choose the options, then press **Unlock**. The key derivation takes about a second on a laptop and a few seconds on a phone; the button shows progress.

The web app refuses a key whose fingerprint doesn't match the mailbox's published public key, so you can't unlock the wrong key by accident.

While unlocked, the key is a non-extractable WebCrypto key held only in the tab's memory. The app never writes the unwrapped key to `localStorage`, `sessionStorage` or anywhere else. Reloading or closing the tab locks it.

### Options

| Option | Default | What it stores on the device |
| --- | --- | --- |
| Keep the wrapped key in this browser | off | The wrapped key only, in `localStorage`. Next time you type just the key passphrase. |
| Remember on this device with a passkey | off | The key, sealed under a key derived from a passkey (WebAuthn PRF). Unlocking needs the passkey and your fingerprint, face or device PIN, every time. |
| Auto-lock after | 15 minutes idle | The setting only. Choices: 5, 15, 60 or 240 minutes. |

**Remember with a passkey** needs a browser and authenticator that support the WebAuthn PRF extension: recent Chrome, Edge and Safari with platform passkeys, and most FIDO2 security keys. If the browser can't do it, the checkbox is disabled; there is no weaker fallback. To undo it, press **Forget this device**, and delete the "lojo-mail" passkey in the device's passkey settings.

### Lock and auto-lock

- **Lock** in the navigation rail (or **Lock now** in Settings) drops the key and clears every decrypted message from the page.
- Auto-lock fires after the chosen idle time, measured from your last click, key press, scroll or touch.
- It also locks 12 hours after unlocking, however active you are.
- Signing out locks.
- Background tabs are checked again the moment they come back to the foreground, so a sleeping laptop doesn't stay unlocked.

When locked, the rail shows **Unlock**: with a passkey on this device it unlocks right there; otherwise it takes you to Settings.

## 3. Password-manager layout

Use one entry per secret, so that the sign-in passphrase, which you type often, isn't stored beside the key material.

| Entry | Field | Value |
| --- | --- | --- |
| `lojo-mail web sign-in` | username | `lojo` (unused, helps autofill) |
| | password | the web sign-in passphrase |
| | URL | `https://app.cyberphysical.us` |
| `lojo-mail wrapped key` | note (or attached file `lojo-wrapped-key.txt`) | the `lojo-key-v1.…` line |
| | fingerprint | `4b03-1ae8-2ab2-0349-faf4` |
| | created | the date of the export |
| `lojo-mail key passphrase` | password | the 30-character key passphrase |
| `lojo-mail envelope private key` (optional, see below) | attached file | `envelope.private.jwk` |

Trade-offs:

- **Wrapped key and key passphrase in the same entry.** Convenient, and still protected by the password manager's own encryption. But anyone who gets into that one entry, or the whole vault, can read the mail. Keeping them in separate entries helps only against partial exposure (shoulder-surfing, a shared folder, an accidentally shared item). The strongest option is to keep the key passphrase somewhere else entirely: a second vault, or paper in a safe.
- **The wrapped key alone can be stored anywhere,** even in cloud notes or email to yourself. It is a 150-bit secret behind scrypt; nobody can guess the passphrase.
- **The raw private key** (`envelope.private.jwk`) should live in at most one place off Santa, as a disaster-recovery copy. The wrapped key makes it optional: `import-wrapped` rebuilds it (below).

## 4. Backup and recovery

If the envelope private key is lost everywhere, every sealed body and attachment is lost. There is no escrow. Keep at least two independent copies that can rebuild it:

1. The wrapped key plus key passphrase in the password manager (section 3).
2. An offline copy: the wrapped key printed or on a USB stick, and the key passphrase written on paper, stored apart from each other or together in a safe.

**Drill, every few months:** run `lojo-bridge key verify-wrapped --in <copy>` against each copy, or unlock the web app from a private window with the password-manager copy. Both check the passphrase and the fingerprint.

**Rebuild the raw key on a new Santa (or after a disk loss):**

```bash
lojo-bridge key import-wrapped --in lojo-wrapped-key.txt --out ~/.config/lojo-mail/envelope.private.jwk
```

It prompts for the key passphrase, writes the JWK with mode 0600, refuses to overwrite without `--force`, and prints the fingerprint. Point `bridge.json` at the file (or store it in `pass` and use `privateKeyCommand`), then run `lojo-bridge check`.

**Lost device with "keep the wrapped key" or a passkey on it:** the device holds only ciphertext. The wrapped key still needs the key passphrase; the passkey copy still needs the passkey and the device unlock. To be safe, delete the passkey from your account's passkey list (if it synced), and rotate the key passphrase (below). If you think the key passphrase itself leaked together with a wrapped key, treat the envelope key as compromised: see [SECURITY.md](SECURITY.md#key-custody).

## 5. Rotating the key passphrase

Run `lojo-bridge key export-wrapped` again. It generates a new passphrase and a new salt. Replace both password-manager entries, and on devices that keep a wrapped key, press **Remove the kept wrapped key** and unlock with the new one.

Old wrapped keys still unlock with their old passphrase, because the envelope key itself hasn't changed. Rotation protects you only if you also destroy the old copies. If an old blob and its passphrase may both have leaked, the envelope key is exposed and only a new envelope keypair helps; mail already sealed to the old key stays readable to whoever has it.

Passkey copies aren't affected by a passphrase rotation. Remove them with **Forget this device** if the reason for rotating is a lost device.

## 6. Rotating the web sign-in passphrase

The sign-in passphrase gets you past the API, not into sealed mail. Rotate it when you suspect it leaked, or on a schedule:

1. Generate a new passphrase in the password manager (five or more diceware words).
2. Hash it and store the hash (no plaintext reaches AWS):

   ```bash
   npm run passphrase-hash          # prompts without echo; prints the hash
   aws ssm put-parameter --region us-east-1 \
     --name /lojo-mail/human-passphrase-hash \
     --type SecureString --overwrite \
     --value 'scrypt$32768$8$1$…paste the printed hash…'
   ```

3. The API rereads parameters within 5 minutes. Until then, the old passphrase still works.
4. Existing sessions stay valid for up to 12 hours. To end them all now, also rotate the session secret:

   ```bash
   aws ssm put-parameter --region us-east-1 \
     --name /lojo-mail/session-secret \
     --type SecureString --overwrite \
     --value "$(openssl rand -base64 48)"
   ```

5. Update the `lojo-mail web sign-in` entry and sign in again on each device.

These are the only steps in this guide that touch AWS, and they change SSM parameter values only, not infrastructure.
