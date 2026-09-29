import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MIN_PASSPHRASE_LENGTH = 12;
/** Local dev only. `sessionsFromEnv` refuses it in production. */
export const DEV_PASSPHRASE = "lojo-dev-passphrase";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const LOCKOUT_FAILURES = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

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

/** Per container. Five failures inside 15 minutes lock sign-in for 15 minutes. */
export class LoginLimiter {
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  check(): void {
    const now = this.now();
    if (now < this.lockedUntil) throw new LoginRateLimited(Math.ceil((this.lockedUntil - now) / 1000));
  }

  fail(): void {
    const now = this.now();
    this.failures = [...this.failures.filter((at) => now - at < LOCKOUT_WINDOW_MS), now];
    if (this.failures.length >= LOCKOUT_FAILURES) {
      this.lockedUntil = now + LOCKOUT_WINDOW_MS;
      this.failures = [];
    }
  }

  succeed(): void {
    this.failures = [];
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
  /** Pass one in when Sessions is rebuilt on a config refresh, so failures keep counting. */
  limiter?: LoginLimiter;
}

export class Sessions {
  private readonly limiter: LoginLimiter;
  private readonly now: () => number;

  constructor(private readonly options: SessionOptions) {
    if (options.secret.byteLength < 32) throw new Error("Session secret must be at least 32 bytes");
    this.now = options.now ?? Date.now;
    this.limiter = options.limiter ?? new LoginLimiter(this.now);
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.options.secret).update(payload).digest("base64url");
  }

  login(passphrase: string): { sessionToken: string; expiresAt: string } {
    this.limiter.check();
    if (!passphrase || !verifyPassphrase(passphrase, this.options.passphraseHash)) {
      this.limiter.fail();
      throw new Error("Wrong passphrase");
    }
    this.limiter.succeed();
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
