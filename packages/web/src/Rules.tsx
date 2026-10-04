import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { describeChange, describeRule, ruleAuditEvents } from "./rules-copy.ts";
import type { RuleAuditEvent, RulesView } from "./types.ts";

/** Rules are edited by an assistant in chat. This page lists them and the recent changes. The switches are the kill switch: any write token can make them safer, and only a signed-in session can release them. */
export function RulesPanel() {
  const [view, setView] = useState<RulesView | null>(null);
  const [changes, setChanges] = useState<RuleAuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    return Promise.all([api<RulesView>("/v1/rules"), api<{ events: RuleAuditEvent[] }>("/v1/audit?limit=100")])
      .then(([rules, audit]) => {
        setView(rules);
        setChanges(ruleAuditEvents(audit.events));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load rules"));
  };

  useEffect(() => {
    void load();
  }, []);

  const run = async (body: unknown) => {
    setError(null);
    try {
      await api("/v1/rules/switches", { method: "POST", body: JSON.stringify(body) });
      await load();
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
        {rules.rules.length === 0 ? "No rules yet." : `${rules.rules.length} rule(s).`} An assistant with the rules scope edits these in chat. Trash stays in Trash,
        restorable for {rules.trashRetentionDays} days. Rules that send stay off until you turn them on. Pause stops every rule.
      </p>
      {rules.rules.length > 0 ? (
        <ul className="rules">
          {rules.rules.map((rule) => (
            <li key={rule.id}>
              <span>{describeRule(rule, rules.trashRetentionDays)}</span>
              {!rule.enabled ? <span className="chip noise">off</span> : null}
              {rule.createdBy === "bot" ? <span className="chip today">assistant</span> : null}
              {rule.createdBy === "human" ? <span className="chip">you</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <h3>Recent changes</h3>
      {changes.length === 0 ? <p className="muted">No rule changes yet.</p> : null}
      {changes.length > 0 ? (
        <ul className="rules changes">
          {changes.map((event) => (
            <li key={`${event.at}-${event.action}-${event.detail ?? ""}`}>
              <span>{describeChange(event)}</span>
              <span className="muted">{when(event.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">
        {rules.paused ? "All rules are paused." : "Rules are running."} {rules.killSwitch ? "Auto-send is stopped (kill switch on)." : ""}{" "}
        {rules.sendKillSwitch ? "All sending is stopped, including Thunderbird, approved drafts and bot sends." : ""}
      </p>
      <div className="actions flush">
        <button className="ghost" type="button" onClick={() => void run({ paused: !rules.paused })}>
          {rules.paused ? "Resume rules" : "Pause all rules"}
        </button>
        <button className="ghost" type="button" onClick={() => void run({ killSwitch: !rules.killSwitch })}>
          {rules.killSwitch ? "Allow auto-send again" : "Stop auto-send"}
        </button>
        <button className="ghost" type="button" onClick={() => void run({ sendKillSwitch: !rules.sendKillSwitch })}>
          {rules.sendKillSwitch ? "Allow sending again" : "Stop all sending"}
        </button>
      </div>
    </>
  );
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
