# LOJO Mail iOS: architecture

## Targets

```text
ios/App                      xtool project (Package.swift + xtool.yml + Info.plist)
  Sources/LojoMailCore       Foundation + CryptoKit only; also builds on Linux (swift-crypto) for tests
    Envelope.swift           open the P-256 ECDH + HKDF-SHA256 + AES-256-GCM envelopes; JWK import and fingerprint
    APIClient.swift          every HTTP call the app makes; error mapping
    Models.swift             Codable mirrors of the API's JSON
    Conversation.swift       thread grouping, reply/forward text helpers, HTML-to-text fallback
  Sources/LojoMail           SwiftUI app
    Model/AppModel.swift     @Observable @MainActor state: session, key, folders, bodies, drafts, rules, settings
    Model/ComposeModel.swift one compose/review sheet: save, queue, rewrite, approve-and-send
    Services/                Keychain, metadata cache, temp attachment files, notifications + BG refresh, USB provisioning
    Views/                   RootView (tabs + lock), Mailbox, Thread, Compose, Review, Rules, Settings, Sign in, Key setup
    Design/Theme.swift       colours, chips, banners, toasts, empty states
ios/CoreTests                SwiftPM package that symlinks LojoMailCore and tests it on Linux
ios/scripts                  deploy, provision, screenshot, test, icon
```

`LojoMailCore` has no UIKit/SwiftUI so the crypto and the API contract are tested on Santa Computa without a
simulator. `CoreTests/make-vectors.ts` seals fresh test envelopes with `packages/core/src/envelope.ts`, so the Swift
opener is checked against the real TypeScript sealer, not against itself.

## Data flow

1. **Sign in**: `POST /v1/session/login {passphrase}` returns a 12-hour `hs_` human session. It goes into the
   Keychain. With "Keep me signed in", the passphrase is stored too and the app renews the session silently on 401.
2. **List**: `GET /v1/folders/:folder/messages` gives metadata (from, subject, snippet, flags, AI labels). A copy of
   that metadata, never bodies, is cached per folder so the app opens instantly and works offline.
3. **Read**: `GET /v1/threads/:id` (marks read), then `GET /v1/messages/:id/body` per message. The sealed envelope is
   opened with the key and AAD `lojo-mail:message:<id>:body`. Plaintext stays in memory only.
4. **Attachments**: `GET /v1/messages/:id/attachments/:attId` returns an envelope, a presigned S3 URL to one, or plain
   bytes. The app opens it with AAD `lojo-mail:message:<id>:attachment:<attId>`, writes a temp file, shows Quick Look,
   and deletes it on close.
5. **Actions**: `/flags`, `/labels` (star is the `flagged` label), `/archive`, `/move`, `/restore`. Optimistic in the
   UI with an Undo toast; rolled back on error.
6. **Drafts**: `POST /v1/drafts`, `POST /v1/drafts/:id`, `/rewrite`, `/submit`, `/discard`, `/v1/messages/:id/draft-reply`
   (the app sends the decrypted source text, because the API cannot open bodies).
7. **Send**: `POST /v1/drafts/:id/approval` with exactly what Jon reviewed (to, cc, subject, text, pgp). The server
   answers 409 if the stored draft differs, else a one-time token; `POST /v1/drafts/:id/approve-and-send {approvalToken}`.
8. **Rules**: `GET /v1/rules`, `POST /v1/rules/switches {paused, killSwitch, sendKillSwitch}`, `POST /v1/rules/:id/disable`.

## Alignment with the direct-send work (PR #7)

PR #7 added `POST /v1/client/send`, but it is **bridge-only** (`client-send` scope, for Thunderbird on Santa Computa)
and deliberately not callable with a human session. That is the right call for a phone: the app keeps using the
approval flow above, which is the one path that binds a send to content a human saw. What the app picked up from PR #7:

- `sendKillSwitch` in the rules document: shown as **Stop all sending**, engage instantly, release with a confirm;
  compose shows a red notice and disables Approve and send while it is on.
- `trashedBy` can be `human`, `bridge` or `agent:<label>`; a trashed thread says "Trashed by you / from Thunderbird /
  by agent X".
- `rate_limited` maps to HTTP 429, shown as "try again in N s".

## API behaviour the app works around

- The mutation routes (`/flags`, `/labels`, `/archive`, `/move`, `/restore`) answer with the **stored record**, not the
  presented `Message` (no `locked`; internal keys like `bodyKey`, `aiContextKey`, `deliveryId`). The app ignores those
  bodies. Worth fixing on the server: return `mailbox.present(...)` like `GET /v1/messages/:id` does, and stop exposing
  internal keys.
- `/submit` and `/discard` return the draft **without text**; the compose screen keeps its own copy of the body.

## Background refresh and notifications

`BGAppRefreshTask` (`com.lojo.Mail.refresh`, requested 15 minutes out whenever the app backgrounds) fetches the Inbox
metadata, compares IDs with the ones already seen, posts a local notification per new message (sender, and the
subject only if Jon allows it in Settings), and updates the badge. A tap opens that thread. The first run only seeds
the seen set, so installing never floods the lock screen. When the app is open it polls every 60 seconds instead.
