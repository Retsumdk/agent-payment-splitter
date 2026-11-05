/**
 * agent-payment-splitter — public surface.
 *
 * Library entry: import what you need from the root package. The CLI lives in
 * ./cli.js and the optional HTTP server in ./server.js.
 */

export { PaymentSplitter, validatePolicy, validateSpec } from "./engine.js";
export { formatUnits, entriesForPolicy, feeUnitsFor, splitByWeights } from "./money.js";
export { canonicalJson, contentId, recordHash } from "./ids.js";
export { Journal } from "./store.js";
export { ApiError, StoreError } from "./types.js";
export type {
  ContributorState,
  Escrow,
  EscrowSpec,
  EscrowState,
  Payout,
  ReconcileContributor,
  ReconcileReport,
  RecordKind,
  SplitPolicy,
} from "./types.js";
export type { SplitEntry } from "./money.js";
