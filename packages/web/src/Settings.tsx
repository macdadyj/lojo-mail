import { useEffect, useState } from "react";
import { api, apiUrl, apiUrlOverride, builtApiUrl, setApiUrlOverride, signOut } from "./api.ts";
import { KeyPanel } from "./KeyPanel.tsx";
import { RulesPanel } from "./Rules.tsx";
import type { Settings as SettingsInfo } from "./types.ts";

export function Settings() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
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
          </p>
        </>
      ) : null}
      <h3>Envelope key</h3>
      <KeyPanel info={info} />
      <h3>Mail rules</h3>
      <RulesPanel />
      <h3>API</h3>
      <ApiUrlField />
      <div className="actions flush">
        <button className="ghost" type="button" onClick={() => signOut()}>Sign out</button>
      </div>
      <p>
        Ordinary mail is not end-to-end encrypted. SES sees it in transit. After processing, the body is sealed to your
        key; the subject, addresses, and snippet stay in the index so the list can render. OpenPGP mail is the path
        where the provider sees ciphertext. Nothing is sent without your approval: assistants can only put drafts in your
        approval queue.
      </p>
      {info?.dev ? (
        <p className="muted">
          Local demo. The sign-in passphrase and API tokens are printed by <code>npm run dev</code>. The demo passphrase and
          tokens are refused when the API runs with NODE_ENV=production.
        </p>
      ) : null}
    </div>
  );
}

export function ApiUrlField() {
  const [value, setValue] = useState(apiUrlOverride() ?? "");
  const [note, setNote] = useState<string | null>(null);
  const built = builtApiUrl() || "this origin";

  return (
    <>
      <p className="muted">
        Requests go to {apiUrl() || "this origin"}. The build default is {built}. A production build's content security
        policy only allows the API origin it was built with.
      </p>
      <label htmlFor="api-url">API URL override</label>
      <input
        id="api-url"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="https://abc123.execute-api.us-east-1.amazonaws.com"
        autoComplete="off"
        spellCheck={false}
      />
      <div className="actions flush">
        <button
          className="ghost"
          type="button"
          onClick={() => {
            try {
              setApiUrlOverride(value);
              setNote(value.trim() ? "Saved. Sign in again for the new API." : "Using the build default.");
              signOut();
            } catch (err) {
              setNote(err instanceof Error ? err.message : "That is not a URL");
            }
          }}
        >
          Save API URL
        </button>
      </div>
      {note ? <p className="muted">{note}</p> : null}
    </>
  );
}
