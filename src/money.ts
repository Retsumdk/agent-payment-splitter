import type { SplitPolicy } from "./types.js";
import { ApiError } from "./types.js";

export interface SplitEntry {
  id: string;
  weight: number;
}

function assertNonNegInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw ApiError.validation(`${label} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Largest-remainder allocation of `total` integer units across entries by
 * weight. Guarantees: every entry's allocation is a non-negative integer,
 * allocations sum to exactly `total`, and the result is independent of input
 * order — ties in fractional remainder break by ascending id.
 */
export function splitByWeights(total: number, entries: readonly SplitEntry[]): Array<{ id: string; units: number }> {
  assertNonNegInt(total, "total");
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set<string>();
  for (const e of sorted) {
    assertNonNegInt(e.weight, `weight for ${e.id}`);
    if (seen.has(e.id))     throw ApiError.validation(`duplicate contributor ${e.id}`);
    seen.add(e.id);
  }
  const weightSum = sorted.reduce((acc, e) => acc + e.weight, 0);
  if (sorted.length === 0) return [];
  if (weightSum === 0) {
    throw ApiError.validation("total weight must be positive when there is anything to split");
  }
  const exact = sorted.map((e) => (total * e.weight) / weightSum);
  const floors = exact.map((v) => Math.floor(v));
  let leftover = total - floors.reduce((a, b) => a + b, 0);
  const order = sorted
    .map((e, i) => ({ i, frac: exact[i]! - floors[i]!, id: e.id }))
    .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.id < b.id ? -1 : 1));
  const bump = new Map<number, number>();
  for (const o of order) {
    if (leftover <= 0) break;
    bump.set(o.i, 1);
    leftover -= 1;
  }
  return sorted.map((e, i) => ({ id: e.id, units: floors[i]! + (bump.get(i) ?? 0) }));
}

export function feeUnitsFor(total: number, feeBps: number): number {
  assertNonNegInt(total, "total");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 9999) {
    throw ApiError.validation(`feeBps must be an integer between 0 and 9999, got ${feeBps}`);
  }
  return Math.floor((total * feeBps) / 10000);
}

export function entriesForPolicy(policy: SplitPolicy, contributorIds: readonly string[]): SplitEntry[] {
  const ids = [...new Set(contributorIds)].sort();
  if (policy.kind === "equal") {
    return ids.map((id) => ({ id, weight: 1 }));
  }
  const missing = ids.filter((id) => !(id in policy.weights));
  if (missing.length > 0) {
    throw ApiError.validation(`weights missing for contributors: ${missing.join(", ")}`);
  }
  return ids.map((id) => ({ id, weight: policy.weights[id] as number }));
}

/**
 * Render integer units as a dollars-and-cents string. Units are the smallest
 * currency unit (cents), so 12500 renders as "$125.00".
 */
export function formatUnits(units: number): string {
  assertNonNegInt(units, "units");
  const dollars = Math.floor(units / 100);
  const cents = units % 100;
  return `$${dollars.toLocaleString("en-US")}.${String(cents).padStart(2, "0")}`;
}
