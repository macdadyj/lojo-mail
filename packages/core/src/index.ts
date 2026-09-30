export {
  AI_LABEL_ALLOWLIST,
  PHISHING_DEMOTE_SCORE,
  allowedLabels,
  analyzeMessage,
  buildPrompt,
  cosine,
  demotedPriority,
} from "./ai/pipeline.ts";
export { ModelOutputError, parseAiResult, aiResultSchema } from "./ai/schema.ts";
export type { AiResult } from "./ai/schema.ts";
export { BedrockLlm, GeminiLlm, GrokLlm, MockLlm, OllamaLlm, OpenAiCompatibleLlm, createLlmClient } from "./ai/providers.ts";
export {
  BedrockTitanEmbedder,
  GoogleEmbedder,
  MockEmbedder,
  OllamaEmbedder,
  OpenAiCompatibleEmbedder,
  TITAN_V2_DIMENSIONS,
  createEmbedder,
} from "./ai/embedders.ts";
export { ServiceAccountTokens, googleHeaders, googleModelUrl, parseServiceAccount } from "./ai/google-auth.ts";
export type { GoogleEndpoint, ServiceAccountKey } from "./ai/google-auth.ts";
export { DEFAULT_PROVIDER_TIMEOUT_MS, estimateTokens, postJson, postJsonOrThrow, trimSlash } from "./ai/http.ts";
export type { FetchLike } from "./ai/http.ts";
export { SECRET_SOURCES, loadProviderSecrets, secretsFor } from "./ai/secrets.ts";
export type { ParameterReader } from "./ai/secrets.ts";
export { cosineInt8, packVector, rankVectors, unpackVector, vectorTag } from "./ai/vectors.ts";
export type { VectorRow } from "./ai/vectors.ts";
export type { Embedder, EmbedPurpose, LlmClient, LlmCompletion, LlmEmbedding, LlmRequest, ProviderSecrets } from "./ai/types.ts";
export { APPROVAL_TTL_MS, approvalContentHash, hashApprovalToken, newApprovalToken, sameHash } from "./approval.ts";
export { FsBlobStore, MemoryBlobStore, RULES_KEY, aiContextKey, attachmentKey, bodyKey } from "./blob/store.ts";
export type { BlobStore } from "./blob/store.ts";
export { EMBED_PROVIDERS, LLM_PROVIDERS, loadConfig } from "./config.ts";
export {
  attachmentContext,
  b64ToBytes,
  bytesToB64,
  decodeEnvelope,
  encodeEnvelope,
  generateIdentity,
  messageBodyContext,
  openBytes,
  openJson,
  sealBytes,
  sealJson,
} from "./crypto/envelope.ts";
export {
  LocalKeyWrapper,
  aiContextContext,
  canonicalContext,
  draftContext,
  rulesContext,
  serverOpen,
  serverSeal,
} from "./crypto/server-seal.ts";
export type { DataKey, KeyWrapper } from "./crypto/server-seal.ts";
export { MailError, assertNever } from "./errors.ts";
export type { MailErrorCode } from "./errors.ts";
export { newId, sha256, utcDay, normalizeMessageId } from "./ids.ts";
export { embedForStorage, embeddingInput, ingestRaw, messageIdFor, refreshThread, threadParticipants } from "./ingest.ts";
export type { IngestDeps, IngestOptions, IngestResult } from "./ingest.ts";
export { Mailbox } from "./mailbox.ts";
export type { AttachmentPayload, DraftInput, DraftPatch, MailboxDeps, ReviewedDraft, ViewOptions } from "./mailbox.ts";
export { isBulk } from "./mime/bulk.ts";
export { buildRawMessage, cleanEmail, cleanHeaderValue, encodeHeaderText, formatAddress } from "./mime/compose.ts";
export { htmlToText, snippetFrom } from "./mime/html.ts";
export { parseMime, rawHeaders, sesVerdicts } from "./mime/parse.ts";
export type { ParsedInbound } from "./mime/parse.ts";
export { heuristicPhishing } from "./mime/phishing.ts";
export { assignThreadIds, threadIdForRoot } from "./mime/thread.ts";
export { decryptText, encryptText, generateTestKey } from "./openpgp/mail.ts";
export type { PgpSigningKey } from "./openpgp/mail.ts";
export { wkdAdvancedUrl, wkdLocalPartHash, zBase32Encode } from "./openpgp/wkd.ts";
export { AUTO_REPLY_FOOTER, autoSendRefusals, rateLimitRefusals, renderTemplate, replyBlockers, replyTextRefusals } from "./rules/autosend.ts";
export type { AutoSendContext, LoopHeaders } from "./rules/autosend.ts";
export { dryRunRules, fileByRules, loadRules, rulesRuntime, runRuleReply, saveRules } from "./rules/engine.ts";
export type { DryRun, ReplyResult, RulesRuntime } from "./rules/engine.ts";
export { evaluateRules, ruleMatches, senderMatches } from "./rules/match.ts";
export { RULE_FOLDERS } from "./rules/types.ts";
export type { ReplyAction, Rule, RuleAction, RuleAuthor, RuleFolder, RuleHit, RuleMatch, RuleOutcome, RulesDocument } from "./rules/types.ts";
export { checkRulesFile, emptyRules, parseRulesDocument, rulesHash } from "./rules/validate.ts";
export { MemorySender } from "./send.ts";
export type { MailSender, OutboundMessage } from "./send.ts";
export { DynamoMailStore } from "./store/dynamo.ts";
export { DYNAMO_ITEM_LIMIT_BYTES, DynamoItemTooLarge, MemoryDynamo } from "./store/memory-dynamo.ts";
export type { MemoryDynamoDump } from "./store/memory-dynamo.ts";
export { MemoryStore } from "./store/memory.ts";
export type { MemorySnapshot } from "./store/memory.ts";
export { DEFAULT_TABLE_NAMES, TABLE_SCHEMAS } from "./store/types.ts";
export type {
  Condition,
  DynamoLike,
  Item,
  MailStore,
  QueryOptions,
  TableNames,
  TableSchema,
  UpdateOptions,
} from "./store/types.ts";
export type {
  ActionItem,
  Actor,
  Address,
  AiPublic,
  AttachmentMeta,
  AuditEvent,
  Category,
  Contact,
  Draft,
  DraftOrigin,
  DraftStatus,
  DraftView,
  EcPrivateJwk,
  EmbedProviderName,
  EcPublicJwk,
  EncryptionContext,
  EnvelopeBlob,
  Folder,
  ListQuery,
  LlmProviderName,
  LojoConfig,
  MessageOrigin,
  MessageView,
  PgpMode,
  Priority,
  SealedBody,
  SensitiveAi,
  ServerSealedBlob,
  StoredAttachment,
  StoredMessage,
  Thread,
  TrashActor,
  Verdicts,
} from "./types.ts";
export { FOLDERS } from "./types.ts";
