import { botBodyContext, generateIdentity, keyFingerprint, openJson, type BotBody, type EcPrivateJwk, type EcPublicJwk, type EnvelopeBlob } from "@lojo/core";
import { BotConfigError } from "./config.ts";

export function parsePrivateJwk(raw: string, what: string): EcPrivateJwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BotConfigError(`${what} is not JSON`);
  }
  const jwk = (parsed ?? {}) as Partial<EcPrivateJwk>;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || typeof jwk.d !== "string") {
    throw new BotConfigError(`${what} must be a P-256 EC private JWK`);
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d };
}

export function publicOf(jwk: EcPrivateJwk): EcPublicJwk {
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

export async function newBotKey(): Promise<{ privateJwk: EcPrivateJwk; publicJwk: EcPublicJwk; keyId: string }> {
  const { privateJwk } = await generateIdentity();
  const publicJwk = publicOf(privateJwk);
  return { privateJwk: { ...publicJwk, d: privateJwk.d }, publicJwk, keyId: await keyFingerprint(publicJwk) };
}

/** The bot key loaded on Santa, with the id the API knows it by. */
export interface LoadedBotKey {
  privateJwk: EcPrivateJwk;
  keyId: string;
}

export async function loadedKey(privateJwk: EcPrivateJwk): Promise<LoadedBotKey> {
  return { privateJwk, keyId: await keyFingerprint(privateJwk) };
}

export async function openBotCopy(key: LoadedBotKey, messageId: string, keyId: string, envelope: EnvelopeBlob): Promise<BotBody> {
  if (keyId !== key.keyId) throw new BotConfigError(`The API's bot key is ${keyId}, but this bot holds ${key.keyId}. Ask Jon to register this key, or load the right one.`);
  return openJson<BotBody>(envelope, key.privateJwk, botBodyContext(messageId, keyId));
}
