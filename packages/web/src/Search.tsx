import { useState } from "react";
import { api } from "./api.ts";
import { person, when, type Message } from "./types.ts";

export function Search() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"keyword" | "semantic">("keyword");
  const [results, setResults] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function run(event: { preventDefault: () => void }) {
    event.preventDefault();
    setError(null);
    try {
      const body = await api<{ messages: Message[] }>("/v1/search", {
        method: "POST",
        body: JSON.stringify({ query, mode }),
      });
      setResults(body.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    }
  }

  return (
    <form className="panel" onSubmit={(event) => void run(event)}>
      <header>
        <h2>Search</h2>
        <a className="back" href="#/inbox">Back</a>
      </header>
      <label htmlFor="q">Query</label>
      <input id="q" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="lease, or a phrase from a letter" />
      <label htmlFor="mode">Mode</label>
      <select id="mode" value={mode} onChange={(event) => setMode(event.target.value === "semantic" ? "semantic" : "keyword")}>
        <option value="keyword">Keyword, including the body when unlocked</option>
        <option value="semantic">Semantic</option>
      </select>
      <div className="actions" style={{ padding: "16px 0" }}>
        <button className="primary" type="submit">Search</button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="rows">
        {results.map((message) => (
          <a className="row" key={message.id} href={`#/thread/${message.threadId}`}>
            <strong>{person(message.from)}</strong>
            <div className="subject">{message.subject}</div>
            <div className="snippet">{message.summary || message.snippet}</div>
            <div className="muted">{when(message.date)}</div>
          </a>
        ))}
      </div>
    </form>
  );
}
