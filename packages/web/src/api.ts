const TOKEN_KEY = "lojo-mail-token";

export function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? "dev-only-change-me";
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${getToken()}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text || response.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // keep the raw body
    }
    throw new ApiError(message, response.status);
  }
  return (text ? JSON.parse(text) : null) as T;
}
