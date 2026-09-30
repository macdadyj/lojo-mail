import { useState } from "react";
import { ApiError, login } from "./api.ts";
import { ApiUrlField } from "./Settings.tsx";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await login(passphrase);
      setPassphrase("");
      onSignedIn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError("Too many attempts. Wait a few minutes and try again.");
      else setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="mark">Lojo</p>
        <h1>Sign in</h1>
        <label htmlFor="passphrase">Passphrase</label>
        <input
          id="passphrase"
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          autoFocus
        />
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || passphrase.length === 0}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
        <p className="muted">The session lasts until this tab closes or twelve hours pass.</p>
        <details>
          <summary className="muted">API address</summary>
          <ApiUrlField />
        </details>
      </form>
    </main>
  );
}
