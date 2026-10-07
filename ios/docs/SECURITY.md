# LOJO Mail iOS: security notes

The web app's threat model (`docs/SECURITY.md`) still applies. This covers what the phone adds.

## Secrets on the phone

| What | Where | Accessibility |
| --- | --- | --- |
| Envelope private key (`envelope.private.jwk`) | Keychain, service `com.lojo.Mail` | `AfterFirstUnlock`: still readable after the first unlock since boot, including while the screen is locked, so an app update does not look like the key vanished. Not a file in the app sandbox. |
| Session token (`hs_…`, 12 h) | Keychain | `AfterFirstUnlockThisDeviceOnly` so background refresh can list mail |
| Web passphrase (only with "Keep me signed in") | Keychain | `AfterFirstUnlockThisDeviceOnly` |

- The key is validated on import (curve, `d` matches `x`/`y`) and identified in Settings by the same fingerprint the
  server publishes in `/v1/settings` (`envelopeKeyFingerprint`, #9). A key for a different mailbox is refused on
  import, and a stored one that doesn't match shows a red banner. Pasting clears the clipboard afterwards.
- **Importing the key** (Files, AirDrop, share sheet, paste, typing): the key text never appears on screen unless Jon
  taps the eye on the manual field, and the field hides again when the app leaves the foreground (so the app switcher
  snapshot can't show it). Paste and file imports go straight to the Keychain without filling any field. Files that
  arrive by AirDrop or "Open in" are copies in Documents/Inbox: read (64 KB cap), deleted immediately, and anything
  left there is purged when the app backgrounds. Files picked in the Files app are only read, never moved or deleted.
  An incoming key is stored only after a confirmation that shows its fingerprint, and that confirmation waits while
  the Face ID lock is up. Error messages name the problem (public key, wrapped key, wrong mailbox) and never echo key
  material.
- **Passphrase field**: `SecureField` with `textContentType(.password)` next to a `.username` field, autocorrect,
  autocapitalisation and spell-check off, show/hide toggle that resets on backgrounding. No associated domains (free
  account), so iOS won't offer to save the passphrase from the app; it can still be filled from the password manager.
- A keychain read that fails because the phone is locked is not treated as "no key", and it does not delete the item.
  The old `WhenUnlockedThisDeviceOnly` class failed that way, so the unlock screen came back after a locked launch
  or a background refresh. Session expiry deletes the session token only. The envelope key stays.
- Background refresh still lists metadata only (sender and subject, which the server already stores in the clear).
  It does not need the envelope key, and it does not remove it.
- The app never logs: there is no `print`, `os_log` or `Logger` in the sources. `URLSession` is ephemeral (no cookie
  store, no URL cache).
- Only HTTPS base URLs are accepted (plain HTTP only for loopback, for the local demo). No ATS exceptions.

## Mail on the phone

- **Decrypted bodies live in memory only** and are dropped on sign-out.
- **Metadata cache** (from, subject, snippet, flags; no bodies, no AI text) in Application Support with
  `completeUntilFirstUserAuthentication` file protection, excluded from backup. Cleared on sign-out.
- **Received attachments** are decrypted to a temp file with `complete` file protection for Quick Look, Share… or
  Save to Files, deleted when that closes (Save to Files moves the file out), and the temp directory is purged on
  launch and sign-out.
- **Attachments you add in Compose** are held in memory only, never written to the phone's disk. Photos are
  re-encoded as JPEG, which drops EXIF location. Files from Files are sent as they are. Each file is uploaded to the
  draft with its SHA-256 and the approval names those hashes in order, so a bot can't swap a file after Jon reviewed it ([API-ATTACHMENTS.md](API-ATTACHMENTS.md)). The camera permission is only asked when you tap
  Take Photo.
- **Links in a message** follow the web reader (`docs/SECURITY.md`, "Links in the reader"), ported to `MessageLinks.swift` and tested against the same cases. The app never renders a message's HTML (no web view): the tags are walked for text and `<a href>`, images and scripts are dropped, so nothing remote loads when a message opens. A link is tappable only when SES recorded `dmarc=pass` (and spam/virus are not `FAIL`, not quarantined) **and** the sender's domain is on the trusted list (Settings > Links; default `apple.com`, `email.apple.com`, `testflight.apple.com`, `github.com`). Tapping it opens the unwrapped destination with `UIApplication.open`, which hands Apple invites to TestFlight or Safari. Every other http(s) link shows a confirmation naming the host and the full URL before it opens. Tracking hops are unwrapped only when the next URL is written inside the link; nothing is fetched to resolve one. Only `http` and `https` to a public hostname without credentials become links.
- Optional **Face ID lock** covers the UI when the app returns from the background.

## Sending

- The only send path is the human approval flow: `POST /v1/drafts/:id/approval` with exactly the reviewed
  to/cc/subject/text/pgp, then `approve-and-send` with the one-time token. If a bot edited the draft between review and
  tap, the server refuses (409), the app shows which fields changed and disarms the button for 3 seconds.
- Every send goes through a confirmation that names the recipients and the From address.
- **Test mode is off unless Jon turns it on.** A missing preference is off. It used to register a default of on,
  so a new app container (reinstall, or a new `XTL-<team>` bundle id after switching signing teams) silently
  limited sending to `lojo-test@cyberphysical.us`. The choice is stored in UserDefaults and the Keychain. The
  inbox and Compose show **Turn off test mode** while it is on. Screenshot launch variables do not enable it.
- The app never uses `/v1/client/send` (a bridge-only scope); attachments go through the same approval flow.

## Kill switches and rules

The server enforces who may do what; the app only reflects it. Any token can engage the rules kill switch, the send
kill switch or pause; only a signed-in human session (this app, the web app) can release or resume, and the app asks
for confirmation first. Disabling a rule is always allowed; the app has no way to enable or write rules (that is
`npm run rules -- push` on the desktop).

## USB provisioning

`provision-phone.sh` signs in on Santa Computa, then uses `house_arrest` to drop `provision-session.json` and
`provision-envelope.private.jwk` into the app's own container. Only a paired, trusted host can reach a
development-signed app's container; `UIFileSharingEnabled` is off, so the files are not visible in the Files app or
Finder. The bundle id is discovered with `pymobiledevice3 apps list` (`XTL-*.com.lojo.Mail`); it is not hardcoded.
The app imports the files into the Keychain when it becomes active and when **USB from Santa Computa** is tapped,
then deletes them. Launching the app over USB is best-effort, because iOS 17+ needs a tunnel for that step.
The host copies live in a `mktemp` directory that is removed on exit. The script prints nothing secret.

## In git

Nothing secret is committed: no UDID (read from USB at run time), no Apple cookies or pairing records, no session,
passphrase or key. `npm run secrets:check` covers `ios/` (with `.build` skipped).

## What a free Apple account can't do

- **No push notifications.** APNs needs a paid team, so mail notifications depend on iOS background app refresh,
  which iOS schedules as it likes (often hours, never when Low Power Mode is on or the app was force-quit).
- **7-day profile.** The app stops launching when the profile expires until it is redeployed.
- No App Groups/extensions (no share sheet, no widgets), no TestFlight.

## Trade-offs for Jon to decide

- "Keep me signed in" stores the passphrase so the session renews silently. Without it, the app asks for the
  passphrase every 12 hours. A server-issued refresh token scoped to this device would be better than storing the
  passphrase.
- The metadata cache is readable after first unlock (needed for background refresh). Turning background refresh off
  in iOS Settings makes it irrelevant.
