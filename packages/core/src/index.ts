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
export { FsBlobStore, MemoryBlobStore, RULES_HISTORY_KEY, RULES_KEY, aiContextKey, attachmentKey, bodyKey, botCopyKey, draftAttachmentKey } from "./blob/store.ts";
export { BotAdmin, botScopes } from "./bots/admin.ts";
export {
  applySendGrantExpiry,
  applySendWindow,
  grantExpired,
  MAX_SEND_GRANT_MS,
  parseGrantExpiry,
  persistExpiredSendGrants,
  sendNewApprovalRequired,
  TEST_WINDOW_SEND_LIMITS,
} from "./bots/grant.ts";
export type { BotSendGrant, SendWindowInput } from "./bots/grant.ts";
export {
  approvalNoteRefusals,
  CHAT_APPROVAL_SOURCE,
  chatSendLimits,
  DEFAULT_CHAT_SEND_LIMITS,
  MAX_CHAT_SEND_LIMITS,
  replyRecipientRefusals,
} from "./bots/chat-send.ts";
export type { ChatSendLimits } from "./bots/chat-send.ts";
export type { BotAdminDeps, BotRegistryView } from "./bots/admin.ts";
export { activeBotKey, botBackfillCandidates, botBodyContext, readBotCopy, sealBotCopy, storeBotCopy } from "./bots/copies.ts";
export type { BotBody } from "./bots/copies.ts";
export {
  BOT_SCOPES,
  BOT_TOKEN_PREFIX,
  DEFAULT_BOT_SCOPES,
  botNameOf,
  checkBotToken,
  emptyBotRegistry,
  hashBotToken,
  knownBotScope,
  newBotToken,
  summarizeBot,
  validBotName,
} from "./bots/registry.ts";
export type { BotCheck, BotEnvelopeKey, BotRecord, BotRegistry, BotScope, BotSummary } from "./bots/registry.ts";
export { DEFAULT_TEST_SEND_LIMITS, LOJO_TEST_RECIPIENT, TEST_SEND_SUBJECT_PREFIX, botTestSend } from "./bots/test-send.ts";
export type { TestSendInput, TestSendLimits } from "./bots/test-send.ts";
export type { BlobStore } from "./blob/store.ts";
export { clientSendLimitsFromEnv, DEFAULT_CLIENT_SEND_LIMITS, sendFromClient } from "./client-send.ts";
export type { ClientSendDeps, ClientSendInput, ClientSendLimits, ClientSendResult } from "./client-send.ts";
export { EMBED_PROVIDERS, LLM_PROVIDERS, loadConfig, sendFromList } from "./config.ts";
export {
  attachmentContext,
  b64ToBytes,
  bytesToB64,
  decodeEnvelope,
  encodeEnvelope,
  generateIdentity,
  keyFingerprint,
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
  draftAttachmentContext,
  draftContext,
  rulesContext,
  serverOpen,
  serverOpenBytes,
  serverSeal,
  serverSealBytes,
} from "./crypto/server-seal.ts";
export { DRAFT_ATTACHMENT_LIMITS, cleanAttachmentFilename, encodedSize, estimatedMessageBytes } from "./draft-attachments.ts";
export type { DraftAttachmentLimits, NewDraftAttachment } from "./draft-attachments.ts";
export type { DataKey, KeyWrapper } from "./crypto/server-seal.ts";
export { MailError, assertNever } from "./errors.ts";
export type { MailErrorCode } from "./errors.ts";
export { newId, sha256, utcDay, normalizeMessageId } from "./ids.ts";
export { embedForStorage, embeddingInput, ingestRaw, messageIdFor, refreshThread, threadParticipants } from "./ingest.ts";
export type { IngestDeps, IngestOptions, IngestResult } from "./ingest.ts";
export { Mailbox } from "./mailbox.ts";
export type { AttachmentPayload, DraftInput, DraftPatch, MailboxDeps, ReviewedDraft, ViewOptions } from "./mailbox.ts";
export { isBulk } from "./mime/bulk.ts";
export { buildMimeEntity, buildRawMessage, cleanContentType, cleanEmail, cleanHeaderValue, encodeHeaderText, formatAddress, mimeParameter } from "./mime/compose.ts";
export { htmlToText, snippetFrom } from "./mime/html.ts";
export { parseMime, rawHeaders, sesVerdicts } from "./mime/parse.ts";
export type { ParsedInbound } from "./mime/parse.ts";
export { heuristicPhishing } from "./mime/phishing.ts";
export { assignThreadIds, threadIdForRoot } from "./mime/thread.ts";
export { decryptText, encryptMimeEntity, encryptText, generateTestKey } from "./openpgp/mail.ts";
export type { PgpSigningKey } from "./openpgp/mail.ts";
export { wkdAdvancedUrl, wkdLocalPartHash, zBase32Encode } from "./openpgp/wkd.ts";
export { AUTO_REPLY_FOOTER, autoSendRefusals, rateLimitRefusals, renderTemplate, replyBlockers, replyTextRefusals } from "./rules/autosend.ts";
export type { AutoSendContext, LoopHeaders } from "./rules/autosend.ts";
export { deleteBotRule, isProposal, preserveBotRules, upsertBotRule } from "./rules/bot-rules.ts";
export { emptyRuleHistory, pushRevision, ruleWhy, undoRevision } from "./rules/history.ts";
export type { RuleHistory, RuleRevision } from "./rules/history.ts";
export { enableRule, isAutomationMode, ruleFingerprints, setAutomationMode } from "./rules/promote.ts";
export type { AutomationMode } from "./rules/promote.ts";
export { fetchOneClick, parseListUnsubscribe, parseMailto, runUnsubscribe, safeOneClickUrl } from "./rules/unsubscribe.ts";
export type { OneClickClient, UnsubscribeResult, UnsubscribeTarget } from "./rules/unsubscribe.ts";
export { dryRunRules, fileByRules, loadRuleHistory, loadRules, rulesRuntime, runRuleReply, saveRuleHistory, saveRules } from "./rules/engine.ts";
export type { DryRun, ReplyResult, RulesRuntime } from "./rules/engine.ts";
export { evaluateRules, ruleMatches, senderMatches } from "./rules/match.ts";
export { RULE_FOLDERS } from "./rules/types.ts";
export type {
  ReplyAction,
  ReplyMode,
  Rule,
  RuleAction,
  RuleAuthor,
  RuleFolder,
  RuleHit,
  RuleMatch,
  RuleOutcome,
  RulesDocument,
  UnsubscribeAction,
  UnsubscribeMode,
} from "./rules/types.ts";
export { assertShadowedFirst, automationModes, checkRulesFile, emptyRules, parseRulesDocument, ruleFingerprint, rulesHash } from "./rules/validate.ts";
export { isPurgeDue, ownedBlobKeys, PURGE_MAX_PER_RUN, PURGE_MIN_AGE_DAYS, purgeExpiredTrash, purgeModeFrom } from "./trash/purge.ts";
export type { PurgeDeps, PurgeMode, PurgeResult } from "./trash/purge.ts";
export { MemorySender, sesRfcId } from "./send.ts";
export type { MailSender, OutboundAttachment, OutboundMessage, RawOutbound } from "./send.ts";
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
  DraftAttachment,
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
