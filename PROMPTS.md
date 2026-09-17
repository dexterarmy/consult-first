# Prompt history

Cloudflare's assignment asks for the prompt history of AI-assisted work. This project was built
in a pair-programming session with Claude (Claude Code, Opus 5) on 2026-09-16/17. Below are my
prompts verbatim, in order, and a short note on what Claude did in response. Design proposals
came from Claude; every decision was mine.

Context: Claude was already helping me run my job search (a separate tool). When it found the
optional assignment on Cloudflare's application form, it recommended building it before applying.

---

**Me:** "ok I think we can go with B"
— Decision to build the assignment before applying rather than apply without it.

**Me:** "later in night , lets do the assignment for cloudfare. I will tell you when I am available"

**Me:** "let's do the Cloudflare assignment"
— Claude checked the machine (Node 20.9 → installed Node 22 via nvm because wrangler needs ≥22;
  no Cloudflare login yet), then proposed the theme: an agent that consults a policy table before
  acting and keeps a hash-chained witness log, mapped to the four required components (Workers AI
  LLM, Durable Object + Workflow, React chat, DO SQLite state). I accepted the theme.
— Claude tried the official `agents-starter` template; github.com was unreachable from my network,
  so it fetched the starter's files individually only to read the current Agents SDK / AI SDK API
  shapes, then wrote the project by hand: `wrangler.jsonc`, `src/witness.ts`, `src/policy.ts`,
  `src/server.ts` (agent, tools, Workflow), `src/client/App.tsx`, styles.
— First `npm install` failed on peer ranges (vite 7 vs plugin-react wanting 8; a workers-types
  version that doesn't exist). Fixed by bumping vite and using `wrangler types` instead.
— First build failed: `@cloudflare/ai-chat@0.9` was incompatible with `agents@0.23`; upgraded
  ai-chat to 0.12. Typecheck and build then passed.
— Claude wrote unit tests for the chain and policy logic (5 tests, all passing), this README and
  this file.

_(continued below as the session goes on)_
