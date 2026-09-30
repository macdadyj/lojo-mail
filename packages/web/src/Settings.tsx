import { useEffect, useState } from "react";
import { api, apiUrl, apiUrlOverride, builtApiUrl, setApiUrlOverride, signOut } from "./api.ts";
import { RulesPanel } from "./Rules.tsx";
import type { Settings as SettingsInfo } from "./types.ts";
import { hasPrivateKey, isKeyPersisted, parsePrivateJwk, rememberKey } from "./unlock.ts";

export function Settings() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [jwkText, setJwkText] = useState("");
  const [persist, setPersist] = useState(isKeyPersisted);
  const [keyHeld, setKeyHeld] = useState(hasPrivateKey);
  const [error, setError] = useState<string | null>(null);
  const [keyNote, setKeyNote] = useState<string | null>(null);

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
      <h3>Reading message bodies</h3>
      {info?.unlocked ? (
        <p className="muted">
          This local API holds the envelope private key, so it opens bodies itself. You don't need to load a key here.
        </p>
      ) : (
        <p className="muted">
          The API can't open message bodies; it only stores them sealed. Load the envelope private key below to read them in
          this browser. The key is never sent to the API.
        </p>
      )}
      <p className="muted">
        {keyHeld ? "This browser has the envelope key loaded." : "This browser has no envelope key loaded."}
        {keyHeld && persist ? " It is kept for this tab across a refresh." : ""}
      </p>
      {keyNote ? <p className="muted">{keyNote}</p> : null}
      <label htmlFor="jwk">Envelope private key (JWK)</label>
      <textarea
        id="jwk"
        className="key"
        value={jwkText}
        onChange={(event) => setJwkText(event.target.value)}
        placeholder='{"kty":"EC","crv":"P-256","x":"…","y":"…","d":"…"}'
        autoComplete="off"
        spellCheck={false}
      />
      <label className="check" htmlFor="persist">
        <input id="persist" type="checkbox" checked={persist} onChange={(event) => setPersist(event.target.checked)} />
        Keep the key for this tab across a refresh
      </label>
      <div className="actions flush">
        <button
          className="primary"
          type="button"
          onClick={() => {
            setError(null);
            setKeyNote(null);
            try {
              rememberKey(parsePrivateJwk(jwkText), persist);
              setKeyHeld(true);
              setJwkText("");
              setKeyNote(persist ? "Key loaded and kept for this tab." : "Key loaded until this tab closes or reloads.");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not read the key");
            }
          }}
        >
          Load key
        </button>
        <button
          className="ghost"
          type="button"
          onClick={() => {
            rememberKey(null, false);
            setKeyHeld(false);
            setPersist(false);
            setJwkText("");
            setKeyNote("Key removed from this browser.");
          }}
        >
          Remove key
        </button>
      </div>
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
