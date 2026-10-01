import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { RuleActionSummary, RuleSummary, RulesView } from "./types.ts";

type Tone = "now" | "noise" | "today";
type AutomationMode = "draft" | "shadow" | "live";

function badge(action: RuleActionSummary): { text: string; tone: Tone } | null {
  switch (action.type) {
    case "label":
    case "move":
    case "markRead":
      return null;
    case "trash":
      return { text: "trash", tone: "noise" };
    case "reply": {
      const who = action.reply.allowSenders.length > 0 ? action.reply.allowSenders.join(", ") : `category ${action.reply.allowCategories.join(", ")}`;
      if (action.reply.mode === "autoSend") return { text: `auto-send to ${who}`, tone: "now" };
      if (action.reply.mode === "shadow") return { text: `shadow reply (logs only) to ${who}`, tone: "today" };
      return { text: "draft reply", tone: "noise" };
    }
    case "unsubscribe":
      return action.unsubscribe.mode === "auto" ? { text: "unsubscribes automatically", tone: "now" } : { text: "shadow unsubscribe (logs only)", tone: "today" };
    default: {
      const unexpected: never = action;
      return unexpected;
    }
  }
}

function badges(rule: RuleSummary): Array<{ text: string; tone: Tone }> {
  const out: Array<{ text: string; tone: Tone }> = [];
  if (!rule.enabled) out.push({ text: "off", tone: "noise" });
  if (rule.createdBy === "bot") out.push({ text: "bot proposal", tone: "today" });
  for (const action of rule.actions) {
    const item = badge(action);
    if (item) out.push(item);
  }
  return out;
}

/** The mode of the rule's reply or unsubscribe, or null when it has neither. */
function automationOf(rule: RuleSummary): AutomationMode | null {
  for (const action of rule.actions) {
    if (action.type === "reply") return action.reply.mode === "autoSend" ? "live" : action.reply.mode;
    if (action.type === "unsubscribe") return action.unsubscribe.mode === "auto" ? "live" : "shadow";
  }
  return null;
}

function nextModes(rule: RuleSummary): AutomationMode[] {
  const mode = automationOf(rule);
  const unsubscribe = rule.actions.some((action) => action.type === "unsubscribe");
  switch (mode) {
    case null:
      return [];
    case "draft":
      return ["shadow"];
    case "shadow":
      return unsubscribe ? ["live"] : ["live", "draft"];
    case "live":
      return ["shadow"];
    default: {
      const unexpected: never = mode;
      return unexpected;
    }
  }
}

const MODE_LABEL: Record<AutomationMode, string> = { draft: "Back to drafts", shadow: "Shadow (log only)", live: "Go live" };

/** Rules are edited as a file (`npm run rules`); here Jon sees what runs, enables proposals, moves automation through shadow, and stops it. */
export function RulesPanel() {
  const [view, setView] = useState<RulesView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<RulesView>("/v1/rules")
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load rules"));

  useEffect(() => {
    void load();
  }, []);

  const run = async (path: string, body: unknown) => {
    setError(null);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the rules");
    }
  };

  const enable = (rule: RuleSummary) => {
    if (!view || !window.confirm(`Enable "${rule.name}"? ${rule.createdBy === "bot" ? "It becomes your rule: the bot can no longer edit it." : ""}`)) return;
    void run(`/v1/rules/${encodeURIComponent(rule.id)}/enable`, { sha256: view.fingerprints[rule.id] });
  };

  const setMode = (rule: RuleSummary, mode: AutomationMode) => {
    const warning = mode === "live" ? `"${rule.name}" will send mail as you without asking${view?.autoSendEnabled ? "" : " (once auto-send is on for this deployment)"}. Go live?` : `Set "${rule.name}" to ${mode}?`;
    if (!view || !window.confirm(warning)) return;
    void run(`/v1/rules/${encodeURIComponent(rule.id)}/automation`, { mode, sha256: view.fingerprints[rule.id] });
  };

  if (!view) return error ? <p className="error">{error}</p> : null;
  const { rules } = view;
  return (
    <>
      {error ? <p className="error">{error}</p> : null}
      <p className="muted">
        {rules.rules.length === 0 ? "No rules yet." : `${rules.rules.length} rule(s).`} Rules trash only to Trash, restorable for{" "}
        {rules.trashRetentionDays} days. Replies are drafts for your approval unless a rule auto-sends
        {view.autoSendEnabled ? "." : ", and auto-send is off on this deployment, so those are drafts too."} A rule that sends runs in shadow
        first: it logs what it would send, and you take it live here. Edit rules with <code>npm run rules</code>.
      </p>
      {rules.rules.length > 0 ? (
        <ul className="rules">
          {rules.rules.map((rule) => (
            <li key={rule.id}>
              {rule.name}{" "}
              {badges(rule).map((item) => (
                <span key={item.text} className={`chip ${item.tone}`}>
                  {item.text}
                </span>
              ))}{" "}
              {!rule.enabled ? (
                <button className="ghost" type="button" onClick={() => enable(rule)}>
                  Enable
                </button>
              ) : null}
              {nextModes(rule).map((mode) => (
                <button key={mode} className="ghost" type="button" onClick={() => setMode(rule, mode)}>
                  {MODE_LABEL[mode]}
                </button>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">
        {rules.paused ? "All rules are paused." : "Rules are running."} {rules.killSwitch ? "Auto-send is stopped (kill switch on)." : ""}{" "}
        {rules.sendKillSwitch ? "All sending is stopped, including Thunderbird, approved drafts and bot sends." : ""}
      </p>
      <div className="actions flush">
        <button className="ghost" type="button" onClick={() => void run("/v1/rules/switches", { paused: !rules.paused })}>
          {rules.paused ? "Resume rules" : "Pause all rules"}
        </button>
        <button className="ghost" type="button" onClick={() => void run("/v1/rules/switches", { killSwitch: !rules.killSwitch })}>
          {rules.killSwitch ? "Allow auto-send again" : "Stop auto-send"}
        </button>
        <button className="ghost" type="button" onClick={() => void run("/v1/rules/switches", { sendKillSwitch: !rules.sendKillSwitch })}>
          {rules.sendKillSwitch ? "Allow sending again" : "Stop all sending"}
        </button>
      </div>
    </>
  );
}
