variable "aws_region" {
  type        = string
  description = "SES region for inbound and outbound. A read-only audit found cyberphysical.us already verified in us-east-1, with the apex MX on inbound-smtp.us-east-1. Receiving exists only in us-east-1, us-west-2, and eu-west-1."
  default     = "us-east-1"

  validation {
    condition     = contains(["us-east-1", "us-west-2", "eu-west-1"], var.aws_region)
    error_message = "SES email receiving is only offered in us-east-1, us-west-2, and eu-west-1."
  }
}

variable "domain" {
  type        = string
  description = "Mailbox domain. Switchable later (for example lojo.dev) by applying a new identity; do not hard-code it in application code."
  default     = "cyberphysical.us"

  validation {
    condition     = can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", var.domain))
    error_message = "domain must look like a bare DNS name."
  }
}

variable "local_part" {
  type        = string
  description = "Local part of the mailbox address."
  default     = "lojo"

  validation {
    condition     = can(regex("^[a-z0-9._+-]+$", var.local_part))
    error_message = "local_part must be a simple mailbox name."
  }
}

variable "receiving_stage" {
  type        = string
  description = "test: the receipt rule accepts only receiving_test_local_part, so the first deploy can be checked end to end while real mail is untouched. live: it accepts the mailbox and the DMARC address. Switch to live only after the docs/DEPLOY.md checklist passes."
  default     = "test"

  validation {
    condition     = contains(["test", "live"], var.receiving_stage)
    error_message = "receiving_stage must be test or live."
  }
}

variable "receiving_test_local_part" {
  type        = string
  description = "Local part the receipt rule accepts while receiving_stage is test."
  default     = "lojo-test"

  validation {
    condition     = can(regex("^[a-z0-9._+-]+$", var.receiving_test_local_part)) && var.receiving_test_local_part != var.local_part
    error_message = "receiving_test_local_part must be a simple mailbox name, different from local_part."
  }
}

variable "mail_from_subdomain" {
  type        = string
  description = "Custom MAIL FROM subdomain label. The FQDN is <label>.<domain> and it must have exactly one MX."
  default     = "mail"
}

variable "project" {
  type    = string
  default = "lojo-mail"
}

variable "raw_retention_days" {
  type        = number
  description = "Safety net for raw MIME (plaintext under bucket SSE-KMS). The processor deletes raw/ after indexing; this only catches objects it could not process. Keep it longer than you'd take to notice and redrive the DLQ."
  default     = 7

  validation {
    condition     = var.raw_retention_days >= 1
    error_message = "raw_retention_days must be at least 1."
  }
}

variable "ai_context_days" {
  type        = number
  description = "Days to keep the KMS-sealed AI-context copy of inbound bodies (for server-side summaries and draft replies). 0 disables the copy."
  default     = 30

  validation {
    condition     = var.ai_context_days >= 0
    error_message = "ai_context_days must be 0 or more."
  }
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "dns_ttl" {
  type        = number
  description = "TTL for records this stack would create. 300 keeps an MX revert fast."
  default     = 300
}

variable "ses_identity_mode" {
  type        = string
  description = "existing: adopt the SES identity already in this region and do not publish DKIM, SPF, MX, or MAIL FROM records. create: make a new identity (a later domain such as lojo.dev)."
  default     = "existing"

  validation {
    condition     = contains(["existing", "create"], var.ses_identity_mode)
    error_message = "ses_identity_mode must be existing or create."
  }
}

variable "manage_dns" {
  type        = bool
  description = "When true, and only when ses_identity_mode is create, Terraform may write DNS for that new identity. existing mode refuses this flag. Suggested records for cyberphysical.us stay in the dns_plan output."
  default     = false
}

variable "dns_cutover_confirmation" {
  type        = string
  description = "Must be exactly I-audited-the-existing-zone before manage_dns can apply."
  default     = ""
}

variable "zone_id" {
  type        = string
  description = "Route 53 hosted zone id. Required only when manage_dns is true. This stack does not look the zone up, so a plan cannot surprise a different zone."
  default     = ""
}

variable "manage_active_rule_set" {
  type        = bool
  description = "When true, make this receipt rule set the active one for the region. A region has only one active set. A read-only audit found none active, so the default turns receiving on for the addresses that receiving_stage selects. Re-check before apply. Setting this back to false removes the active association and stops all SES receiving in the region."
  default     = true
}

variable "web_origins" {
  type        = list(string)
  description = "Browser origins allowed to call the API."
  default     = ["http://127.0.0.1:5173", "http://localhost:5173"]
}

variable "llm_provider" {
  type    = string
  default = "grok"

  validation {
    condition     = contains(["grok", "bedrock", "ollama", "openai", "gemini", "vertex", "mock"], var.llm_provider)
    error_message = "llm_provider must be grok, bedrock, ollama, openai, gemini, vertex, or mock."
  }
}

variable "daily_token_budget" {
  type    = number
  default = 100000
}

variable "max_body_chars" {
  type    = number
  default = 8000
}

variable "bedrock_model_id" {
  type        = string
  description = "Bedrock model or cross-region inference profile id. Check the Bedrock model catalog for current ids before apply."
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "grok_base_url" {
  type    = string
  default = "https://api.x.ai/v1"
}

variable "grok_model" {
  type    = string
  default = "grok-3-mini"
}

variable "ollama_base_url" {
  type        = string
  description = "Used by local dev. A Lambda cannot reach a tailnet address without extra networking this stack deliberately does not create."
  default     = "http://100.96.1.90:11434"
}

variable "ollama_model" {
  type    = string
  default = "llama3.2:1b"
}

variable "ollama_embed_model" {
  type    = string
  default = "nomic-embed-text"
}

variable "embed_provider" {
  type        = string
  description = "Embeddings for semantic search. none keeps the next apply cost- and behavior-neutral; bedrock (Titan v2) is the cheapest in-account option. See docs/INTEGRATIONS.md."
  default     = "none"

  validation {
    condition     = contains(["none", "bedrock", "openai", "gemini", "vertex", "ollama", "mock"], var.embed_provider)
    error_message = "embed_provider must be none, bedrock, openai, gemini, vertex, ollama, or mock."
  }
}

variable "embed_dimensions" {
  type        = number
  description = "Stored vector size. Titan v2 accepts 256, 512, or 1024."
  default     = 256

  validation {
    condition     = var.embed_dimensions >= 0 && var.embed_dimensions <= 4096 && floor(var.embed_dimensions) == var.embed_dimensions
    error_message = "embed_dimensions must be a whole number from 0 to 4096."
  }
}

variable "bedrock_embed_model_id" {
  type    = string
  default = "amazon.titan-embed-text-v2:0"
}

variable "openai_base_url" {
  type        = string
  description = "Any OpenAI-compatible /v1 endpoint (OpenAI, OpenRouter, Groq, Together, a self-hosted vLLM)."
  default     = "https://api.openai.com/v1"
}

variable "openai_model" {
  type    = string
  default = "gpt-4.1-nano"
}

variable "openai_embed_model" {
  type    = string
  default = "text-embedding-3-small"
}

variable "gemini_model" {
  type    = string
  default = "gemini-2.5-flash-lite"
}

variable "gemini_embed_model" {
  type    = string
  default = "gemini-embedding-001"
}

variable "vertex_project" {
  type        = string
  description = "Google Cloud project for Vertex AI with a service account key. Empty uses Vertex express mode with an API key."
  default     = ""
}

variable "vertex_location" {
  type    = string
  default = "us-central1"
}

variable "alarm_actions" {
  type        = list(string)
  description = "SNS topic ARNs for the processor and login-failure alarms. Empty leaves the alarms visible in CloudWatch only."
  default     = []
}

variable "login_failure_alarm_threshold" {
  type        = number
  description = "Failed web sign-ins per hour, across all sources, that raise the login-failure alarm."
  default     = 20
}

variable "processor_reserved_concurrency" {
  type        = number
  description = "Reserved concurrency for the processor. -1 leaves it unreserved. New accounts often have a total limit of 10, and reserving from that can fail apply. 0 is refused: it throttles every S3 event, silently, until the events expire."
  default     = -1

  validation {
    condition     = var.processor_reserved_concurrency == -1 || var.processor_reserved_concurrency >= 1
    error_message = "processor_reserved_concurrency must be -1 (unreserved) or at least 1."
  }
}

variable "raw_sweep_minutes" {
  type        = number
  description = "How often the processor sweeps raw/ for mail the S3 notification missed. Objects younger than 5 minutes are left alone."
  default     = 15

  validation {
    condition     = var.raw_sweep_minutes >= 1 && var.raw_sweep_minutes <= 1440 && floor(var.raw_sweep_minutes) == var.raw_sweep_minutes
    error_message = "raw_sweep_minutes must be a whole number from 1 to 1440."
  }
}

variable "api_throttle_rate" {
  type        = number
  description = "Steady-state requests per second for the HTTP API stage."
  default     = 10
}

variable "api_throttle_burst" {
  type        = number
  description = "Burst requests for the HTTP API stage."
  default     = 20
}

variable "processor_bundle" {
  type        = string
  description = "Path to the built processor bundle (packages/pipeline/dist/processor.mjs). Defaults to a placeholder that fails closed."
  default     = ""
}

variable "api_bundle" {
  type        = string
  description = "Path to the built API bundle (packages/api/dist/api.mjs). Defaults to a placeholder that fails closed."
  default     = ""
}

variable "dmarc_rua_local_part" {
  type        = string
  description = "Local part for a dedicated DMARC aggregate mailbox. Suggested in dns_plan. Not published by Terraform. The receipt rule accepts it so reports are stored once the TXT is edited."
  default     = "dmarc"

  validation {
    condition     = can(regex("^[a-z0-9._+-]+$", var.dmarc_rua_local_part))
    error_message = "dmarc_rua_local_part must be a simple mailbox name."
  }
}

variable "dmarc_policy" {
  type        = string
  description = "DMARC p= value. The live cyberphysical.us record is already quarantine. existing mode does not publish this. create mode uses it when manage_dns is true."
  default     = "quarantine"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine, or reject."
  }
}

variable "mta_sts_id" {
  type        = string
  description = "MTA-STS record id. Bump it when docs/mta-sts.txt changes."
  default     = "202609290000"
}

variable "auto_send_enabled" {
  type        = bool
  description = "Lets mail rules auto-send replies: grants the processor SES send as the mailbox and sets LOJO_AUTO_SEND=on. Every rule still needs Jon's opt-in, a sender allowlist, DMARC pass, loop checks and rate limits. Off means every rule reply is a draft for approval."
  default     = false
}

variable "bridge_trash_enabled" {
  type        = bool
  description = "Gives the Thunderbird bridge token the trash scope (LOJO_BRIDGE_TRASH=on): delete in Thunderbird moves mail to Trash, a soft delete kept for the retention window. Agent tokens and the MCP never get it. Off means delete archives with a hidden label."
  default     = true
}

variable "trash_purge_mode" {
  type        = string
  description = "What the daily trash purge does with mail past its retention window: report (audit what is due, delete nothing), purge (hard delete; grants the purge role DeleteItem on messages and DeleteObject on objects/ and ai-context/), or off."
  default     = "report"

  validation {
    condition     = contains(["off", "report", "purge"], var.trash_purge_mode)
    error_message = "trash_purge_mode must be off, report, or purge."
  }
}
