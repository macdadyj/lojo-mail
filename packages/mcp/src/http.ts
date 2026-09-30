import { knownScope, type Scope } from "./scopes.ts";
import type { AgentFolder, DraftRequest, MailClient } from "./tools.ts";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Talks to the API with an API token, so every call is an agent call: no approvals, no trash, no full export. */
export class HttpMailClient implements MailClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        message = text;
      }
      throw new Error(message || `HTTP ${response.status}`);
    }
    if (!text) return null;
    return JSON.parse(text) as unknown;
  }

  private id(value: string): string {
    return encodeURIComponent(value);
  }

  /** Who the API thinks this token is. */
  async session(): Promise<{ kind: string; label: string; scopes: Scope[] }> {
    const payload = (await this.request("GET", "/v1/session")) as { kind?: string; label?: string; scopes?: string[] };
    return { kind: payload.kind ?? "token", label: payload.label ?? "", scopes: (payload.scopes ?? []).flatMap((scope) => knownScope(scope) ?? []) };
  }

  async search(query: string, mode: "keyword" | "semantic", includeContext: boolean): Promise<unknown> {
    const payload = (await this.request("POST", "/v1/search", { query, mode, context: includeContext })) as { messages: unknown };
    return payload.messages;
  }

  readThread(threadId: string, includeContext: boolean): Promise<unknown> {
    return this.request("GET", `/v1/threads/${this.id(threadId)}${includeContext ? "?context=1" : ""}`);
  }

  async triage(limit: number): Promise<unknown> {
    const payload = (await this.request("GET", "/v1/triage")) as { messages: unknown };
    return Array.isArray(payload.messages) ? payload.messages.slice(0, limit) : payload.messages;
  }

  async listInbox(limit: number): Promise<unknown> {
    const payload = (await this.request("GET", "/v1/inbox")) as { messages: unknown };
    return Array.isArray(payload.messages) ? payload.messages.slice(0, limit) : payload.messages;
  }

  async summarizeThread(threadId: string): Promise<string> {
    const payload = (await this.request("POST", `/v1/threads/${this.id(threadId)}/summarize`)) as { summary?: string };
    return payload.summary ?? "";
  }

  draftReply(messageId: string): Promise<unknown> {
    return this.request("POST", `/v1/messages/${this.id(messageId)}/draft-reply`);
  }

  createDraft(input: DraftRequest): Promise<unknown> {
    return this.request("POST", "/v1/drafts", input);
  }

  submitForApproval(draftId: string): Promise<unknown> {
    return this.request("POST", `/v1/drafts/${this.id(draftId)}/submit`);
  }

  setLabels(messageId: string, labels: string[]): Promise<unknown> {
    return this.request("POST", `/v1/messages/${this.id(messageId)}/labels`, { labels });
  }

  archive(messageId: string): Promise<unknown> {
    return this.request("POST", `/v1/messages/${this.id(messageId)}/archive`);
  }

  move(messageId: string, folder: AgentFolder): Promise<unknown> {
    return this.request("POST", `/v1/messages/${this.id(messageId)}/move`, { folder });
  }

  async actionItems(): Promise<unknown> {
    const payload = (await this.request("GET", "/v1/action-items")) as { items: unknown };
    return payload.items;
  }

  exportIndex(): Promise<unknown> {
    return this.request("GET", "/v1/export/index");
  }
}
