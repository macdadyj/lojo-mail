# Envelope and OpenPGP keys

This directory is gitignored except for this file. Do not commit a private key, a `.pem`, or an armored secret key. CI rejects those patterns if they show up anywhere in the tree.

## Envelope key (required)

The processor seals every body to a P-256 public key. Generate it locally:

```bash
npm run keygen -- --out ./keys
```

- `keys/envelope.public.jwk` goes to SSM parameter `/lojo-mail/envelope-public-jwk` (see `docs/RUNBOOK.md`). It is not a secret, but it is also not useful to publish widely.
- `keys/envelope.private.jwk` stays in your password manager. The API and the Lambdas must not have it. Losing it means losing sealed bodies after raw-MIME retention expires. Reprocessing `raw/` can reseal to a new public key while those objects still exist.

## OpenPGP (optional)

```bash
gpg --quick-generate-key "Jon Hebert <lojo@cyberphysical.us>" ed25519 cert 2y
gpg --export --armor lojo@cyberphysical.us > keys/lojo-public.asc
```

Publish the **public** key via WKD. The path is:

```text
https://openpgpkey.cyberphysical.us/.well-known/openpgpkey/cyberphysical.us/hu/<z-base32 SHA-1 of "lojo">
```

`npm run wkd-hash -- lojo` prints the hash. Put the binary (or ASCII-armored, if your server is configured for it) key at that URL. Do not export the private key into this repo. Outbound signing uses the private key only in the session that sends.
