import { useEffect, useState } from "react";
import type { LockReason } from "./autolock.ts";
import { forgetDevice, loadDeviceRecord, passkeyPrfSupport, type DeviceRecord } from "./device.ts";
import type { Settings as SettingsInfo } from "./types.ts";
import {
  IDLE_CHOICES,
  idleMinutes,
  keyInfo,
  lastLockReason,
  lockKey,
  onKeyChange,
  parsePrivateJwk,
  savedWrappedKey,
  saveWrappedKey,
  setIdleMinutes,
  unlockWithJwk,
  unlockWithPasskey,
  unlockWithWrapped,
  type KeyInfo,
} from "./unlock.ts";

function useKeyState(): KeyInfo | null {
  const [state, setState] = useState(keyInfo);
  useEffect(() => onKeyChange(() => setState(keyInfo())), []);
  return state;
}

function lockNote(reason: LockReason | null): string | null {
  switch (reason) {
    case null:
      return null;
    case "idle":
      return "Locked after inactivity.";
    case "max":
      return "Locked: a key stays unlocked for 12 hours at most.";
    case "manual":
      return "Locked.";
    case "signed-out":
      return "Locked when you signed out.";
    default: {
      const unexpected: never = reason;
      return unexpected;
    }
  }
}

function sourceLabel(info: KeyInfo): string {
  switch (info.source) {
    case "wrapped":
      return "unlocked with the wrapped key";
    case "passkey":
      return "unlocked with this device's passkey";
    case "jwk":
      return "loaded from a raw JWK";
    default: {
      const unexpected: never = info.source;
      return unexpected;
    }
  }
}

/** Lock button in the rail; with a remembered passkey, unlocks in one tap. */
export function KeyButton() {
  const state = useKeyState();
  const [error, setError] = useState<string | null>(null);
  if (state) {
    return (
      <button type="button" onClick={() => lockKey("manual")} title={`Key ${state.fingerprint}`}>
        Lock
      </button>
    );
  }
  if (!loadDeviceRecord()) return <a href="#/settings">Unlock</a>;
  return (
    <button
      type="button"
      title={error ?? "Unlock with this device's passkey"}
      onClick={() => {
        setError(null);
        unlockWithPasskey().catch((err: unknown) => setError(err instanceof Error ? err.message : "Unlock failed"));
      }}
    >
      {error ? "Unlock failed" : "Unlock"}
    </button>
  );
}

export function KeyPanel({ info }: { info: SettingsInfo | null }) {
  const state = useKeyState();
  const [blob, setBlob] = useState(() => savedWrappedKey() ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [keepBlob, setKeepBlob] = useState(() => savedWrappedKey() !== null);
  const [remember, setRemember] = useState(false);
  const [prf, setPrf] = useState<"no" | "maybe" | "yes">("no");
  const [device, setDevice] = useState<DeviceRecord | null>(loadDeviceRecord);
  const [progress, setProgress] = useState<number | null>(null);
  const [idle, setIdle] = useState(idleMinutes);
  const [jwkText, setJwkText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void passkeyPrfSupport().then(setPrf);
  }, []);

  const expected = info?.envelopeKeyFingerprint;
  const run = async (task: () => Promise<string | null>) => {
    setError(null);
    setNote(null);
    try {
      setNote(await task());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlock");
    } finally {
      setProgress(null);
    }
  };

  const unlock = () =>
    run(async () => {
      setProgress(0);
      const result = await unlockWithWrapped(blob, passphrase, {
        ...(expected ? { expectedFingerprint: expected } : {}),
        ...(remember && info ? { rememberDevice: { mailbox: info.mailbox } } : {}),
        onProgress: (fraction) => setProgress(fraction),
      });
      setPassphrase("");
      saveWrappedKey(keepBlob ? blob : null);
      if (!keepBlob) setBlob("");
      setDevice(loadDeviceRecord());
      if (result.rememberError) return `Unlocked, but this device will not remember the key: ${result.rememberError}`;
      return remember ? "Unlocked. This device now remembers the key behind your passkey." : "Unlocked.";
    });

  const fingerprintNote = state && expected ? (state.fingerprint === expected ? " It matches this mailbox's key." : " It does not match this mailbox's key.") : "";

  return (
    <>
      {info?.unlocked ? (
        <p className="muted">This local API holds the envelope private key and opens bodies itself; you don't need to unlock here.</p>
      ) : (
        <p className="muted">
          The API stores message bodies sealed to your envelope key and cannot open them. Unlock the key here to read mail in this
          browser. It is decrypted in this tab, kept in memory as a key the page cannot export, and never sent anywhere.
        </p>
      )}
      <p className={state ? "" : "muted"}>
        {state
          ? `Unlocked: key ${state.fingerprint}, ${sourceLabel(state)}.${fingerprintNote} Locks after ${idle} minutes without activity, and after 12 hours.`
          : (lockNote(lastLockReason()) ?? "Locked. Mail bodies stay sealed until you unlock.")}
      </p>
      {expected ? <p className="muted">This mailbox seals to key {expected}.</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="muted">{note}</p> : null}

      {state ? (
        <div className="actions flush">
          <button className="primary" type="button" onClick={() => lockKey("manual")}>
            Lock now
          </button>
        </div>
      ) : (
        <>
          {device ? (
            <div className="actions flush">
              <button className="primary" type="button" onClick={() => void run(async () => (await unlockWithPasskey(), "Unlocked with your passkey."))}>
                Unlock with passkey
              </button>
            </div>
          ) : null}
          <label htmlFor="wrapped-key">Wrapped key</label>
          <textarea
            id="wrapped-key"
            className="key"
            value={blob}
            onChange={(event) => setBlob(event.target.value)}
            placeholder="lojo-key-v1.…  (from lojo-bridge key export-wrapped, kept in your password manager)"
            autoComplete="off"
            spellCheck={false}
          />
          <label htmlFor="wrapped-file">…or open the file</label>
          <input
            id="wrapped-file"
            type="file"
            accept=".txt,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then((text) => setBlob(text.trim()));
              event.target.value = "";
            }}
          />
          <label htmlFor="key-passphrase">Key passphrase</label>
          <input
            id="key-passphrase"
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && blob && passphrase) void unlock();
            }}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            autoComplete="off"
            spellCheck={false}
          />
          <label className="check" htmlFor="keep-blob">
            <input id="keep-blob" type="checkbox" checked={keepBlob} onChange={(event) => setKeepBlob(event.target.checked)} />
            Keep the wrapped key in this browser (the passphrase is never kept)
          </label>
          <label className="check" htmlFor="remember-device">
            <input
              id="remember-device"
              type="checkbox"
              checked={remember}
              disabled={prf === "no"}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Remember on this device with a passkey
            {prf === "no" ? " (not available: this browser has no passkey PRF support)" : " (asks for your fingerprint, face, or device PIN)"}
          </label>
          <div className="actions flush">
            <button className="primary" type="button" disabled={!blob.trim() || !passphrase.trim() || progress !== null} onClick={() => void unlock()}>
              {progress === null ? "Unlock" : `Unlocking… ${Math.round(progress * 100)}%`}
            </button>
          </div>
        </>
      )}

      <label htmlFor="idle">Auto-lock after</label>
      <select
        id="idle"
        value={idle}
        onChange={(event) => {
          const minutes = Number(event.target.value);
          setIdleMinutes(minutes);
          setIdle(minutes);
        }}
      >
        {IDLE_CHOICES.map((minutes) => (
          <option key={minutes} value={minutes}>
            {minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`} without activity
          </option>
        ))}
      </select>

      {device ? (
        <>
          <p className="muted">
            This device remembers key {device.fingerprint} behind a passkey (since {new Date(device.created).toLocaleDateString()}).
          </p>
          <div className="actions flush">
            <button
              className="ghost"
              type="button"
              onClick={() => {
                forgetDevice();
                setDevice(null);
                setNote("This device no longer remembers the key. You can also delete the lojo-mail passkey in your passkey manager.");
              }}
            >
              Forget this device
            </button>
          </div>
        </>
      ) : null}

      {savedWrappedKey() ? (
        <div className="actions flush">
          <button
            className="ghost"
            type="button"
            onClick={() => {
              saveWrappedKey(null);
              setKeepBlob(false);
              setBlob("");
              setNote("The wrapped key is no longer kept in this browser.");
            }}
          >
            Remove the kept wrapped key
          </button>
        </div>
      ) : null}

      <details>
        <summary>Advanced: load a raw JWK (Santa or local development)</summary>
        <p className="muted">The raw key is imported as non-extractable and held in memory only; clear it from your clipboard afterwards.</p>
        <textarea
          className="key"
          value={jwkText}
          onChange={(event) => setJwkText(event.target.value)}
          placeholder='{"kty":"EC","crv":"P-256","x":"…","y":"…","d":"…"}'
          autoComplete="off"
          spellCheck={false}
        />
        <div className="actions flush">
          <button
            className="ghost"
            type="button"
            onClick={() =>
              void run(async () => {
                await unlockWithJwk(parsePrivateJwk(jwkText), expected);
                setJwkText("");
                return "Key loaded for this tab.";
              })
            }
          >
            Load raw key
          </button>
        </div>
      </details>
    </>
  );
}
