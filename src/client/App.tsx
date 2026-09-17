import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ConsultAgent, ConsultState } from "../server";
import type { WitnessRecord } from "../witness";

const EMPTY: ConsultState = { policies: [], witness: [], lastAudit: null, auditRunning: false };

const SUGGESTIONS = [
  "Look up Asha Mehta's customer record",
  "Send Rahul Verma a notification that his invoice is ready",
  "Delete Priya Nair's record",
  "Can you give me legal advice about a contract?",
  "Show me the policies you follow",
  "Run an audit of the witness log"
];

export default function App() {
  const [state, setState] = useState<ConsultState>(EMPTY);
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<ConsultAgent, ConsultState>({
    agent: "ConsultAgent",
    name: "default",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onStateUpdate: useCallback((s: ConsultState) => setState(s), [])
  });

  const { messages, sendMessage, clearHistory, addToolApprovalResponse, stop, status } = useAgentChat({ agent });
  const busy = status === "streaming" || status === "submitted";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    sendMessage({ role: "user", parts: [{ type: "text", text: t }] });
    setInput("");
  };

  return (
    <div className="layout">
      <main className="chat">
        <header>
          <div>
            <h1>consult-first</h1>
            <p className="sub">An agent that consults policy before it acts, and writes a witness record every time.</p>
          </div>
          <div className="header-right">
            <span className={`dot ${connected ? "on" : "off"}`} title={connected ? "connected" : "disconnected"} />
            <button className="ghost" onClick={clearHistory} disabled={busy}>Clear chat</button>
          </div>
        </header>

        <section className="messages">
          {messages.length === 0 && (
            <div className="empty">
              <p>Try one of these. Watch the witness log on the right fill up as the agent consults policy, asks for approval, and acts.</p>
              <div className="chips">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip" onClick={() => submit(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m: UIMessage) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.parts.map((part, i) => {
                const key = `${m.id}-${i}`;
                if (part.type === "text") return <p key={key} className="text">{part.text}</p>;
                if (isToolUIPart(part)) {
                  const name = getToolName(part);
                  const st = part.state;
                  if (st === "approval-requested") {
                    return (
                      <div key={key} className="tool approval">
                        <div className="tool-head">⚠️ Approval needed: <code>{name}</code></div>
                        <pre>{JSON.stringify(part.input, null, 2)}</pre>
                        <div className="row">
                          <button onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: true })}>Approve</button>
                          <button className="ghost" onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: false })}>Deny</button>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <details key={key} className={`tool ${st}`} open={st === "output-available" && name === "consultPolicy"}>
                      <summary>
                        <code>{name}</code> <span className="state">{st.replace(/-/g, " ")}</span>
                      </summary>
                      {"input" in part && part.input !== undefined && <pre>in: {JSON.stringify(part.input, null, 2)}</pre>}
                      {st === "output-available" && <pre>out: {JSON.stringify(part.output, null, 2)}</pre>}
                      {st === "output-denied" && <p className="denied">Denied by user — not executed.</p>}
                      {st === "output-error" && <p className="denied">Error: {part.errorText}</p>}
                    </details>
                  );
                }
                return null;
              })}
            </div>
          ))}
          <div ref={endRef} />
        </section>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={busy ? "Thinking…" : "Ask the agent to do something…"}
            disabled={busy}
          />
          {busy ? (
            <button type="button" className="ghost" onClick={stop}>Stop</button>
          ) : (
            <button type="submit" disabled={!input.trim()}>Send</button>
          )}
        </form>
      </main>

      <aside className="side">
        <section>
          <h2>Policies <span className="count">{state.policies.length}</span></h2>
          <ul className="policies">
            {state.policies.map((p) => (
              <li key={p.id}>
                <span className={`verdict ${p.verdict}`}>{p.verdict}</span>
                <strong>{p.name}</strong>
                <small>{p.keywords.join(" · ")}</small>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>
            Witness log <span className="count">{state.witness.length}</span>
            {state.auditRunning && <span className="audit running">audit running…</span>}
            {!state.auditRunning && state.lastAudit && (
              <span className={`audit ${state.lastAudit.ok ? "ok" : "broken"}`}>
                last audit: {state.lastAudit.ok ? `ok (${state.lastAudit.length})` : `broken @${state.lastAudit.brokenAt}`}
              </span>
            )}
          </h2>
          <p className="hint">Each record's hash covers the previous hash. Change one, and every hash after it fails verification.</p>
          <ol className="witness">
            {[...state.witness].reverse().map((r: WitnessRecord) => (
              <li key={r.seq}>
                <div className="w-head">
                  <span className="seq">#{r.seq}</span>
                  <span className={`kind ${r.kind}`}>{r.kind}</span>
                  <span className={`verdict ${r.verdict}`}>{r.verdict}</span>
                </div>
                <div className="w-subject">{r.subject}</div>
                <div className="w-detail">{r.detail}</div>
                <div className="w-hash" title={`prev: ${r.prevHash}`}>{r.hash.slice(0, 16)}… ← {r.prevHash.slice(0, 8)}</div>
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </div>
  );
}
