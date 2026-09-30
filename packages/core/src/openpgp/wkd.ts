import { createHash } from "node:crypto";

const ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";

export function zBase32Encode(data: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let out = "";
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}

/** WKD local-part hash: z-base32(SHA-1(lowercase local-part)). */
export function wkdLocalPartHash(localPart: string): string {
  const digest = createHash("sha1").update(localPart.trim().toLowerCase()).digest();
  return zBase32Encode(new Uint8Array(digest));
}

export function wkdAdvancedUrl(domain: string, localPart: string): string {
  const hash = wkdLocalPartHash(localPart);
  return `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hash}`;
}
