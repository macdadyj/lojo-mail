variable "aws_region" {
  type        = string
  description = "SES receiving region. Inbound MX endpoints exist only in us-east-1, us-west-2, and eu-west-1."
  default     = "us-west-2"

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
  description = "Days to keep raw MIME (plaintext under KMS) before expiration."
  default     = 365
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

variable "manage_dns" {
  type        = bool
  description = "When true, Terraform writes Route 53 records. Leave false until the dry-run checklist in docs/RUNBOOK.md is done."
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
  description = "When true, make this receipt rule set the active one for the whole region. A region has only one active set."
  default     = false
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
    condition     = contains(["grok", "bedrock", "ollama", "mock"], var.llm_provider)
    error_message = "llm_provider must be grok, bedrock, ollama, or mock."
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
  type    = string
  default = "anthropic.claude-3-haiku-20240307-v1:0"
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

variable "processor_bundle" {
  type        = string
  description = "Path to the processor zip. Defaults to a placeholder that fails closed."
  default     = ""
}

variable "api_bundle" {
  type        = string
  description = "Path to the API zip. Defaults to a placeholder that fails closed."
  default     = ""
}

variable "dmarc_policy" {
  type        = string
  description = "DMARC p= value published when manage_dns is true. Start at none."
  default     = "none"

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
