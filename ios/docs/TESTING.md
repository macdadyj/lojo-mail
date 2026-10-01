# LOJO Mail iOS: testing

## Automated (Linux, `ios/scripts/test-core.sh`)

`CoreTests` builds `LojoMailCore` with swift-crypto on Santa Computa. 23 tests:

- **Offline (18)**: envelopes sealed by `packages/core/src/envelope.ts` open in Swift (body, 70 KB attachment); wrong
  AAD, wrong key and tampering are refused; JWK validation; fingerprint equals `keyFingerprint` from `packages/core`; model decoding (messages, drafts, rules
  including `sendKillSwitch`, session expiry); key files as Files/AirDrop/paste deliver them (BOM,
  pretty-printed, newlines dropped by a secure field, extra JWK members) and the wrong ones refused (public key,
  wrapped `lojo-key-v1.` key, oversize, binary, unrelated JSON) without echoing key material; thread grouping; draft author notices; changed-field comparison
  (mirrors `packages/web/src/review.ts`); reply/forward helpers; HTML fallback; base URL validation; request paths.
- **`--live` (2, read-only)**: signs in with `~/.config/lojo-mail/web-passphrase`, checks the local key's fingerprint
  equals the server's `envelopeKeyFingerprint`, decrypts every Inbox body and attachment with the real envelope key, and decodes drafts, rules, search and every folder.
- **`--live-write` (5)**: through the same `APIClient` the app uses, on mail from `lojo-test@cyberphysical.us` only:
  - unread, star, archive and move back, trash (checks `trashedBy`, `keepUntil`, listed in Trash) and restore, then
    search finds it;
  - engages the send kill switch and checks approve-and-send is refused, toggles the rules kill switch and pause,
    and restores all three to what they were;
  - creates a draft, edits it, queues it, checks a mismatched approval gets 409, then approves and sends **one real
    message to lojo-test@cyberphysical.us**;
  - attachments, plain TLS (`pgp: off`): checks `/v1/settings` advertises 4,000,000 bytes / 10 files, uploads a text
    file and a PNG (order, sizes and SHA-256 come back as sent), adds and removes a third, gets 413 for a file that
    takes the message over 4 MB and 400 for an eleventh file, gets 409 for an approval naming no files, the files in
    the wrong order, or one of two, then approves and sends, and finds both files on the Sent copy;
  - attachments, `pgp: auto` (the app's default): one file, approved and sent. Both go to lojo-test@ only.

Offline, `AttachmentTests` pins the budget to values computed with the server's `estimatedMessageBytes`, the
approval's file order, and the 413/400 mapping through a stubbed transport (the error text names the limit).

`--live-write` found two bugs that the offline tests couldn't: the mutation routes return the stored record, which
the app failed to decode (every read/star/archive/trash would have errored and rolled back), and `/submit` returns
no text, which blanked the compose editor. Both are fixed in the app; see ARCHITECTURE.md.

## On the phone

`ios/scripts/phone-shot.sh OUT.png KEY=VALUE…` launches the app with QA variables and screenshots it. The variables
only choose what is on screen; none of them sends or changes mail.

| Variable | Values |
| --- | --- |
| `LOJO_SCREEN` | `inbox`, `folder`, `thread`, `attachment` (opens the first attachment in Quick Look), `search`, `compose`, `sendconfirm` (shows the send confirmation; sending still needs a tap), `review`, `draft`, `rules`, `settings`, `key`, `signin` (signed-out preview) |
| `LOJO_FOLDER` | `inbox`, `sent`, `drafts`, `trash`, `spam`, `archive` |
| `LOJO_THREAD` | a thread ID (default: first thread with an attachment) |
| `LOJO_DRAFT` | a draft ID (default: first open draft) |
| `LOJO_SEARCH` | a search query |
| `LOJO_COMPOSE_TO` | prefilled recipient |
| `LOJO_COMPOSE_SAMPLES` | `1`: Compose opens with a generated photo and a text file attached (memory only) |

Several iPhones on USB: every phone script needs `LOJO_PHONE` (`"14 Pro Max"`, `"11"`) or `LOJO_UDID`, and lists the
attached models if it is missing. `ios/scripts/retake-screenshots.sh [01 08 …]` retakes the README screenshots from
the installed build (launch only).

Verified on the iPhone 11 (iOS 26.6.2) by screenshot: sign-in, Inbox from the live API, a thread with its body
decrypted on the phone, an image attachment decrypted and shown in Quick Look, server search, Sent and Trash, a
trashed thread with "Trashed by you", compose, the send confirmation, the review queue, a queued draft, AI Rules with
both kill switches, Settings, and key setup.

## Tester pass for attachments and the interface (2026-09-30)

Built with `deploy-phone.sh --build`, core tests and `--live-write` green against the deployed API (the approval body
is unchanged when a draft has no files). **Not installed on a phone** (Jon installs), so the new screens were checked
by reading every view and flow, not on a device. Sign-in and key setup were retaken from the 14 Pro Max's installed
build, whose screens match this code. Defects found and fixed:

- With two iPhones attached, `deploy-phone.sh` installed on whichever USB listed first and `phone-shot.sh` let
  pymobiledevice3 choose; they now require `LOJO_PHONE` / `LOJO_UDID` when there is more than one.
- `phone-shot.sh` captured a black screen on a cold launch (6 s wait); the default is now 10 s.
- The 14 Pro Max writes 16-bit 1290 px PNGs; screenshots are now converted to 8-bit 828 px to match the rest.
- Teal text was 3.8:1 on dark grouped cards (under 4.5:1); the accent now has light and dark variants.
- Chip rows (thread, list, rules) clipped at large text sizes; they wrap now. The avatar and lock icon didn't scale.
  List rows at accessibility sizes now put the date under the sender.
- The thread stretched edge to edge on iPad landscape; it now has a readable width. iPad allows all orientations.
- Review: swipe to discard ignored failures silently; a draft without recipients showed a bare "To:".
- Settings: a changed server URL only applied from the keyboard's Return key; there's now a button. Settings also
  shows whether the server accepts attachments from the app.
- Compose: an attachment error appeared at the bottom of the form, far from the paperclip. Closing with "Save draft"
  silently dropped files the server can't store; the dialog now says so. A disabled Approve button didn't say why.
- Cancelling Save to Files could surface a "user cancelled" error.

Still to check on the phone after installing: the three pickers (the camera asks for permission the first time), the
size meter and the "too big" message with a large file, Share… and Save to Files on a received attachment, the
interface at the largest Dynamic Type size and with VoiceOver, and an iPad if one is handy.

## Not tested yet

- **The sign-in and key-import changes have not run on a phone yet** (built with `deploy-phone.sh --build` only):
  the eye toggle, password-manager fill from the Passwords button, AirDrop / share sheet / "Open in LOJO Mail" for a
  `.jwk` or `.json` file, the confirmation alert, and Choose from Files. To check: AirDrop `envelope.private.jwk` from
  the Mac, pick LOJO Mail, confirm the fingerprint matches Settings → Decryption.

- **Taps on the phone.** pymobiledevice3 can launch and screenshot but can't tap without a paid-account XCTest
  runner, so swipe actions, Undo, the Face ID lock, pull to refresh, the rewrite menu and pressing "Send now" were
  exercised through the API client (`--live-write`) and by reading the code, not by touch. Worth ten minutes of Jon
  tapping through.
- **Background refresh and notifications on a real schedule.** The code path is the same as the foreground poll, but
  iOS decides when to run it; not observed firing.
- **Offline**: the offline banner and cached lists weren't captured (needs airplane mode on the phone).
- **Reply/forward into real threads** (`threadId`/`inReplyTo`), **AI reply** and **AI rewrite** against the live
  LLM, and **PGP** modes other than auto.
- **HTML mail** renders as text (the app converts HTML to plain text when a message has no text part).
- **Large received attachments** (only a 70 KB vector and the one real image), and types Quick Look can't show.
- **OpenPGP-encrypted sends with files** live: `pgp: auto` encrypts only when the server holds an OpenPGP key for
  lojo-test@, which the API can't show or set, and today's approve-and-send doesn't say how a message went out (the
  Sent copy is always stored in the clear). lojo-mail PR "approve-and-send reports how the message was encrypted"
  adds `encryption` to the response; the app shows it after Send, and the live test checks it once that is deployed. PGP/MIME with files is covered by the server's own tests (lojo-mail PR #10).
- Dynamic Type at the largest accessibility sizes, and VoiceOver end to end, on a device.
