import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_BYTES = 32;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export function generateAppPassword(): string {
  return randomBytes(24).toString("base64url");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const N = Number(n);
  const expected = Buffer.from(hash, "base64url");
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || expected.length !== KEY_BYTES) return false;
  const key = await derive(password, Buffer.from(salt, "base64url"), { N, r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 });
  return timingSafeEqual(key, expected);
}

export type LoginOutcome = "ok" | "bad" | "locked";

export interface LoginGuardOptions {
  maxFailures?: number;
  lockMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
}

/**
 * One guard per process, shared by IMAP and SMTP. Every failure slows the next
 * answer exponentially; after `maxFailures` in a row the bridge refuses every
 * login, right or wrong, until the lock expires.
 */
export class LoginGuard {
  private failures = 0;
  private lockedUntil = 0;
  private readonly maxFailures: number;
  private readonly lockMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;

  constructor(
    private readonly address: string,
    private readonly passwordHash: string,
    options: LoginGuardOptions = {},
  ) {
    this.maxFailures = options.maxFailures ?? 10;
    this.lockMs = options.lockMs ?? 15 * 60_000;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 8_000;
    this.now = options.now ?? Date.now;
  }

  async attempt(username: string, password: string): Promise<LoginOutcome> {
    if (this.now() < this.lockedUntil) return "locked";
    const userOk = username.trim().toLowerCase() === this.address.toLowerCase();
    const passwordOk = await verifyPassword(password, this.passwordHash);
    if (userOk && passwordOk) {
      this.failures = 0;
      return "ok";
    }
    this.failures += 1;
    if (this.failures >= this.maxFailures) {
      this.lockedUntil = this.now() + this.lockMs;
      this.failures = 0;
    }
    const delay = Math.min(this.baseDelayMs * 2 ** Math.min(this.failures, 16), this.maxDelayMs);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return "bad";
  }
}
