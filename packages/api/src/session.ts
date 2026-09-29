import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { MailStore } from "@lojo/core";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MIN_PASSPHRASE_LENGTH = 12;
/** Local dev only. `sessionsFromEnv` refuses it in production. */
export const DEV_PASSPHRASE = "lojo-dev-passphrase";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
export const LOGIN_FAILURES_PER_SOURCE = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** `scrypt$N$r$p$salt$hash`, base64url. What `npm run passphrase-hash` stores in SSM. */
export function hashPassphrase(passphrase: string, salt: Buffer = randomBytes(16)): string {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const hash = scryptSync(passphrase, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export function verifyPassphrase(passphrase: string, stored: string): boolean {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !n || !r || !p || !salt || !hash) throw new Error("Unrecognised passphrase hash");
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(passphrase, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class LoginRateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many failed sign-ins. Try again later.");
  }
}

/**
 * The throttle key for a caller. IPv6 callers are grouped by /64, because one
 * host usually controls a whole /64. Unparseable input shares one "unknown" key.
 */
export function sourceKey(address: string | undefined): string {
  const bare = (address ?? "").trim().replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped?.[1]) return mapped[1];
  if (isIPv4(bare)) return bare;
  if (!isIPv6(bare)) return "unknown";
  const [head = "", tail = ""] = bare.split("::");
  const left = head ? head.split(":") : [];
  const right = bare.includes("::") && tail ? tail.split(":") : [];
  const groups = bare.includes("::") ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * Failed sign-ins are counted per source in a store every container shares, in
 * fixed 15-minute windows. A source over the limit gets 429 until its window
 * ends. There is no global lockout, so nobody can lock Jon out from elsewhere;
 * distributed guessing is bounded by API Gateway throttling and scrypt, and
 * shows up in the login-failure alarm (see `onFailure`).
 */
export class LoginThrottle {
  constructor(
    private readonly counters: Pick<MailStore, "getCounter" | "bumpCounter">,
    private readonly options: { now?: () => number; onFailure?: (source: string) => void } = {},
  ) {}

  private window(source: string): { key: string; end: number } {
    const now = this.options.now ? this.options.now() : Date.now();
    const start = now - (now % LOGIN_WINDOW_MS);
    const hashed = createHash("sha256").update(source).digest("hex").slice(0, 32);
    return { key: `login-failures:${hashed}:${start}`, end: start + LOGIN_WINDOW_MS };
  }

  async check(source: string): Promise<void> {
    const { key, end } = this.window(source);
    if ((await this.counters.getCounter(key)) < LOGIN_FAILURES_PER_SOURCE) return;
    const now = this.options.now ? this.options.now() : Date.now();
    throw new LoginRateLimited(Math.max(1, Math.ceil((end - now) / 1000)));
  }

  async fail(source: string): Promise<void> {
    const { key, end } = this.window(source);
    await this.counters.bumpCounter(key, new Date(end + LOGIN_WINDOW_MS));
    this.options.onFailure?.(source);
  }
}

interface SessionPayload {
  sub: "jon";
  iat: number;
  exp: number;
}

export interface SessionOptions {
  secret: Uint8Array;
  passphraseHash: string;
  now?: () => number;
}

/** Passphrase check and stateless session tokens. Throttling is `LoginThrottle`, in front of this. */
export class Sessions {
  private readonly now: () => number;

  constructor(private readonly options: SessionOptions) {
    if (options.secret.byteLength < 32) throw new Error("Session secret must be at least 32 bytes");
    this.now = options.now ?? Date.now;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.options.secret).update(payload).digest("base64url");
  }

  login(passphrase: string): { sessionToken: string; expiresAt: string } {
    if (!passphrase || !verifyPassphrase(passphrase, this.options.passphraseHash)) throw new Error("Wrong passphrase");
    const iat = this.now();
    const body: SessionPayload = { sub: "jon", iat, exp: iat + SESSION_TTL_MS };
    const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
    return { sessionToken: `hs_${payload}.${this.sign(payload)}`, expiresAt: new Date(body.exp).toISOString() };
  }

  verify(token: string): boolean {
    if (!token.startsWith("hs_")) return false;
    const [payload, mac] = token.slice(3).split(".");
    if (!payload || !mac) return false;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    try {
      const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SessionPayload>;
      return body.sub === "jon" && typeof body.exp === "number" && body.exp > this.now();
    } catch {
      return false;
    }
  }
}

/** Local dev: passphrase from LOJO_HUMAN_PASSPHRASE (or the dev default), random secret per process. */
export function devSessions(env: NodeJS.ProcessEnv, production: boolean): Sessions {
  const passphrase = env.LOJO_HUMAN_PASSPHRASE ?? DEV_PASSPHRASE;
  if (production && passphrase === DEV_PASSPHRASE) {
    throw new Error("Refusing the dev passphrase in production. Set LOJO_HUMAN_PASSPHRASE.");
  }
  return new Sessions({ secret: randomBytes(32), passphraseHash: hashPassphrase(passphrase) });
}
