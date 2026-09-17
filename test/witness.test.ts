import { test } from "node:test";
import assert from "node:assert/strict";
import { GENESIS, makeRecord, verifyChain, type WitnessRecord } from "../src/witness.ts";
import { consult, DEFAULT_POLICIES } from "../src/policy.ts";

async function chain(n: number): Promise<WitnessRecord[]> {
  const out: WitnessRecord[] = [];
  let prev: WitnessRecord | null = null;
  for (let i = 0; i < n; i++) {
    prev = await makeRecord(prev, { kind: "consult", subject: `action ${i}`, verdict: "allow", detail: "" });
    out.push(prev);
  }
  return out;
}

test("first record links to genesis and chain verifies", async () => {
  const c = await chain(5);
  assert.equal(c[0].prevHash, GENESIS);
  assert.equal(c[4].prevHash, c[3].hash);
  assert.deepEqual(await verifyChain(c), { ok: true, length: 5, brokenAt: null, reason: null });
});

test("altering a record breaks verification at that record", async () => {
  const c = await chain(5);
  c[2] = { ...c[2], detail: "tampered" };
  const v = await verifyChain(c);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3);
  assert.match(v.reason!, /altered/);
});

test("deleting a record breaks the sequence", async () => {
  const c = await chain(5);
  c.splice(1, 1);
  const v = await verifyChain(c);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3);
});

test("empty chain is valid", async () => {
  assert.equal((await verifyChain([])).ok, true);
});

test("strictest matching policy wins", () => {
  assert.equal(consult(DEFAULT_POLICIES, "show me the status").verdict, "allow");
  assert.equal(consult(DEFAULT_POLICIES, "look up Asha Mehta's customer record").verdict, "needs-approval");
  assert.equal(consult(DEFAULT_POLICIES, "delete the customer record and show status").verdict, "needs-approval");
  assert.equal(consult(DEFAULT_POLICIES, "give legal advice and then delete the record").verdict, "deny");
  assert.equal(consult(DEFAULT_POLICIES, "compose a haiku").verdict, "allow");
});
