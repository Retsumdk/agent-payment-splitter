# agent-payment-splitter

Deterministic payment splitting for collaborative agent tasks — escrow, weighted splits, dispute lifecycle, and reconciliation over a hash-chained journal.

![CI](https://github.com/Retsumdk/agent-payment-splitter/actions/workflows/ci.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## The problem

When an AI agent orchestrates paid work across several contributors (scout agents, writer agents, reviewer agents), somebody has to move the money. Doing it ad hoc fails in three predictable ways:

- **Float drift.** Splitting `100.00` three ways with naive `total / n * share` math produces numbers like `33.333333333333336 + 33.333333333333336 + 33.33333333333333 = 99.99999...`. Real money and per-agent ledgers need integer-exact arithmetic with a deterministic rule for the leftover cents.
- **No dispute path.** The moment a contributor contests their share, you need the escrow frozen, the dispute recorded, and a settlement that can re-weight without losing history.
- **No audit trail.** "Why did agent X receive 53.98?" must be answerable from a tamper-evident ledger, not from memory.

## The solution

`agent-payment-splitter` is a small, zero-runtime-dependency TypeScript library + CLI that treats a payout the way git treats history:

- **Escrow first.** A payer funds a fixed total against a declared contributor list and split policy. Nothing is paid until every contributor confirms.
- **Integer math, deterministic dust.** All amounts are integer minor units (cents). Splits use largest-remainder allocation with a tiebreak by id, so the same inputs always produce the same payouts that sum exactly to the total.
- **Hash-chained journal.** Every mutation is one JSONL record: `sha256(seq | prevHash | canonical(record))`. Reopen the journal and state replays; touch a byte anywhere in history and verification fails loudly.
- **Dispute lifecycle.** `open → disputed → open → released` (or `→ refunded`). Resolving a dispute can install a new split policy; the original policy stays in the journal.
- **Reconciliation is a pure read.** Project every payout — fees, shares, unconfirmed blockers — without mutating anything.

## How it works

```
escrow_created ──► contributor_confirmed (×N) ──► escrow_released
      │                                             ▲
      ├──► dispute_opened ──► dispute_resolved ─────┘
      └──► escrow_refunded (before any payout)

Journal: {"seq":0,"hash":"a91f…","record":{…}}  ← one line per event
```

1. `createEscrow(spec)` validates the spec (integer total, unique contributor ids, payer not a payee, policy covering every contributor) and appends `escrow_created`. Escrow ids are content-derived (`esc_` + 16 hex chars), so the same spec yields the same id.
2. Each contributor calls `confirm(escrowId, contributorId)`.
3. `reconcile(escrowId)` is a read-only report: fee, distributable units, per-contributor weights, pending units, and `readyForRelease`.
4. `release(escrowId)` carves the platform fee out first (`feeBps` of the total, floored), splits the remainder by policy, and appends the payouts. Payouts always sum to the total.
5. `refund(escrowId)` closes an escrow back to the payer — only before any payout exists.

The fee is carved out **before** shares, and fees go to the `payee` (defaulting to the payer, which is useful when the payer is also the platform).

### Splitting rules

- `equal` — every contributor gets weight 1.
- `weights: {agentId: weight}` — integer weights; contributors absent from the map are a validation error.
- The largest-remainder step: floor each `total × weight / weightSum`, then hand out the leftover cents to the highest fractional remainder, ties broken by ascending id. Order-independent, byte-for-byte reproducible.

## Getting started

Requires [Bun](https://bun.sh) 1.1+ (or Node 18+ after a build).

```bash
git clone https://github.com/Retsumdk/agent-payment-splitter.git
cd agent-payment-splitter
bun install
bun test          # 33 tests
bun run demo      # scripted end-to-end walkthrough
```

Install as a library (the `prepare` script builds `dist/` on install):

```bash
npm install github:Retsumdk/agent-payment-splitter
```

## CLI usage

The `aps` CLI writes to a journal file (default `./journal.jsonl`):

```bash
$ cat > spec.json <<'EOF'
{"taskId":"deploy-42","payer":"orchestrator-7","payee":"platform","feeBps":250,
 "total":1000000,"contributors":["recon","coder","tester"],"policy":{"kind":"equal"}}
EOF
$ aps create --spec-file spec.json
{"id":"esc_f7ff662c2b7c5d8f", … "state":"open"}
$ aps confirm esc_f7ff662c2b7c5d8f recon
$ aps confirm esc_f7ff662c2b7c5d8f coder
$ aps confirm esc_f7ff662c2b7c5d8f tester
$ aps release esc_f7ff662c2b7c5d8f
platform	25000	fee
coder	325000	share
recon	325000	share
tester	325000	share
$ aps verify
{"ok":true,"records":5,"head":"710d1dc61cffeb5e…"}
```

`1000000` cents = `$10,000.00`: a 2.5% platform fee (`25000`), then `$3,250.00` to each of three contributors. Exact.

`--json` pretty-prints any command's output as JSON; `--journal <file>` picks the ledger.

## Library usage

```ts
import { Journal, PaymentSplitter, formatUnits } from "agent-payment-splitter";

const splitter = new PaymentSplitter(new Journal("journal.jsonl"));

const escrow = splitter.createEscrow({
  taskId: "agent-research-brief",
  payer: "acme-agent",
  payee: "platform",
  feeBps: 500,
  total: 12_500,
  contributors: ["scout-1", "scout-2", "writer", "reviewer"],
  policy: { kind: "weights", weights: { "scout-1": 2, "scout-2": 2, writer: 5, reviewer: 1 } },
});

for (const id of ["scout-1", "scout-2", "writer"]) splitter.confirm(escrow.id, id);
splitter.dispute(escrow.id, "reviewer disputes their 1x weight");
splitter.resolve(escrow.id, {
  kind: "weights",
  weights: { "scout-1": 2, "scout-2": 2, writer: 5, reviewer: 2 },
});
splitter.confirm(escrow.id, "reviewer");

const payouts = splitter.release(escrow.id);
console.log(payouts);
// [
//   { to: "platform", units: 625, role: "fee" },
//   { to: "reviewer", units: 2159, role: "share" },
//   { to: "scout-1",  units: 2159, role: "share" },
//   { to: "scout-2",  units: 2159, role: "share" },
//   { to: "writer",   units: 5398, role: "share" }
// ]
```

## HTTP server

A minimal zero-dependency HTTP surface ships in `src/server.ts`. Reads are open; writes require a bearer token via `APS_TOKEN` (writes are refused entirely when it is unset, so an unconfigured deployment can't be mutated by accident):

```bash
APS_TOKEN=secret PORT=8787 bun src/server.ts

curl -X POST http://localhost:8787/api/escrow \
  -H "authorization: Bearer secret" -H "content-type: application/json" \
  -d @spec.json
curl http://localhost:8787/api/escrow/esc_f7ff662c2b7c5d8f   # state + reconciliation
```

Routes: `GET /health`, `GET /api/escrows`, `GET /api/escrow/:id`, and `POST /api/escrow` + `/confirm` `/dispute` `/resolve` `/release` `/refund`. Validation errors surface as `4xx` with machine-readable codes (`validation`, `not_found`, `state`).

## Reconciliation report

```json
{
  "escrowId": "esc_f7ff662c2b7c5d8f",
  "state": "released",
  "totalUnits": 1000000,
  "feeUnits": 25000,
  "feePayee": "platform",
  "distributableUnits": 975000,
  "declaredCount": 3,
  "confirmedCount": 3,
  "contributors": [
    { "contributorId": "coder",  "weight": 1, "confirmed": true, "pendingUnits": 325000 },
    { "contributorId": "recon",  "weight": 1, "confirmed": true, "pendingUnits": 325000 },
    { "contributorId": "tester", "weight": 1, "confirmed": true, "pendingUnits": 325000 }
  ],
  "unconfirmed": [],
  "readyForRelease": false
}
```

`readyForRelease` is `false` once an escrow is terminal; while open it flips only when every declared contributor has confirmed.

## Project layout

```
src/
  money.ts    integer splitting: splitByWeights, feeUnitsFor, formatUnits
  types.ts    domain types + ApiError (validation / not_found / state)
  ids.ts      canonical JSON, content-derived ids, record hashes
  store.ts    Journal — append-only JSONL with sha256 hash chain + verify
  engine.ts   PaymentSplitter — create / confirm / dispute / resolve / release / refund / reconcile
  cli.ts      the aps command
  server.ts   optional HTTP surface
  index.ts    public library surface
examples/demo.ts          scripted walkthrough (output snapshot-checked in CI)
tests/engine.test.ts      26 engine/HTTP tests incl. tamper detection
tests/index.test.ts       7 barrel-surface + journal tests
```

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
bun test
bun run build       # emits dist/ with declarations
bun run demo        # prints a full escrow lifecycle
bun run demo:write  # regenerates examples/demo-output.txt (CI diffs this)
```

`examples/demo-output.txt` is committed. CI reruns the demo and fails if the bytes drift — the demo uses a fixed clock so the output, including escrow ids and the journal head hash, is a regression test for determinism.

## License

[MIT](LICENSE)
