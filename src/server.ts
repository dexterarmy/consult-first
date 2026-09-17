import { routeAgentRequest, getAgentByName } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import { consult, DEFAULT_POLICIES, type Policy, type Verdict } from "./policy";
import { makeRecord, verifyChain, type ChainVerdict, type WitnessRecord } from "./witness";

// State that is synced live to every connected browser tab.
export interface ConsultState {
  policies: Policy[];
  witness: WitnessRecord[]; // most recent records, newest last
  lastAudit: ChainVerdict | null;
  auditRunning: boolean;
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const WITNESS_MIRROR = 50; // how many recent records the UI receives

// Mock "systems of record" the governed tools act on. In a real deployment
// these would be API calls; here they only need to be believable enough to
// exercise the consult -> approve -> act -> witness loop.
const CUSTOMERS: Record<string, { name: string; email: string; phone: string; plan: string }> = {
  "asha mehta": { name: "Asha Mehta", email: "asha.mehta@example.com", phone: "+91 98xxx xx210", plan: "Pro" },
  "rahul verma": { name: "Rahul Verma", email: "rahul.verma@example.com", phone: "+91 97xxx xx884", plan: "Starter" },
  "priya nair": { name: "Priya Nair", email: "priya.nair@example.com", phone: "+91 99xxx xx017", plan: "Enterprise" }
};

const SYSTEM_PROMPT = `You are consult-first, an assistant that must consult policy before it acts.

Rules you follow without exception:
1. Before calling ANY action tool (lookupCustomer, sendNotification, deleteRecord, addPolicy), first call consultPolicy with a one-sentence description of what you intend to do.
2. Obey the verdict consultPolicy returns:
   - "deny": do not perform the action. Tell the user which policy applies and why, in one or two sentences.
   - "needs-approval": call the action tool; the platform will pause and ask the user to approve. Do not pretend the action happened until the tool returns a result.
   - "allow": proceed.
3. Never invent customer data. Only report what lookupCustomer returned.
4. Every consultation and action is written to a tamper-evident witness log. If the user asks about the log, use verifyWitnessChain or runAudit.
5. Be brief and concrete. Say what you are about to do before you do it.

You can also answer general questions directly; consultation is only required before actions.`;

export class ConsultAgent extends AIChatAgent<Env, ConsultState> {
  maxPersistedMessages = 100;

  initialState: ConsultState = {
    policies: DEFAULT_POLICIES,
    witness: [],
    lastAudit: null,
    auditRunning: false
  };

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS witness (
      seq INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      verdict TEXT NOT NULL,
      detail TEXT NOT NULL,
      prevHash TEXT NOT NULL,
      hash TEXT NOT NULL
    )`;
    this.mirrorWitness();
  }

  // ---- witness log --------------------------------------------------------

  private lastRecord(): WitnessRecord | null {
    const rows = this.sql<WitnessRecord>`SELECT * FROM witness ORDER BY seq DESC LIMIT 1`;
    return rows[0] ?? null;
  }

  private async witness(input: Pick<WitnessRecord, "kind" | "subject" | "verdict" | "detail">): Promise<WitnessRecord> {
    const record = await makeRecord(this.lastRecord(), input);
    this.sql`INSERT INTO witness (seq, ts, kind, subject, verdict, detail, prevHash, hash)
      VALUES (${record.seq}, ${record.ts}, ${record.kind}, ${record.subject}, ${record.verdict}, ${record.detail}, ${record.prevHash}, ${record.hash})`;
    this.mirrorWitness();
    return record;
  }

  private mirrorWitness() {
    const rows = this.sql<WitnessRecord>`SELECT * FROM witness ORDER BY seq DESC LIMIT ${WITNESS_MIRROR}`;
    this.setState({ ...this.state, witness: rows.reverse() });
  }

  // Public RPC methods, called by the audit Workflow over the Durable Object stub.
  async exportWitness(): Promise<WitnessRecord[]> {
    return this.sql<WitnessRecord>`SELECT * FROM witness ORDER BY seq ASC`;
  }

  async recordAudit(verdict: ChainVerdict) {
    await this.witness({
      kind: "audit",
      subject: "witness-audit workflow",
      verdict: verdict.ok ? "ok" : "broken",
      detail: verdict.ok
        ? `${verdict.length} records verified`
        : `broken at seq ${verdict.brokenAt}: ${verdict.reason}`
    });
    this.setState({ ...this.state, lastAudit: verdict, auditRunning: false });
  }

  // ---- chat ---------------------------------------------------------------

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai(MODEL),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(this.messages),
      tools: {
        consultPolicy: tool({
          description:
            "Consult the policy table before taking an action. Returns a verdict (allow | needs-approval | deny) and guidance. Must be called before every action tool.",
          inputSchema: z.object({
            intendedAction: z.string().describe("One sentence describing what you intend to do, e.g. 'look up Asha Mehta's customer record'")
          }),
          execute: async ({ intendedAction }) => {
            const c = consult(this.state.policies, intendedAction);
            const rec = await this.witness({
              kind: "consult",
              subject: intendedAction,
              verdict: c.verdict,
              detail: c.matched.length ? `matched: ${c.matched.map((p) => p.name).join("; ")}` : "no policy matched"
            });
            return { verdict: c.verdict, guidance: c.guidance, matchedPolicies: c.matched.map((p) => p.name), witnessSeq: rec.seq };
          }
        }),

        lookupCustomer: tool({
          description: "Look up a customer record by full name. Contains personal data, so it needs user approval.",
          inputSchema: z.object({ name: z.string().describe("Customer full name") }),
          needsApproval: true,
          execute: async ({ name }) => {
            const hit = CUSTOMERS[name.trim().toLowerCase()];
            await this.witness({
              kind: "action",
              subject: `lookupCustomer(${name})`,
              verdict: "executed",
              detail: hit ? "record returned" : "no such customer"
            });
            return hit ?? { error: `No customer named "${name}"` };
          }
        }),

        sendNotification: tool({
          description: "Send a notification message to a customer. Requires user approval; include the full message text.",
          inputSchema: z.object({
            to: z.string().describe("Customer full name"),
            message: z.string().describe("The exact message text")
          }),
          needsApproval: true,
          execute: async ({ to, message }) => {
            const rec = await this.witness({
              kind: "action",
              subject: `sendNotification(${to})`,
              verdict: "executed",
              detail: `message: ${message.slice(0, 80)}`
            });
            return { delivered: true, to, witnessSeq: rec.seq };
          }
        }),

        deleteRecord: tool({
          description: "Delete a customer record by full name. Irreversible; requires user approval.",
          inputSchema: z.object({ name: z.string().describe("Customer full name") }),
          needsApproval: true,
          execute: async ({ name }) => {
            const key = name.trim().toLowerCase();
            const existed = key in CUSTOMERS;
            if (existed) delete CUSTOMERS[key];
            await this.witness({
              kind: "action",
              subject: `deleteRecord(${name})`,
              verdict: "executed",
              detail: existed ? "record deleted" : "no such record"
            });
            return { deleted: existed, name };
          }
        }),

        listPolicies: tool({
          description: "List the policies currently loaded.",
          inputSchema: z.object({}),
          execute: async () => this.state.policies
        }),

        addPolicy: tool({
          description: "Add a policy to the table. Changing policy requires user approval.",
          inputSchema: z.object({
            name: z.string(),
            keywords: z.array(z.string()).min(1),
            verdict: z.enum(["allow", "needs-approval", "deny"]),
            guidance: z.string()
          }),
          needsApproval: true,
          execute: async ({ name, keywords, verdict, guidance }) => {
            const policy: Policy = { id: `p-${crypto.randomUUID().slice(0, 8)}`, name, keywords, verdict: verdict as Verdict, guidance };
            this.setState({ ...this.state, policies: [...this.state.policies, policy] });
            const rec = await this.witness({ kind: "policy-change", subject: `addPolicy(${name})`, verdict, detail: `keywords: ${keywords.join(", ")}` });
            return { added: policy.id, witnessSeq: rec.seq };
          }
        }),

        verifyWitnessChain: tool({
          description: "Verify the integrity of the witness log inline (fast, synchronous).",
          inputSchema: z.object({}),
          execute: async () => verifyChain(await this.exportWitness())
        }),

        runAudit: tool({
          description: "Start the witness-audit Workflow, which verifies the chain as a durable multi-step job and records the result in the log.",
          inputSchema: z.object({}),
          execute: async () => {
            const instance = await this.env.WITNESS_AUDIT.create({ params: { agentName: this.name } });
            this.setState({ ...this.state, auditRunning: true });
            return { workflowInstanceId: instance.id, status: "queued" };
          }
        })
      },
      stopWhen: stepCountIs(8),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

// ---- Workflow: durable, multi-step verification of the witness chain --------

type AuditParams = { agentName: string };

export class WitnessAuditWorkflow extends WorkflowEntrypoint<Env, AuditParams> {
  async run(event: WorkflowEvent<AuditParams>, step: WorkflowStep) {
    const { agentName } = event.payload;

    const records = await step.do("fetch witness log", async () => {
      const agent = await getAgentByName(this.env.ConsultAgent, agentName);
      return await agent.exportWitness();
    });

    const verdict = await step.do("verify hash chain", async () => verifyChain(records));

    await step.do("record audit result", async () => {
      const agent = await getAgentByName(this.env.ConsultAgent, agentName);
      await agent.recordAudit(verdict);
    });

    return verdict;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (await routeAgentRequest(request, env)) || new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
