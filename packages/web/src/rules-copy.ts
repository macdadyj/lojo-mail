import type { RuleActionSummary, RuleAuditEvent, RuleMatchSummary, RuleSummary } from "./types.ts";

const RULE_AUDIT = ["rules.updated", "rules.bot_upsert", "rules.bot_delete", "rules.undone", "rules.switches", "rules.disabled", "rules.enabled", "rules.automation"] as const;

type RuleAuditAction = (typeof RULE_AUDIT)[number];

function isRuleAudit(action: string): action is RuleAuditAction {
  return (RULE_AUDIT as readonly string[]).includes(action);
}

/** Who the rule matches, in plain language. */
export function matchPhrase(match: RuleMatchSummary): string {
  const bits: string[] = [];
  if (match.from && match.from.length > 0) bits.push(`from ${match.from.join(" or ")}`);
  if (match.to && match.to.length > 0) bits.push(`to ${match.to.join(" or ")}`);
  if (match.subjectContains && match.subjectContains.length > 0) bits.push(`containing "${match.subjectContains.join('" or "')}"`);
  if (match.listId && match.listId.length > 0) bits.push(`on list ${match.listId.join(" or ")}`);
  if (match.bulk === true) bits.push("that is bulk");
  if (match.bulk === false) bits.push("that is not bulk");
  if (match.categories && match.categories.length > 0) bits.push(`in ${match.categories.join(" or ")}`);
  return bits.length > 0 ? `mail ${bits.join(" ")}` : "matching mail";
}

function folderName(folder: string): string {
  switch (folder) {
    case "inbox":
      return "Inbox";
    case "archive":
      return "Archive";
    case "spam":
      return "Spam";
    default:
      return folder;
  }
}

function actionPhrase(action: RuleActionSummary, who: string, retentionDays: number): string {
  switch (action.type) {
    case "label":
      return `Label ${who} with ${action.labels.join(", ")}`;
    case "move":
      return `Move ${who} to ${folderName(action.folder)}`;
    case "markRead":
      return `Mark ${who} read`;
    case "trash":
      return `Move ${who} to Trash, restorable for ${retentionDays} days`;
    case "reply":
      return action.reply.mode === "autoSend" ? `Auto-send a reply to ${who}` : action.reply.mode === "shadow" ? `Log a reply to ${who} (sends nothing)` : `Draft a reply to ${who}`;
    case "unsubscribe":
      return action.unsubscribe.mode === "auto" ? `Unsubscribe ${who}` : `Log an unsubscribe for ${who} (sends nothing)`;
    default: {
      const unexpected: never = action;
      return unexpected;
    }
  }
}

/** One sentence for the rules page. Trash names the retention window. */
export function describeRule(rule: RuleSummary, retentionDays: number): string {
  const who = matchPhrase(rule.match);
  return rule.actions.map((action) => actionPhrase(action, who, retentionDays)).join(". ");
}

function whyOf(detail: string | undefined): string {
  const match = /why:([^]*?)(?: sha256:| undid:|$)/.exec(detail ?? "");
  return match?.[1]?.trim() ?? "";
}

function ruleOf(detail: string | undefined): string {
  const match = /rule:([^\s]+)/.exec(detail ?? "");
  return match?.[1] ?? "a rule";
}

/** A line for the recent-changes list. Unknown audit actions are still shown. */
export function describeChange(event: RuleAuditEvent): string {
  const who = event.actor ?? "the mailbox";
  const why = whyOf(event.detail);
  const because = why ? `: ${why}` : "";
  if (!isRuleAudit(event.action)) return `${who} ${event.action}${because}`;
  switch (event.action) {
    case "rules.bot_upsert":
      return `${who} saved ${ruleOf(event.detail)}${because}`;
    case "rules.bot_delete":
      return `${who} deleted ${ruleOf(event.detail)}${because}`;
    case "rules.undone":
      return `${who} undid a change to ${ruleOf(event.detail)}${because}`;
    case "rules.updated":
      return `${who} saved the rules file`;
    case "rules.switches":
      return `${who} changed the rule switches`;
    case "rules.disabled":
      return `${who} turned off ${ruleOf(event.detail)}`;
    case "rules.enabled":
      return `${who} turned on ${ruleOf(event.detail)}`;
    case "rules.automation":
      return `${who} changed what ${ruleOf(event.detail)} sends`;
    default: {
      const unexpected: never = event.action;
      return unexpected;
    }
  }
}

export function ruleAuditEvents(events: RuleAuditEvent[]): RuleAuditEvent[] {
  return events.filter((event) => isRuleAudit(event.action)).slice(0, 20);
}
