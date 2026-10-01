# Draft attachments: how the app uses the API

**Status:** live. The server side is lojo-mail PR #10 (`packages/core/src/draft-attachments.ts`,
`packages/api/src/app.ts`), deployed on AWS.

## Capability

`GET /v1/settings` returns `draftAttachments: { maxMessageBytes: 4000000, maxFiles: 10 }`. The app re-reads settings
on launch, after sign-in, every time it returns to the foreground, when Compose opens, when Settings opens, and right
before it saves a draft that has new files. A failed fetch keeps the last answer; an earlier "not supported" is never
reused. If the server really lacks the field, saving says so and names the server URL to check.

## Flow (the same for every encryption mode)

1. Save the text: `POST /v1/drafts` or `PATCH /v1/drafts/:id`.
2. Upload each new file, one request each, in the order shown in Compose:
   `POST /v1/drafts/:id/attachments { filename, contentType, sha256, data }`, with `sha256` the hex SHA-256 of
   the bytes and `data` base64. The answer is the draft with `attachments: [{ id, filename, contentType, size, sha256 }]`
   in draft order. Each upload clears any pending approval.
3. Remove a file already on the draft: `POST /v1/drafts/:id/attachments/:attId/remove`.
4. Approve: `POST /v1/drafts/:id/approval` with the reviewed `to/cc/subject/text/pgp` and
   `attachments: [sha256, …]` in draft order (files already on the draft, then the ones just uploaded:
   `DraftFields.reviewedAttachments`). The list is omitted when there are no files. A different list, order, or any
   other change is a 409; the app shows what changed.
5. `POST /v1/drafts/:id/approve-and-send { approvalToken }`. With `pgp: off`, or when a recipient has no key under
   `auto`, the server sends `multipart/mixed` over TLS. With OpenPGP it encrypts the whole MIME tree, files
   included, as PGP/MIME. The app sends the same requests in both cases.

## Limits and errors

| Case | Server | App |
| --- | --- | --- |
| Message over 4,000,000 bytes encoded | 413 `too_large` | Refused before upload by `AttachmentBudget` (same arithmetic as `estimatedMessageBytes`); a 413 shows "Too large to send: … Remove a file or send a smaller one." |
| More than 10 files | 400 | Refused when picking; a 400 shows the server's message |
| Hash doesn't match the bytes | 400 | Shown next to the file, which stays in Compose |
| Upload fails part way | — | Files already uploaded stay on the draft; the failed one and later ones stay in Compose to retry or remove |
