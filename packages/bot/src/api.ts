export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The lojo-mail REST API with one bearer. Errors carry the API's message and status, never the credential. */
export class BotApi {
  constructor(
    private readonly baseUrl: string,
    private readonly bearer: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const message = (parsed as { error?: unknown } | null)?.error;
      throw new ApiError(`${method} ${path.split("?")[0]}: ${response.status} ${typeof message === "string" ? message : "error"}`, response.status);
    }
    return parsed as T;
  }

  get<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  put<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
}

export function id(value: string): string {
  return encodeURIComponent(value);
}
