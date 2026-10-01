import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { BotsView } from "./types.ts";

/** The bot kill switch refuses every bot credential on its next request. Creating and scoping bots is `lojo-bot admin` on Santa. */
export function BotsPanel() {
  const [view, setView] = useState<BotsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<BotsView>("/v1/bots")
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load bots"));
  }, []);

  const toggle = async () => {
    if (!view) return;
    const on = !view.killSwitch;
    if (on && !window.confirm("Switch off every bot? Each bot request is refused until you turn this back.")) return;
    setError(null);
    try {
      setView(await api<BotsView>("/v1/bots/kill-switch", { method: "POST", body: JSON.stringify({ on }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the bot kill switch");
    }
  };

  if (!view) return error ? <p className="error">{error}</p> : null;
  const live = view.bots.filter((bot) => !bot.revokedAt);
  return (
    <>
      {error ? <p className="error">{error}</p> : null}
      <p className="muted">
        {view.killSwitch ? "Bots are switched off: every bot credential is refused." : `${live.length} active bot(s).`} Bot body key{" "}
        {view.envelopeKey ? <code>{view.envelopeKey.keyId}</code> : "not registered"}. Manage bots with <code>lojo-bot admin</code> on Santa.
      </p>
      {live.length > 0 ? (
        <ul className="rules">
          {live.map((bot) => (
            <li key={bot.name}>
              {bot.name}{" "}
              {bot.scopes.map((scope) => (
                <span key={scope} className={scope.startsWith("send") ? "chip now" : "chip noise"}>
                  {scope}
                </span>
              ))}
              {bot.scopes.includes("send-approved") || bot.scopes.includes("send-new") ? (
                <span className="muted">
                  {" "}
                  sends: {bot.sendLimits?.perHour ?? 10}/hour, {bot.sendLimits?.perDay ?? 30}/day
                  {bot.scopes.includes("send-new")
                    ? `, new mail approval ${bot.sendGrant?.approvalRequired === false ? "not required" : "required"}`
                    : ""}
                  {bot.sendGrant?.expiresAt ? `, window ends ${bot.sendGrant.expiresAt}` : ""}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="actions flush">
        <button className={view.killSwitch ? "ghost" : "primary"} type="button" onClick={() => void toggle()}>
          {view.killSwitch ? "Allow bots again" : "Switch off all bots"}
        </button>
      </div>
    </>
  );
}
