import { useEffect, useState } from "react";
import { api, getToken, setToken } from "./api.ts";
import type { Settings as SettingsInfo } from "./types.ts";

export function Settings() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [token, setTokenValue] = useState(getToken());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SettingsInfo>("/v1/settings")
      .then(setInfo)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load settings"));
  }, []);

  return (
    <div className="panel">
      <header>
        <h2>Settings</h2>
        <a className="back" href="#/inbox">Back</a>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {info ? (
        <>
          <p>
            <strong>{info.mailbox}</strong>
          </p>
          <p className="muted">
            Domain {info.domain}. Model {info.llmProvider}. Tokens today {info.budgetUsed} / {info.dailyTokenBudget}.
            Mailbox is {info.unlocked ? "unlocked in this API process" : "locked"}.
          </p>
        </>
      ) : null}
      <label htmlFor="token">API token</label>
      <input
        id="token"
        value={token}
        onChange={(event) => setTokenValue(event.target.value)}
        autoComplete="off"
      />
      <div className="actions" style={{ padding: "16px 0" }}>
        <button
          className="primary"
          type="button"
          onClick={() => {
            setToken(token);
            window.location.reload();
          }}
        >
          Save token
        </button>
      </div>
      <p>
        Ordinary mail is not end-to-end encrypted. SES sees it in transit. After processing, the body is sealed to your
        key; the subject, addresses, and snippet stay in the index so the list can render. OpenPGP mail is the path
        where the provider sees ciphertext. This app never sends on its own. Approve and send is a separate action.
      </p>
      {info?.dev ? (
        <p className="muted">
          Local demo. The default token is dev-only-change-me and is refused if the API is started with NODE_ENV=production.
          A read-only token for assistants is dev-read-only.
        </p>
      ) : null}
    </div>
  );
}
