import { useState } from "react";
import { DEFAULT_TRUSTED_DOMAINS, parseTrustedDomainList } from "./links.ts";

const STORAGE_KEY = "lojo-mail-trusted-link-domains";
export const TRUSTED_DOMAINS_EVENT = "lojo:trusted-domains";

export function loadTrustedDomains(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return [...DEFAULT_TRUSTED_DOMAINS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return [...DEFAULT_TRUSTED_DOMAINS];
    const parsedList = parseTrustedDomainList(parsed.join("\n"));
    return parsedList.ok ? parsedList.domains : [...DEFAULT_TRUSTED_DOMAINS];
  } catch {
    return [...DEFAULT_TRUSTED_DOMAINS];
  }
}

export function saveTrustedDomains(domains: readonly string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(domains));
  window.dispatchEvent(new Event(TRUSTED_DOMAINS_EVENT));
}

export function TrustedDomainsField() {
  const [text, setText] = useState(() => loadTrustedDomains().join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function save(next: string) {
    const parsed = parseTrustedDomainList(next);
    if (!parsed.ok) {
      setSaved(false);
      setError(parsed.error);
      return;
    }
    saveTrustedDomains(parsed.domains);
    setText(parsed.domains.join("\n"));
    setError(null);
    setSaved(true);
  }

  return (
    <>
      <p className="muted">
        A message from one of these domains, or a subdomain of it, shows its links as buttons when the sender passed DMARC and was not marked spam or
        virus. Every other message asks before opening a link. Remote images stay off.
      </p>
      <label htmlFor="trusted-domains">Trusted link domains</label>
      <textarea id="trusted-domains" rows={5} value={text} spellCheck={false} onChange={(event) => { setText(event.target.value); setSaved(false); }} />
      <div className="actions flush">
        <button className="ghost" type="button" onClick={() => save(text)}>Save domains</button>
        <button
          className="ghost"
          type="button"
          onClick={() => {
            const defaults = [...DEFAULT_TRUSTED_DOMAINS].join("\n");
            setText(defaults);
            save(defaults);
          }}
        >
          Use the built-in list
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {saved && !error ? <p className="muted">Saved on this browser.</p> : null}
    </>
  );
}
