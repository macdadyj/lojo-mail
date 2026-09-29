import type { Session } from "./types.ts";

const SESSION_KEY = "lojo-mail-session";
const API_URL_KEY = "lojo-mail-api-url";
export const SIGNED_OUT_EVENT = "lojo:signed-out";

/** Empty means same origin, which is what the dev proxy serves. */
export function builtApiUrl(): string {
  return trimSlash(import.meta.env.VITE_LOJO_API_URL ?? "");
}

export function apiUrlOverride(): string | null {
  return localStorage.getItem(API_URL_KEY);
}

export function setApiUrlOverride(url: string | null): void {
  const next = url?.trim();
  if (next) {
    const parsed = new URL(next);
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw new Error("The API URL must be https, or http on 127.0.0.1 or localhost.");
    }
    localStorage.setItem(API_URL_KEY, trimSlash(parsed.origin + parsed.pathname));
  } else {
    localStorage.removeItem(API_URL_KEY);
  }
}

export function apiUrl(): string {
  return apiUrlOverride() ?? builtApiUrl();
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function sessionToken(): string | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Session;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session.sessionToken;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function signOut(): void {
  sessionStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function login(passphrase: string): Promise<void> {
  const session = await api<Session>("/v1/session/login", {
    method: "POST",
    body: JSON.stringify({ passphrase }),
  });
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function raw(path: string, init?: RequestInit): Promise<Response> {
  const token = sessionToken();
  const response = await fetch(`${apiUrl()}${path}`, {
    ...init,
    credentials: "omit",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 401 && token) signOut();
  if (!response.ok) {
    const text = await response.text();
    let message = text || response.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // keep the raw body
    }
    throw new ApiError(message, response.status);
  }
  return response;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await raw(path, init);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}
