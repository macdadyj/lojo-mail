export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * POSTs JSON and returns the parsed reply. The timeout matters in Lambda: an
 * unreachable host (a tailnet address, say) would otherwise hold the function
 * until its own timeout. Error text never includes the response body, which
 * can echo the prompt.
 */
export async function postJson<T>(
  provider: string,
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<{ ok: true; value: T } | { ok: false; status: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, status: response.status };
  }
  try {
    return { ok: true, value: (await response.json()) as T };
  } catch {
    throw new Error(`${provider} returned a non-JSON response`);
  }
}

export async function postJsonOrThrow<T>(
  provider: string,
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<T> {
  const result = await postJson<T>(provider, url, body, opts);
  if (!result.ok) throw new Error(`${provider} request failed (${result.status})`);
  return result.value;
}
