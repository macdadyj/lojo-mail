import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { RuleSummary, RulesView } from "./types.ts";

function badges(rule: RuleSummary): string[] {
  const out: string[] = [];
  if (!rule.enabled) out.push("off");
  for (const action of rule.actions) {
    if (action.type === "trash") out.push("trash");
    if (action.type === "reply") out.push(action.reply?.mode === "autoSend" ? `auto-send to ${action.reply.allowSenders.join(", ")}` : "draft reply");
  }
  return out;
}

/** Rules are edited as a file (`npm run rules`); here Jon sees what runs and can stop or resume it. */
export function RulesPanel() {
  const [view, setView] = useState<RulesView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<RulesView>("/v1/rules")
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load rules"));
  }, []);

  const flip = async (change: { paused?: boolean; killSwitch?: boolean }) => {
    setError(null);
    try {
      const next = await api<{ rules: RulesView["rules"] }>("/v1/rules/switches", { method: "POST", body: JSON.stringify(change) });
      setView((current) => (current ? { ...current, rules: next.rules } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the rules");
    }
  };

  if (!view) return error ? <p className="error">{error}</p> : null;
  const { rules } = view;
  return (
    <>
      {error ? <p className="error">{error}</p> : null}
      <p className="muted">
        {rules.rules.length === 0 ? "No rules yet." : `${rules.rules.length} rule(s).`} Rules trash only to Trash, restorable for{" "}
        {rules.trashRetentionDays} days. Replies are drafts for your approval unless a rule auto-sends
        {view.autoSendEnabled ? "." : ", and auto-send is off on this deployment, so those are drafts too."} Edit rules with{" "}
        <code>npm run rules</code>.
      </p>
      {rules.rules.length > 0 ? (
        <ul className="rules">
          {rules.rules.map((rule) => (
            <li key={rule.id}>
              {rule.name}{" "}
              {badges(rule).map((badge) => (
                <span key={badge} className={badge.startsWith("auto-send") ? "chip now" : "chip noise"}>
                  {badge}
                </span>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">
        {rules.paused ? "All rules are paused." : "Rules are running."} {rules.killSwitch ? "Auto-send is stopped (kill switch on)." : ""}
      </p>
      <div className="actions flush">
        <button className="ghost" type="button" onClick={() => void flip({ paused: !rules.paused })}>
          {rules.paused ? "Resume rules" : "Pause all rules"}
        </button>
        <button className="ghost" type="button" onClick={() => void flip({ killSwitch: !rules.killSwitch })}>
          {rules.killSwitch ? "Allow auto-send again" : "Stop auto-send"}
        </button>
      </div>
    </>
  );
}
