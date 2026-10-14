# consult-first

An AI chat agent on Cloudflare that **consults a policy table before it acts**, pauses for
human approval when policy says so, and writes a **hash-chained witness record** of every
consultation and action. A durable Workflow audits the chain on demand.

## What it does

Ask it to do something — look up a customer, send a notification, delete a record. Before any
of those tools run, the model must call `consultPolicy` with a one-line description of what it
intends to do. The policy table returns a verdict:

| Verdict | What happens |
|---|---|
| `allow` | the action runs |
| `needs-approval` | the tool call pauses and the UI shows Approve / Deny; nothing runs until you click |
| `deny` | the model refuses and names the policy |

Every consultation, every executed action, every policy change and every audit appends a record to
the witness log. Each record's SHA-256 covers the previous record's hash, so altering or deleting
any record breaks every hash after it. The sidebar shows the log live.

## The four required components

| Requirement | Where |
|---|---|
| **LLM** | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) via `workers-ai-provider` + the AI SDK's `streamText` with tool calling — `src/server.ts` |
| **Workflow / coordination** | One Durable Object per chat (`ConsultAgent`, built on the Cloudflare Agents SDK) runs the consult → approve → act → witness loop. A Cloudflare **Workflow** (`WitnessAuditWorkflow`) fetches the log from the DO over RPC, verifies the chain as a durable step, and writes the result back — `src/server.ts` |
| **User input via chat** | React chat UI served as Worker static assets; WebSocket to the agent through `useAgent` / `useAgentChat`, with tool-approval buttons — `src/client/App.tsx` |
| **Memory / state** | Chat history (persisted by `AIChatAgent`), the policy table (agent state, synced to every tab), and the witness log (a table in the DO's SQLite) — all survive reloads and hibernation |

## Run it

```bash
npm install
npx wrangler login          # Workers AI is a remote binding, so dev needs an account
npm run dev                 # http://localhost:5173
npm test                    # witness-chain + policy unit tests (no Cloudflare needed)
npm run deploy
```

## Try this sequence

1. "Look up Asha Mehta's customer record" → consult says `needs-approval` (personal data) → Approve → record returned, two witness entries.
2. "Delete Priya Nair's record" → `needs-approval` → **Deny** → the tool never runs.
3. "Can you give me legal advice about a contract?" → `deny` → refusal, one witness entry.
4. "Run an audit of the witness log" → the Workflow verifies the chain and appends an `audit … ok` record.
5. "Add a policy: anything mentioning 'refund' needs approval" → `addPolicy` pauses for approval, then the sidebar updates.

## Layout

```
src/server.ts        ConsultAgent (Durable Object) + tools + WitnessAuditWorkflow + fetch handler
src/policy.ts        policy table and consult()
src/witness.ts       hash-chained records, makeRecord(), verifyChain()
src/client/          React UI
test/                unit tests
PROMPTS.md           prompt history (AI-assisted build, as the assignment asks)
```

## Design notes

- The model never receives a bare yes/no it could ignore; `consultPolicy` returns guidance text and
  the system prompt makes the call mandatory before action tools. Approval itself is enforced by the
  platform (`needsApproval: true`), not by the model.
- The witness chain is append-only within the DO. A real deployment would anchor the head hash
  somewhere external (KV, R2, a log) so the DO owner could not rewrite history; this demo keeps
  it in one place for clarity and exposes `verifyWitnessChain` / the audit Workflow instead.
- The customer "system of record" is an in-memory mock. Deleting a record really deletes it for the
  lifetime of the isolate — enough to make the approval gate meaningful.

## Prior art

This is a small, from-scratch cousin of the platform work I do professionally on an AI-governance
runtime delivered as an MCP service, where agents consult policy before acting and every call
produces a tamper-evident witness record.
