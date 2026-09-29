import { useEffect, useState } from "react";
import { api, getToken, setToken } from "./api.ts";
import type { Settings as SettingsInfo } from "./types.ts";
import { hasPrivateKey, loadRememberedKey, parsePrivateJwk, rememberKey } from "./unlock.ts";

export function Settings() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [token, setTokenValue] = useState(getToken());
  const [jwkText, setJwkText] = useState("");
  const [persist, setPersist] = useState(false);
  const [keyHeld, setKeyHeld] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyNote, setKeyNote] = useState<string | null>(null);

  useEffect(() => {
    const remembered = loadRememberedKey();
    setKeyHeld(remembered !== null || hasPrivateKey());
    setPersist(sessionStorage.getItem("lojo-mail-private-jwk") !== null);
  }, []);

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
      <h3>Envelope key</h3>
      <p className="muted">
        The private key stays in this browser. It is not sent to the API. Leave the box unchecked and it dies with the tab.
        Check it only to keep the key for this tab across a refresh.
      </p>
      <p className="muted">{keyHeld ? "A private key is loaded." : "No private key is loaded. Locked messages stay sealed."}</p>
      {keyNote ? <p className="muted">{keyNote}</p> : null}
      <label htmlFor="jwk">Private JWK</label>
      <textarea
        id="jwk"
        value={jwkText}
        onChange={(event) => setJwkText(event.target.value)}
        placeholder='{"kty":"EC","crv":"P-256","x":"…","y":"…","d":"…"}'
        autoComplete="off"
        spellCheck={false}
        style={{ minHeight: 120 }}
      />
      <label className="check" htmlFor="persist">
        <input
          id="persist"
          type="checkbox"
          checked={persist}
          onChange={(event) => setPersist(event.target.checked)}
        />
        Keep this key in this tab
      </label>
      <div className="actions" style={{ padding: "16px 0" }}>
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
              setKeyNote(persist ? "Key kept for this tab." : "Key held in memory for this tab.");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not read the key");
            }
          }}
        >
          Unlock
        </button>
        <button
          className="ghost"
          type="button"
          onClick={() => {
            rememberKey(null, false);
            setKeyHeld(false);
            setPersist(false);
            setJwkText("");
            setKeyNote("Key forgotten.");
          }}
        >
          Forget key
        </button>
      </div>
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
