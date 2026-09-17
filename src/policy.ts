// The policy table the agent consults before every governed action.
//
// A policy is a small rule: when an intended action matches its keywords,
// the policy's verdict applies. Verdicts are ordered deny > needs-approval >
// allow, so the strictest matching policy wins. Guidance is returned to the
// model as text; the model never gets a raw "yes/no" it could ignore.

export type Verdict = "allow" | "needs-approval" | "deny";

export interface Policy {
  id: string;
  name: string;
  keywords: string[]; // matched case-insensitively against the intended action
  verdict: Verdict;
  guidance: string; // what the assistant must do / say if this policy applies
}

export const DEFAULT_POLICIES: Policy[] = [
  {
    id: "p-pii",
    name: "Personal data stays inside",
    keywords: ["email", "phone", "address", "customer record", "pii", "personal data", "lookup customer"],
    verdict: "needs-approval",
    guidance: "Looking up or sharing a person's contact details requires the user's explicit approval first, and the assistant must state what will be shared."
  },
  {
    id: "p-delete",
    name: "Destructive changes are gated",
    keywords: ["delete", "remove", "drop", "purge", "erase"],
    verdict: "needs-approval",
    guidance: "Deleting or purging data is irreversible. Ask for approval and name the exact record before proceeding."
  },
  {
    id: "p-outbound",
    name: "No unsolicited outbound messages",
    keywords: ["send notification", "notify", "email blast", "sms", "message all", "broadcast"],
    verdict: "needs-approval",
    guidance: "Outbound messages to people require approval and must include the message text for review."
  },
  {
    id: "p-legal",
    name: "No legal or medical advice",
    keywords: ["legal advice", "sue", "lawsuit", "diagnose", "prescribe", "medical advice"],
    verdict: "deny",
    guidance: "The assistant must not give legal or medical advice. Say so plainly and suggest consulting a professional."
  },
  {
    id: "p-read",
    name: "Read-only lookups are fine",
    keywords: ["list", "show", "summarize", "explain", "status", "report", "read"],
    verdict: "allow",
    guidance: "Read-only information requests are allowed without approval."
  }
];

const RANK: Record<Verdict, number> = { allow: 0, "needs-approval": 1, deny: 2 };

export interface Consultation {
  verdict: Verdict;
  matched: Policy[]; // every policy that matched, strictest first
  guidance: string;
}

export function consult(policies: Policy[], intendedAction: string): Consultation {
  const text = intendedAction.toLowerCase();
  const matched = policies
    .filter((p) => p.keywords.some((k) => text.includes(k.toLowerCase())))
    .sort((a, b) => RANK[b.verdict] - RANK[a.verdict]);
  if (matched.length === 0) {
    return {
      verdict: "allow",
      matched: [],
      guidance: "No policy matched. Proceed, but say what you are about to do before doing it."
    };
  }
  const top = matched[0];
  return {
    verdict: top.verdict,
    matched,
    guidance: matched.map((p) => `[${p.name}] ${p.guidance}`).join(" ")
  };
}
