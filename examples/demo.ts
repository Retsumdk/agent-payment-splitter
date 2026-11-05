#!/usr/bin/env bun
/**
 * Deterministic end-to-end demo of the escrow lifecycle.
 *
 * Output is byte-stable (fixed clock, fixed ids) and is enforced against
 * examples/demo-output.txt by tests — edit the demo, run `bun run demo:write`,
 * and commit the refreshed snapshot together with the change.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PaymentSplitter } from "../src/engine.js";
import { Journal } from "../src/store.js";
import { formatUnits } from "../src/money.js";
import type { ReconcileReport } from "../src/types.js";

let now = Date.parse("2026-11-05T12:00:00.000Z");
const clock = (): number => (now += 1);
const dir = mkdtempSync(join(tmpdir(), "aps-demo-"));
const journal = join(dir, "demo-journal.jsonl");
const splitter = new PaymentSplitter(new Journal(journal, { create: true }), clock);

const escrow = splitter.createEscrow({
  taskId: "agent-research-brief",
  payer: "acme-agent",
  payee: "platform",
  feeBps: 500,
  contributors: ["scout-1", "scout-2", "writer", "reviewer"],
  total: 12_500,
  policy: { kind: "weights", weights: { "scout-1": 2, "scout-2": 2, writer: 5, reviewer: 1 } },
});
console.log(`1. created ${escrow.id} for ${formatUnits(escrow.total)} from ${escrow.payer}`);
console.log("   policy: weights {scout-1: 2, scout-2: 2, writer: 5, reviewer: 1}, platform fee 5.00%");

for (const id of ["scout-1", "scout-2", "writer"]) splitter.confirm(escrow.id, id);
const before = splitter.reconcile(escrow.id);
console.log(`2. three of four contributors confirmed -> readyForRelease: ${before.readyForRelease}`);

splitter.dispute(escrow.id, "reviewer disputes their 1x weight");
splitter.resolve(escrow.id, { kind: "weights", weights: { "scout-1": 2, "scout-2": 2, writer: 5, reviewer: 2 } });
console.log("3. dispute opened; re-weighting reviewer to 2x");

const after = splitter.reconcile(escrow.id);
console.log(`4. reconciled: ${after.confirmedCount}/${after.declaredCount} confirmed, readyForRelease: ${after.readyForRelease}`);
printReconcile(after);

splitter.confirm(escrow.id, "reviewer");
const payouts = splitter.release(escrow.id);
console.log(`5. released ${escrow.id}:`);
for (const p of payouts) {
  const role = p.role === "fee" ? "platform fee" : "share";
  console.log(`   ${p.to.padEnd(12)} ${formatUnits(p.units).padStart(8)}  (${role})`);
}

const released = splitter.get(escrow.id);
const total = released.payouts.reduce((acc, p) => acc + p.units, 0);
console.log(`6. payouts sum to ${formatUnits(total)} across ${released.payouts.length} records`);

console.log(`7. journal: ${journal.split("/").pop()} replays on load; verify: ${JSON.stringify(new Journal(journal).verify())}`);

function printReconcile(r: ReconcileReport): void {
  console.log(`   reconcile: total=${r.totalUnits} fee=${r.feeUnits} distributable=${r.distributableUnits}`);
  for (const c of r.contributors) {
    console.log(`   ${c.contributorId.padEnd(12)} weight=${String(c.weight).padStart(3)}  confirmed=${c.confirmed}  pending=${c.pendingUnits}`);
  }
}

rmSync(dir, { recursive: true, force: true });
