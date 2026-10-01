# Attachments on drafts: the API change the app needs

**Status:** proposed. The iOS app already speaks this contract and turns it on by itself when `/v1/settings` says
the server supports it. Until then Compose lets you pick files but won't send or queue a draft that has any.

## Why today's API can't send attachments from the app

- A draft is text only: `Draft.sealed` holds the KMS-sealed body text, and nothing else
  (`packages/core/src/types.ts`).
- The approval binds `from, to, cc, subject, text, inReplyTo, pgp` (`approvalContentHash` in
  `packages/core/src/approval.ts`). Nothing names files, so an approval can't cover them.
- `OutboundMessage` (`packages/core/src/send.ts`) has no attachments, so `approveAndSend` can't send any.
- The only path that carries files is the bridge's `client-send` scope (Thunderbird): a raw RFC 5322 message
  of up to `DEFAULT_CLIENT_SEND_LIMITS.maxBytes` = 4,000,000 bytes, with no approval token. A human session
  token can't use it, and it shouldn't: the app sends through the approval flow.

## Proposed contract

### Capability

`GET /v1/settings` adds:

```json
"draftAttachments": { "maxMessageBytes": 4000000, "maxFiles": 10 }
```

The field is absent on servers without this change. `maxMessageBytes` is the whole encoded message, the same
limit as `client-send`, so Thunderbird and the app agree.

### Add a file

`POST /v1/drafts/:id/attachments` (scope `write`, draft must be editable)

```json
{ "filename": "Photo 2026-09-30 1.jpg", "contentType": "image/jpeg", "sha256": "<hex>", "data": "<base64>" }
```

- One file per request, so each body stays far under Lambda's 6 MB synchronous payload limit (4 MB of
  file is 5.4 MB as base64).
- The server checks `sha256` against the decoded bytes (400 on mismatch), cleans the filename (no path, no
  control characters), and refuses with 413 if the encoded message would go over `maxMessageBytes`, or 400
  past `maxFiles`.
- It stores the bytes sealed like the draft text (`sealDraftText` in `mailbox.ts`): a KMS data key under
  `{ purpose: "draft-attachment", draftId, attachmentId }`, in the blob store next to message attachments.
- It sets `lastEditedBy` like any edit and clears an existing approval: adding a file changes what will be sent.
- It responds with the `DraftView`, where `draft.attachments` is
  `[{ "id", "filename", "contentType", "size", "sha256" }]`.

### Remove a file

`POST /v1/drafts/:id/attachments/:attId/remove` (scope `write`) deletes the sealed blob and responds with the
`DraftView`. A POST verb, like `/submit` and `/discard`.

### Approval

`POST /v1/drafts/:id/approval` takes an optional `"attachments": ["<sha256>", ...]` in the reviewed fields.
`approvalContentHash` appends the list of `[sha256, filename, contentType]` in draft order (an empty list keeps
today's hashes valid). If the reviewed list doesn't match the draft's, the server responds 409 like any other
changed field. The app sends `attachments` only when there are some, so it keeps working with today's server.

### Send

`approveAndSend` unseals the files, re-checks the hash, and builds `multipart/mixed`: the text part, then each
file as base64 with `Content-Disposition: attachment; filename*=UTF-8''…`. `OutboundMessage` gains
`attachments?: { filename, contentType, data }[]`. With OpenPGP the whole MIME tree is encrypted
(PGP/MIME), so the files are encrypted too. After sending, the sealed draft files follow the draft's retention.

### Who can add files

Bots can add files too (scope `write`), but the approval stays human-only. Jon sees every file, with its name
and size, in the app's Review screen before he approves, and the approval hash covers them.

### Forwarding

The server can't open an attachment that is sealed to Jon's envelope key, so the app decrypts the original
attachments on the phone and uploads them as ordinary draft files. No forwarding endpoint is needed.

## Client side (already in this PR)

- `LojoMailCore/Attachments.swift`: `OutgoingAttachment` (in memory, SHA-256, cleaned filename) and
  `AttachmentBudget` (base64 with CRLF every 76 characters, plus headers, against `maxMessageBytes`).
- `APIClient.addDraftAttachment` / `removeDraftAttachment`, and `DraftFields.attachments` in the approval body.
- `ComposeModel.save()` uploads pending files after the text and before approving; the reviewed list is the
  SHA-256 of every file Jon saw.
- Tests in `CoreTests/Tests/LojoMailCoreTests/AttachmentTests.swift`, including "no `attachments` member when
  there are none" so today's server keeps accepting approvals.
