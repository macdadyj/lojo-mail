import { useEffect, useRef, useState } from "react";
import { linksOpenDirectly, messageParts, prepareLink, type LinkPart, type MessagePart } from "./links.ts";
import { loadTrustedDomains, TRUSTED_DOMAINS_EVENT } from "./trusted-domains.tsx";
import type { Message } from "./types.ts";

/** Renders message text and links. It never inserts the message's HTML, so remote images and scripts stay unloaded. */
export function MessageBody({ message }: { message: Message }) {
  const [trusted, setTrusted] = useState(loadTrustedDomains);
  useEffect(() => {
    const update = () => setTrusted(loadTrustedDomains());
    window.addEventListener(TRUSTED_DOMAINS_EVENT, update);
    return () => window.removeEventListener(TRUSTED_DOMAINS_EVENT, update);
  }, []);

  const direct = linksOpenDirectly(message, trusted);
  const parts = messageParts({ text: message.text, html: message.html });
  if (parts.length === 0) return null;
  return (
    <div className="mail-body">
      {parts.map((part, index) => (
        <PartView key={index} part={part} direct={direct} />
      ))}
    </div>
  );
}

function PartView({ part, direct }: { part: MessagePart; direct: boolean }) {
  switch (part.type) {
    case "text":
      return <span>{part.text}</span>;
    case "link":
      return direct ? <TrustedLink part={part} /> : <GuardedLink part={part} />;
    default: {
      const unexpected: never = part;
      return unexpected;
    }
  }
}

function TrustedLink({ part }: { part: LinkPart }) {
  return (
    <a className={part.button ? "mail-button" : "mail-link"} href={part.href} target="_blank" rel="noopener noreferrer">
      {part.text}
    </a>
  );
}

function GuardedLink({ part }: { part: LinkPart }) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const hold = useRef<number | null>(null);

  function clearHold() {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  }

  function open() {
    const prepared = prepareLink(part.href);
    if (!prepared) return;
    const opened = window.open(prepared.href, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
    setConfirm(false);
    setMenu(false);
  }

  return (
    <span className="guarded-link">
      <button
        type="button"
        className={part.button ? "mail-button" : "mail-link guarded"}
        title="Right-click or hold to open"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu(true);
        }}
        onPointerDown={() => {
          clearHold();
          hold.current = window.setTimeout(() => setMenu(true), 500);
        }}
        onPointerUp={clearHold}
        onPointerLeave={clearHold}
        onPointerCancel={clearHold}
      >
        {part.text}
      </button>
      {menu && !confirm ? (
        <span className="link-pop">
          <button type="button" className="ghost" onClick={() => setConfirm(true)}>
            Open link
          </button>
        </span>
      ) : null}
      {confirm ? (
        <span className="link-pop" role="dialog" aria-label="Confirm link">
          <strong>{part.domain}</strong>
          <span className="muted">{part.href}</span>
          <span>Nothing is loaded until you open it.</span>
          <span className="actions flush">
            <button type="button" className="primary" onClick={open}>
              Open
            </button>
            <button type="button" className="ghost" onClick={() => { setConfirm(false); setMenu(false); }}>
              Cancel
            </button>
          </span>
        </span>
      ) : null}
    </span>
  );
}
