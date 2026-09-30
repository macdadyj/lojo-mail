import type { DraftView, EnvelopeBlob, Folder, MessageView } from "@lojo/core";
import { decodeEnvelope } from "@lojo/core/crypto";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SessionInfo {
  kind: string;
  label: string;
  scopes: string[];
  /** Addresses Jon may send as. Older APIs omit it; the bridge then allows its own address only. */
  sendFrom?: string[];
}

export interface ClientSendRequest {
  raw: Uint8Array;
  envelopeFrom: string;
  recipients: string[];
}

export interface ClientSendReply {
  messageId: string;
  sentId: string | null;
  bcc: number;
  draftId: string | null;
  draftUnchanged: boolean | null;
}

export type AttachmentPayload = { kind: "bytes"; bytes: Uint8Array } | { kind: "envelope"; envelope: EnvelopeBlob };

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  /** Presigned blob URLs point at S3, not the API, and must not carry the bearer token. */
  blobFetch?: FetchLike;
  timeoutMs?: number;
}

export interface DraftRequest {
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  threadId?: string;
  clientMessageId?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ApiClient {
  private readonly fetch: FetchLike;
  private readonly blobFetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: ApiClientOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.blobFetch = options.blobFetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(`The lojo-mail API did not answer ${method} ${path.split("?")[0]}`, 0);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const parsed: unknown = await res.json();
        if (isObject(parsed) && typeof parsed.error === "string") detail = parsed.error.slice(0, 200);
      } catch {
        detail = "";
      }
      throw new ApiError(detail || `HTTP ${res.status}`, res.status);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    return (await res.json()) as T;
  }

  session(): Promise<SessionInfo> {
    return this.json<SessionInfo>("GET", "/v1/session");
  }

  async listFolder(folder: Folder, limit: number): Promise<MessageView[]> {
    const out = await this.json<{ messages: MessageView[] }>("GET", `/v1/folders/${folder}/messages?limit=${limit}`);
    return out.messages;
  }

  message(id: string): Promise<MessageView> {
    return this.json<MessageView>("GET", `/v1/messages/${encodeURIComponent(id)}`);
  }

  async bodyEnvelope(id: string): Promise<EnvelopeBlob> {
    const out = await this.json<{ envelope: EnvelopeBlob }>("GET", `/v1/messages/${encodeURIComponent(id)}/body`);
    return out.envelope;
  }

  async attachment(id: string, attachmentId: string): Promise<AttachmentPayload> {
    const res = await this.raw("GET", `/v1/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`);
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
      return { kind: "bytes", bytes: new Uint8Array(await res.arrayBuffer()) };
    }
    const payload: unknown = await res.json();
    if (isObject(payload) && isObject(payload.envelope)) return { kind: "envelope", envelope: payload.envelope as unknown as EnvelopeBlob };
    if (isObject(payload) && typeof payload.url === "string") {
      let blob: Response;
      try {
        blob = await this.blobFetch(payload.url, { method: "GET", signal: AbortSignal.timeout(this.timeoutMs) });
      } catch {
        throw new ApiError("The attachment download did not answer", 0);
      }
      if (!blob.ok) throw new ApiError(`Attachment download failed with HTTP ${blob.status}`, blob.status);
      return { kind: "envelope", envelope: decodeEnvelope(new Uint8Array(await blob.arrayBuffer())) };
    }
    throw new ApiError("Unexpected attachment response", 502);
  }

  async setUnread(id: string, unread: boolean): Promise<void> {
    await this.json("POST", `/v1/messages/${encodeURIComponent(id)}/flags`, { unread });
  }

  async setLabels(id: string, labels: string[]): Promise<void> {
    await this.json("POST", `/v1/messages/${encodeURIComponent(id)}/labels`, { labels });
  }

  async archive(id: string): Promise<void> {
    await this.json("POST", `/v1/messages/${encodeURIComponent(id)}/archive`);
  }

  async move(id: string, folder: Folder): Promise<void> {
    await this.json("POST", `/v1/messages/${encodeURIComponent(id)}/move`, { folder });
  }

  async createDraft(input: DraftRequest): Promise<DraftView> {
    return this.json<DraftView>("POST", "/v1/drafts", input);
  }

  async submitDraft(id: string): Promise<DraftView> {
    return this.json<DraftView>("POST", `/v1/drafts/${encodeURIComponent(id)}/submit`);
  }

  /** Drafts with their text, for the Drafts mailbox. */
  async listDrafts(): Promise<DraftView[]> {
    const out = await this.json<{ drafts: DraftView[] }>("GET", "/v1/drafts?text=1");
    return out.drafts;
  }

  async discardDraft(id: string): Promise<void> {
    await this.json("POST", `/v1/drafts/${encodeURIComponent(id)}/discard`);
  }

  async restore(id: string): Promise<void> {
    await this.json("POST", `/v1/messages/${encodeURIComponent(id)}/restore`);
  }

  /** Needs `client-send`: the message goes out through SES as built, with no approval step. */
  clientSend(input: ClientSendRequest): Promise<ClientSendReply> {
    return this.json<ClientSendReply>("POST", "/v1/client/send", {
      raw: Buffer.from(input.raw).toString("base64"),
      envelopeFrom: input.envelopeFrom,
      recipients: input.recipients,
    });
  }
}
