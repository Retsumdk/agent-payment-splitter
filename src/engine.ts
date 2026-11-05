import type {
  ContributorState,
  Escrow,
  EscrowSpec,
  Payout,
  ReconcileReport,
  RecordKind,
  SplitPolicy,
} from "./types.js";
import { ApiError } from "./types.js";
import { entriesForPolicy, feeUnitsFor, splitByWeights } from "./money.js";
import { contentId } from "./ids.js";
import { Journal } from "./store.js";

export type Clock = () => number;

export function validateSpec(spec: EscrowSpec): void {
  if (typeof spec.taskId !== "string" || spec.taskId.trim() === "") {
    throw ApiError.validation("taskId must be a non-empty string");
  }
  if (typeof spec.payer !== "string" || spec.payer.trim() === "") {
    throw ApiError.validation("payer must be a non-empty string");
  }
  if (!Number.isInteger(spec.total) || spec.total < 0) {
    throw ApiError.validation(`total must be a non-negative integer, got ${String(spec.total)}`);
  }
  if (!Array.isArray(spec.contributors) || spec.contributors.length === 0) {
    throw ApiError.validation("contributors must be a non-empty array of ids");
  }
  if (new Set(spec.contributors).size !== spec.contributors.length) {
    throw ApiError.validation("contributors must not contain duplicates");
  }
  if (spec.contributors.some((c) => typeof c !== "string" || c.trim() === "")) {
    throw ApiError.validation("contributor ids must be non-empty strings");
  }
  if (spec.contributors.includes(spec.payer)) {
    throw ApiError.validation("payer cannot also be a contributor");
  }
  validatePolicy(spec.policy, spec.contributors);
}

export function validatePolicy(policy: SplitPolicy, contributors: readonly string[]): void {
  if (policy.kind === "equal") return;
  const ids = [...new Set(contributors)].sort();
  const missing = ids.filter((id) => !(id in policy.weights));
  if (missing.length > 0) {
    throw ApiError.validation(`weights missing for contributors: ${missing.join(", ")}`);
  }
  const weightSum = ids.reduce((acc, id) => acc + (policy.weights[id] as number), 0);
  if (weightSum <= 0) {
    throw ApiError.validation("total weight must be positive when there is anything to split");
  }
}

/**
 * PaymentSplitter — escrow, deterministic splitting, and reconciliation for
 * collaborative agent tasks. All state is derived by replaying the journal;
 * every mutation appends exactly one record before mutating in-memory state.
 */
export class PaymentSplitter {
  private escrows = new Map<string, Escrow>();

  constructor(
    private readonly journal: Journal,
    private readonly clock: Clock = () => Date.now(),
  ) {
    for (const record of journal.all()) {
      this.apply(record);
    }
  }

  private apply(record: RecordKind): void {
    switch (record.kind) {
      case "escrow_created": {
        const spec = record.spec;
        const escrow: Escrow = {
          id: record.escrowId,
          taskId: spec.taskId,
          payer: spec.payer,
          payee: spec.payee ?? null,
          total: spec.total,
          feeBps: spec.feeBps ?? 0,
          policy: spec.policy,
          state: "open",
          contributors: Object.fromEntries(
            spec.contributors.map((id): [string, ContributorState] => [id, { id, confirmed: false }]),
          ),
          payouts: [],
          createdAt: record.at,
        };
        this.escrows.set(escrow.id, escrow);
        break;
      }
      case "contributor_confirmed": {
        const escrow = this.escrows.get(record.escrowId);
        if (!escrow) return;
        const c = escrow.contributors[record.contributorId];
        if (c) {
          c.confirmed = true;
          c.confirmedAt = record.at;
        }
        break;
      }
      case "dispute_opened": {
        const escrow = this.escrows.get(record.escrowId);
        if (!escrow) return;
        escrow.state = "disputed";
        escrow.disputeReason = record.reason;
        break;
      }
      case "dispute_resolved": {
        const escrow = this.escrows.get(record.escrowId);
        if (!escrow) return;
        escrow.state = "open";
        escrow.policy = record.policy;
        escrow.disputeReason = undefined;
        break;
      }
      case "escrow_released": {
        const escrow = this.escrows.get(record.escrowId);
        if (!escrow) return;
        escrow.state = "released";
        escrow.payouts = record.payouts;
        escrow.closedAt = record.at;
        break;
      }
      case "escrow_refunded": {
        const escrow = this.escrows.get(record.escrowId);
        if (!escrow) return;
        escrow.state = "refunded";
        escrow.closedAt = record.at;
        break;
      }
    }
  }

  private mustGet(escrowId: string): Escrow {
    const escrow = this.escrows.get(escrowId);
    if (!escrow) throw ApiError.notFound(`escrow not found: ${escrowId}`);
    return escrow;
  }

  createEscrow(spec: EscrowSpec): Escrow {
    validateSpec(spec);
    const escrowId = contentId("esc", {
      taskId: spec.taskId,
      payer: spec.payer,
      total: spec.total,
      policy: spec.policy,
      n: this.journal.size(),
    });
    if (this.escrows.has(escrowId)) {
      throw ApiError.validation(`escrow id collision: ${escrowId}`);
    }
    const record: RecordKind = { kind: "escrow_created", escrowId, spec, at: this.clock() };
    this.journal.append(record);
    this.apply(record);
    return structuredClone(this.escrows.get(escrowId) as Escrow);
  }

  confirm(escrowId: string, contributorId: string): ContributorState {
    const escrow = this.mustGet(escrowId);
    if (escrow.state !== "open") {
      throw ApiError.state(`escrow ${escrowId} is ${escrow.state}, not open`);
    }
    const contributor = escrow.contributors[contributorId];
    if (!contributor) {
      throw ApiError.notFound(`${contributorId} is not a declared contributor of ${escrowId}`);
    }
    if (contributor.confirmed) {
      throw ApiError.state(`${contributorId} already confirmed ${escrowId}`);
    }
    const record: RecordKind = {
      kind: "contributor_confirmed",
      escrowId,
      contributorId,
      at: this.clock(),
    };
    this.journal.append(record);
    this.apply(record);
    return structuredClone(this.escrows.get(escrowId)?.contributors[contributorId] as ContributorState);
  }

  dispute(escrowId: string, reason: string): Escrow {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw ApiError.validation("dispute reason must be a non-empty string");
    }
    const escrow = this.mustGet(escrowId);
    if (escrow.state !== "open") {
      throw ApiError.state(`escrow ${escrowId} is ${escrow.state}; only open escrows can be disputed`);
    }
    const record: RecordKind = { kind: "dispute_opened", escrowId, reason, at: this.clock() };
    this.journal.append(record);
    this.apply(record);
    return structuredClone(this.mustGet(escrowId));
  }

  resolve(escrowId: string, policy: SplitPolicy): Escrow {
    const escrow = this.mustGet(escrowId);
    if (escrow.state !== "disputed") {
      throw ApiError.state(`escrow ${escrowId} is ${escrow.state}; only disputed escrows can be resolved`);
    }
    validatePolicy(policy, Object.keys(escrow.contributors));
    const record: RecordKind = { kind: "dispute_resolved", escrowId, policy, at: this.clock() };
    this.journal.append(record);
    this.apply(record);
    return structuredClone(this.mustGet(escrowId));
  }

  /**
   * Read-only reconciliation: who is declared, who confirmed, what each
   * contributor would receive if the escrow settled right now (or did
   * receive, once released), and whether the escrow is ready to release.
   */
  reconcile(escrowId: string): ReconcileReport {
    const escrow = this.mustGet(escrowId);
    const ids = Object.keys(escrow.contributors).sort();
    const feeRecord = escrow.payouts.find((p) => p.role === "fee");
    const feeUnits = feeRecord?.units ?? feeUnitsFor(escrow.total, escrow.feeBps);
    const feePayee = feeRecord?.to ?? (escrow.feeBps > 0 ? (escrow.payee ?? escrow.payer) : null);
    const distributableUnits = escrow.total - feeUnits;
    const shareFor = new Map<string, number>();
    if (escrow.state === "released") {
      for (const p of escrow.payouts) {
        if (p.role === "share") shareFor.set(p.to, p.units);
      }
    } else {
      for (const share of splitByWeights(distributableUnits, entriesForPolicy(escrow.policy, ids))) {
        shareFor.set(share.id, share.units);
      }
    }
    const contributors = ids.map((contributorId) => {
      const c = escrow.contributors[contributorId] as ContributorState;
      return {
        contributorId,
        weight: entriesForPolicy(escrow.policy, [contributorId])[0]?.weight ?? 0,
        confirmed: c.confirmed,
        confirmedAt: c.confirmedAt,
        pendingUnits: shareFor.get(contributorId) ?? 0,
      };
    });
    const unconfirmed = contributors.filter((c) => !c.confirmed).map((c) => c.contributorId);
    return {
      escrowId,
      state: escrow.state,
      totalUnits: escrow.total,
      feeUnits,
      feePayee,
      distributableUnits,
      declaredCount: ids.length,
      confirmedCount: ids.length - unconfirmed.length,
      contributors,
      unconfirmed,
      readyForRelease: escrow.state === "open" && unconfirmed.length === 0,
    };
  }

  release(escrowId: string): Payout[] {
    const escrow = this.mustGet(escrowId);
    if (escrow.state !== "open") {
      throw ApiError.state(`escrow ${escrowId} is ${escrow.state}; only open escrows can be released`);
    }
    const unconfirmed = Object.values(escrow.contributors).filter((c) => !c.confirmed);
    if (unconfirmed.length > 0) {
      throw ApiError.state(
        `cannot release ${escrowId}: unconfirmed contributors ${unconfirmed.map((c) => c.id).join(", ")}`,
      );
    }
    const feeUnits = feeUnitsFor(escrow.total, escrow.feeBps);
    const payouts: Payout[] = [];
    if (feeUnits > 0) {
      payouts.push({ to: escrow.payee ?? escrow.payer, units: feeUnits, role: "fee" });
    }
    for (const share of splitByWeights(escrow.total - feeUnits, entriesForPolicy(escrow.policy, Object.keys(escrow.contributors)))) {
      payouts.push({ to: share.id, units: share.units, role: "share" });
    }
    const record: RecordKind = { kind: "escrow_released", escrowId, payouts, at: this.clock() };
    this.journal.append(record);
    this.apply(record);
    return structuredClone(payouts);
  }

  refund(escrowId: string): Escrow {
    const escrow = this.mustGet(escrowId);
    if (escrow.state === "released" || escrow.state === "refunded") {
      throw ApiError.state(`escrow ${escrowId} is already ${escrow.state}`);
    }
    if (escrow.payouts.length > 0) {
      throw ApiError.state(`escrow ${escrowId} has payouts recorded; refund is not possible`);
    }
    const record: RecordKind = { kind: "escrow_refunded", escrowId, at: this.clock() };
    this.journal.append(record);
    this.apply(record);
    return structuredClone(this.mustGet(escrowId));
  }

  get(escrowId: string): Escrow {
    return structuredClone(this.mustGet(escrowId));
  }

  list(): Escrow[] {
    return [...this.escrows.values()].map((e) => structuredClone(e));
  }

  /** Close the underlying journal file handle (tests and shutdown paths). */
  closeJournal(): void {
    this.journal.close();
  }

  /** Verify the on-disk journal hash chain end to end. */
  verifyJournal(): { ok: true; records: number; head: string } {
    return this.journal.verify();
  }
}
