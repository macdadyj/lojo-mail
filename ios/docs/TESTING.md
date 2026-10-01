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
- **`--live-write` (3)**: through the same `APIClient` the app uses, on mail from `lojo-test@cyberphysical.us` only:
  - unread, star, archive and move back, trash (checks `trashedBy`, `keepUntil`, listed in Trash) and restore, then
    search finds it;
  - engages the send kill switch and checks approve-and-send is refused, toggles the rules kill switch and pause,
    and restores all three to what they were;
  - creates a draft, edits it, queues it, checks a mismatched approval gets 409, then approves and sends **one real
    message to lojo-test@cyberphysical.us**.

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

Verified on the iPhone 11 (iOS 26.6.2) by screenshot: sign-in, Inbox from the live API, a thread with its body
decrypted on the phone, an image attachment decrypted and shown in Quick Look, server search, Sent and Trash, a
trashed thread with "Trashed by you", compose, the send confirmation, the review queue, a queued draft, AI Rules with
both kill switches, Settings, and key setup.

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
- **Large attachments** (only a 70 KB vector and the one real image), and attachment types Quick Look can't show.
- Dynamic Type at the largest accessibility sizes, and VoiceOver end to end.
