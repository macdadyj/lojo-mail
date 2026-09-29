import type { Folder } from "@lojo/core";
import type { MailClient } from "./tools.ts";

export class HttpMailClient implements MailClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
    if (!text) return null;
    return JSON.parse(text) as unknown;
  }

  async search(query: string, mode?: "keyword" | "semantic"): Promise<unknown> {
    const payload = (await this.request("POST", "/v1/search", { query, mode })) as { messages: unknown };
    return payload.messages;
  }

  readThread(threadId: string): Promise<unknown> {
    return this.request("GET", `/v1/threads/${encodeURIComponent(threadId)}`);
  }

  async triage(limit?: number): Promise<unknown> {
    const payload = (await this.request("GET", "/v1/triage")) as { messages: unknown };
    return Array.isArray(payload.messages) ? payload.messages.slice(0, limit ?? 50) : payload.messages;
  }

  async listInbox(limit?: number): Promise<unknown> {
    const payload = (await this.request("GET", "/v1/inbox")) as { messages: unknown };
    return Array.isArray(payload.messages) ? payload.messages.slice(0, limit ?? 50) : payload.messages;
  }

  async summarizeThread(threadId: string): Promise<string> {
    const payload = (await this.request("POST", `/v1/threads/${encodeURIComponent(threadId)}/summarize`)) as { summary?: string };
    return payload.summary ?? "";
  }

  draftReply(messageId: string): Promise<unknown> {
    return this.request("POST", `/v1/messages/${encodeURIComponent(messageId)}/draft-reply`);
  }

  createDraft(input: { to: string[]; cc?: string[]; subject: string; text: string; threadId?: string }): Promise<unknown> {
    return this.request("POST", "/v1/drafts", input);
  }

  approveAndSend(draftId: string): Promise<{ messageId: string }> {
    return this.request("POST", `/v1/drafts/${encodeURIComponent(draftId)}/approve-and-send`) as Promise<{ messageId: string }>;
  }

  setLabels(messageId: string, labels: string[]): Promise<unknown> {
    return this.request("POST", `/v1/messages/${encodeURIComponent(messageId)}/labels`, { labels });
  }

  archive(messageId: string): Promise<unknown> {
    return this.request("POST", `/v1/messages/${encodeURIComponent(messageId)}/archive`);
  }

  move(messageId: string, folder: Folder): Promise<unknown> {
    return this.request("POST", `/v1/messages/${encodeURIComponent(messageId)}/move`, { folder });
  }

  async actionItems(): Promise<unknown> {
    const payload = (await this.request("GET", "/v1/action-items")) as { items: unknown };
    return payload.items;
  }

  async exportAll(): Promise<string> {
    const payload = await this.request("GET", "/v1/export");
    return JSON.stringify(payload);
  }
}
