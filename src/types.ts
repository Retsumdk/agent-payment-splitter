export type SplitPolicy =
  | { kind: "equal" }
  | { kind: "weights"; weights: Record<string, number> };

export interface EscrowSpec {
  taskId: string;
  payer: string;
  payee?: string;
  total: number;
  feeBps?: number;
  contributors: string[];
  policy: SplitPolicy;
}

export type EscrowState = "open" | "disputed" | "released" | "refunded";

export interface ContributorState {
  id: string;
  confirmed: boolean;
  confirmedAt?: number;
}

export interface Payout {
  to: string;
  units: number;
  role: "fee" | "share";
}

export interface ReconcileContributor {
  contributorId: string;
  weight: number;
  confirmed: boolean;
  confirmedAt?: number;
  pendingUnits: number;
}

export interface ReconcileReport {
  escrowId: string;
  state: EscrowState;
  totalUnits: number;
  feeUnits: number;
  feePayee: string | null;
  distributableUnits: number;
  declaredCount: number;
  confirmedCount: number;
  contributors: ReconcileContributor[];
  unconfirmed: string[];
  readyForRelease: boolean;
}

export interface Escrow {
  id: string;
  taskId: string;
  payer: string;
  payee: string | null;
  total: number;
  feeBps: number;
  policy: SplitPolicy;
  state: EscrowState;
  contributors: Record<string, ContributorState>;
  payouts: Payout[];
  createdAt: number;
  closedAt?: number;
  disputeReason?: string;
}

export type RecordKind =
  | { kind: "escrow_created"; escrowId: string; spec: EscrowSpec; at: number }
  | { kind: "contributor_confirmed"; escrowId: string; contributorId: string; at: number }
  | { kind: "dispute_opened"; escrowId: string; reason: string; at: number }
  | { kind: "dispute_resolved"; escrowId: string; policy: SplitPolicy; at: number }
  | { kind: "escrow_released"; escrowId: string; payouts: Payout[]; at: number }
  | { kind: "escrow_refunded"; escrowId: string; at: number };

export type ApiErrorCode = "validation" | "not_found" | "state" | "store";

/**
 * The single error type surfaced by the engine, CLI and HTTP API. `code` is a
 * stable machine-readable identifier and `status` the matching HTTP status.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static validation(message: string): ApiError {
    return new ApiError("validation", message, 400);
  }

  static notFound(message: string): ApiError {
    return new ApiError("not_found", message, 404);
  }

  static state(message: string): ApiError {
    return new ApiError("state", message, 409);
  }
}

export class StoreError extends ApiError {
  constructor(
    message: string,
    readonly file: string,
    readonly line: number,
  ) {
    super("store", `${file}:${line}: ${message}`, 500);
    this.name = "StoreError";
  }
}
