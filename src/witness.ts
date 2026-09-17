// Hash-chained witness records.
//
// Every policy consultation and every governed action appends one record.
// Each record's hash covers its own payload AND the previous record's hash,
// so editing or deleting any record breaks every hash after it. verifyChain()
// recomputes the chain from genesis and reports the first break.

export type WitnessKind = "consult" | "action" | "policy-change" | "audit";

export interface WitnessRecord {
  seq: number;
  ts: string; // ISO-8601
  kind: WitnessKind;
  subject: string; // the action or policy consulted
  verdict: string; // allow | needs-approval | deny | executed | denied-by-user | ok | broken
  detail: string; // short human-readable note
  prevHash: string; // hash of the previous record, "genesis" for the first
  hash: string; // sha256 over (seq, ts, kind, subject, verdict, detail, prevHash)
}

export const GENESIS = "genesis";

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Canonical serialisation: field order is fixed so hashes are reproducible.
export function canonical(r: Omit<WitnessRecord, "hash">): string {
  return JSON.stringify([r.seq, r.ts, r.kind, r.subject, r.verdict, r.detail, r.prevHash]);
}

export async function makeRecord(
  prev: WitnessRecord | null,
  input: Pick<WitnessRecord, "kind" | "subject" | "verdict" | "detail">,
  now: Date = new Date()
): Promise<WitnessRecord> {
  const partial = {
    seq: prev ? prev.seq + 1 : 1,
    ts: now.toISOString(),
    ...input,
    prevHash: prev ? prev.hash : GENESIS
  };
  return { ...partial, hash: await sha256Hex(canonical(partial)) };
}

export interface ChainVerdict {
  ok: boolean;
  length: number;
  brokenAt: number | null; // seq of the first bad record
  reason: string | null;
}

export async function verifyChain(records: WitnessRecord[]): Promise<ChainVerdict> {
  let prevHash = GENESIS;
  let expectedSeq = 1;
  for (const r of records) {
    if (r.seq !== expectedSeq) {
      return { ok: false, length: records.length, brokenAt: r.seq, reason: `sequence gap: expected ${expectedSeq}` };
    }
    if (r.prevHash !== prevHash) {
      return { ok: false, length: records.length, brokenAt: r.seq, reason: "prevHash does not match previous record" };
    }
    const { hash, ...rest } = r;
    const recomputed = await sha256Hex(canonical(rest));
    if (recomputed !== hash) {
      return { ok: false, length: records.length, brokenAt: r.seq, reason: "payload hash mismatch (record was altered)" };
    }
    prevHash = hash;
    expectedSeq++;
  }
  return { ok: true, length: records.length, brokenAt: null, reason: null };
}
