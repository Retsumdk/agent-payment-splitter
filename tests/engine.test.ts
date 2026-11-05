import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PaymentSplitter } from "../src/engine.js";
import { Journal } from "../src/store.js";
import { feeUnitsFor, splitByWeights } from "../src/money.js";
import { ApiError } from "../src/types.js";
import { createApp } from "../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "aps-test-"));
let fixedNow = 1_700_000_000_000;
const clock = (): number => {
  fixedNow += 1;
  return fixedNow;
};
const spec = {
  taskId: "task-1",
  payer: "payer-x",
  contributors: ["alpha", "beta", "gamma"],
  total: 10_001,
  policy: { kind: "equal" } as const,
};

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("splitByWeights", () => {
  test("equal policy distributes units exactly with deterministic dust", () => {
    const shares = splitByWeights(100, [
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
      { id: "c", weight: 1 },
    ]);
    expect(shares.map((s) => s.units)).toEqual([34, 33, 33]);
    expect(shares.reduce((acc, s) => acc + s.units, 0)).toBe(100);
  });

  test("larger weights receive larger dust allocations", () => {
    const shares = splitByWeights(10, [
      { id: "a", weight: 3 },
      { id: "b", weight: 2 },
      { id: "c", weight: 1 },
    ]);
    expect(shares.map((s) => s.units)).toEqual([5, 3, 2]);
    expect(shares.reduce((acc, s) => acc + s.units, 0)).toBe(10);
  });

  test("tiny totals round in weight order and preserve the sum", () => {
    const shares = splitByWeights(2, [
      { id: "a", weight: 10 },
      { id: "b", weight: 10 },
      { id: "c", weight: 10 },
    ]);
    expect(shares.map((s) => s.units)).toEqual([1, 1, 0]);
    expect(shares.reduce((acc, s) => acc + s.units, 0)).toBe(2);
  });

  test("same input always yields the same output order and values", () => {
    const one = splitByWeights(997, [
      { id: "n", weight: 5 },
      { id: "m", weight: 7 },
      { id: "k", weight: 2 },
    ]);
    const two = splitByWeights(997, [
      { id: "n", weight: 5 },
      { id: "m", weight: 7 },
      { id: "k", weight: 2 },
    ]);
    expect(one).toEqual(two);
  });

  test("zero total yields zero shares without throwing", () => {
    const shares = splitByWeights(0, [{ id: "a", weight: 1 }]);
    expect(shares).toEqual([{ id: "a", units: 0 }]);
  });

  test("all-zero weights throw", () => {
    expect(() =>
      splitByWeights(100, [
        { id: "a", weight: 0 },
        { id: "b", weight: 0 },
      ]),
    ).toThrow("total weight must be positive");
  });
});

describe("feeUnitsFor", () => {
  test("floor division on basis points", () => {
    expect(feeUnitsFor(10_000, 250)).toBe(250);
    expect(feeUnitsFor(10_001, 250)).toBe(250);
    expect(feeUnitsFor(9_999, 250)).toBe(249);
    expect(feeUnitsFor(10_000, 0)).toBe(0);
  });

  test("rejects out-of-range basis points", () => {
    expect(() => feeUnitsFor(100, 10_000)).toThrow("between 0 and 9999");
    expect(() => feeUnitsFor(100, -1)).toThrow("between 0 and 9999");
  });
});

describe("PaymentSplitter", () => {
  function fresh(): { splitter: PaymentSplitter; file: string } {
    const file = join(dir, `journal-${Math.random().toString(36).slice(2)}.jsonl`);
    return { splitter: new PaymentSplitter(new Journal(file), clock), file };
  }

  test("create -> confirm all -> release produces exact payouts", () => {
    const { splitter } = fresh();
    const escrow = splitter.createEscrow(spec);
    expect(escrow.state).toBe("open");
    expect(Object.keys(escrow.contributors)).toEqual(["alpha", "beta", "gamma"]);

    for (const id of spec.contributors) splitter.confirm(escrow.id, id);
    const payouts = splitter.release(escrow.id);

    expect(payouts.reduce((acc, p) => acc + p.units, 0)).toBe(spec.total);
    expect(payouts.map((p) => p.to)).toEqual(["alpha", "beta", "gamma"]);
    const after = splitter.get(escrow.id);
    expect(after.state).toBe("released");
    expect(after.payouts).toEqual(payouts);
  });

  test("equal split of an indivisible total assigns dust deterministically", () => {
    const { splitter } = fresh();
    const escrow = splitter.createEscrow(spec);
    for (const id of spec.contributors) splitter.confirm(escrow.id, id);
    const payouts = splitter.release(escrow.id);
    expect(payouts.map((p) => p.units)).toEqual([3334, 3334, 3333]);
  });

  test("release before all contributors confirmed is rejected", () => {
    const { splitter } = fresh();
    const escrow = splitter.createEscrow(spec);
    splitter.confirm(escrow.id, "alpha");
    expect(() => splitter.release(escrow.id)).toThrow(ApiError);
    expect(() => splitter.release(escrow.id)).toThrow("unconfirmed contributors");
  });

  test("double release is rejected", () => {
    const { splitter } = fresh();
    const escrow = splitter.createEscrow(spec);
    for (const id of spec.contributors) splitter.confirm(escrow.id, id);
    splitter.release(escrow.id);
    expect(() => splitter.release(escrow.id)).toThrow("is released");
  });

  test("refund returns the full total to the payer and closes the escrow", () => {
    const { splitter } = fresh();
    const escrow = splitter.createEscrow(spec);
    const refunded = splitter.refund(escrow.id);
    expect(refunded.state).toBe("refunded");
    expect(refunded.payouts).toEqual([]);
    expect(() => splitter.release(escrow.id)).toThrow("is refunded");
  });

  test("refund after release is rejected", () => {
    const { splitter } = fresh();
    const escrow = splitter.createEscrow(spec);
    for (const id of spec.contributors) splitter.confirm(escrow.id, id);
    splitter.release(escrow.id);
    expect(() => splitter.refund(escrow.id)).toThrow("already released");
  });

  test("dispute blocks release until resolved with a possibly new policy", () => {
    const { splitter } = fresh();
    const escrow = splitter.createEscrow(spec);
    splitter.dispute(escrow.id, "beta disputes the weighting");
    expect(splitter.get(escrow.id).state).toBe("disputed");
    expect(() => splitter.release(escrow.id)).toThrow("is disputed");

    splitter.resolve(escrow.id, { kind: "weights", weights: { alpha: 5, beta: 3, gamma: 2 } });
    expect(splitter.get(escrow.id).state).toBe("open");
    for (const id of spec.contributors) splitter.confirm(escrow.id, id);
    const payouts = splitter.release(escrow.id);
    expect(payouts.map((p) => p.units)).toEqual([5001, 3000, 2000]);
  });

  test("resolve with a policy missing a contributor is rejected", () => {
    const { splitter } = fresh();
    const escrow = splitter.createEscrow(spec);
    splitter.dispute(escrow.id, "weights unclear");
    expect(() =>
      splitter.resolve(escrow.id, { kind: "weights", weights: { alpha: 1, beta: 1 } }),
    ).toThrow("weights missing for contributors: gamma");
  });

  test("platform fee is carved out before contributor shares", () => {
    const { splitter } = fresh();
    const escrow = splitter.createEscrow({ ...spec, feeBps: 500, payee: "platform" });
    for (const id of spec.contributors) splitter.confirm(escrow.id, id);
    const payouts = splitter.release(escrow.id);
    const fee = payouts.find((p) => p.role === "fee");
    expect(fee).toEqual({ to: "platform", units: 500, role: "fee" });
    const shareSum = payouts.filter((p) => p.role === "share").reduce((acc, p) => acc + p.units, 0);
    expect(fee.units + shareSum).toBe(spec.total);
    expect(payouts.filter((p) => p.role === "share").map((p) => p.units)).toEqual([3167, 3167, 3167]);
  });

  test("journal replays into identical state across restarts", () => {
    const { splitter, file } = fresh();
    const escrow = splitter.createEscrow(spec);
    for (const id of spec.contributors) splitter.confirm(escrow.id, id);
    const before = splitter.get(escrow.id);
    const replayed = new PaymentSplitter(new Journal(file), clock);
    expect(replayed.get(escrow.id)).toEqual(before);
  });

  test("tampering with the journal breaks the hash chain", () => {
    const { splitter, file } = fresh();
    const escrow = splitter.createEscrow(spec);
    for (const id of spec.contributors) splitter.confirm(escrow.id, id);
    splitter.release(escrow.id);
    splitter.closeJournal();
    const lines = readFileSync(file, "utf-8").trimEnd().split("\n");
    const first = JSON.parse(lines[0] ?? "") as { record: { spec: { total: number } } };
    first.record.spec.total = 999_999;
    lines[0] = JSON.stringify(first);
    writeFileSync(file, lines.join("\n") + "\n");
    expect(() => new Journal(file).verify()).toThrow("hash mismatch");
  });

  test("corrupt journal line is rejected on load", () => {
    const file = join(dir, `corrupt-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(file, "{not json}\n");
    expect(() => new Journal(file)).toThrow("not valid JSON");
  });

  test("escrow ids are content-derived and stable", () => {
    const { splitter } = fresh();
    const a = splitter.createEscrow(spec).id;
    const b = new PaymentSplitter(new Journal(join(dir, "ids-2.jsonl"), { create: true }), clock).createEscrow(spec).id;
    expect(a).toBe(b);
    expect(a.startsWith("esc_")).toBe(true);
    expect(a.length).toBe(20);
  });

  test("duplicate ids and malformed specs are rejected", () => {
    const { splitter } = fresh();
    const first = splitter.createEscrow(spec);
    expect(() => splitter.createEscrow({ ...spec, contributors: ["alpha", "alpha", "beta"] })).toThrow(
      "contributors must not contain duplicates",
    );
    expect(() => splitter.createEscrow({ ...spec, total: 10.5 })).toThrow("non-negative integer");
    expect(() => splitter.createEscrow({ ...spec, payer: "alpha" })).toThrow("payer cannot also be a contributor");
    expect(() =>
      splitter.createEscrow({ ...spec, policy: { kind: "weights", weights: { alpha: 1, beta: 1 } } }),
    ).toThrow("weights missing for contributors: gamma");
    expect(() => splitter.confirm(first.id, "stranger")).toThrow("not a declared contributor");
    expect(() => splitter.get("esc_nope")).toThrow("escrow not found");
  });
});

describe("HTTP API", () => {
  const token = "test-token-123";
  process.env.APS_TOKEN = token;
  const file = join(dir, "api-journal.jsonl");
  const app = createApp(file);
  const port = 19_871;
  const base = `http://127.0.0.1:${port}`;
  const server = Bun.serve({ fetch: app.fetch, port });
  const post = (path: string, body: unknown, withAuth = true): Promise<Response> =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(withAuth ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  afterAll(() => server.stop(true));

  test("health responds and reads are open", async () => {
    expect((await fetch(base + "/health")).status).toBe(200);
    expect((await fetch(base + "/api/escrows")).status).toBe(200);
  });

  test("writes require the bearer token", async () => {
    const noAuth = await post("/api/escrow", spec, false);
    expect(noAuth.status).toBe(401);
    const badAuth = await fetch(base + "/api/escrow", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify(spec),
    });
    expect(badAuth.status).toBe(401);
  });

  test("full escrow lifecycle over HTTP ends in released payouts", async () => {
    const created = await post("/api/escrow", spec);
    expect(created.status).toBe(201);
    const { escrow } = (await created.json()) as { escrow: { id: string } };
    for (const id of spec.contributors) {
      const res = await post(`/api/escrow/${escrow.id}/confirm`, { contributorId: id });
      expect(res.status).toBe(200);
    }
    const released = await post(`/api/escrow/${escrow.id}/release`, {});
    expect(released.status).toBe(200);
    const { payouts } = (await released.json()) as { payouts: { to: string; units: number }[] };
    expect(payouts.reduce((acc, p) => acc + p.units, 0)).toBe(spec.total);

    const shown = await fetch(base + `/api/escrow/${escrow.id}`);
    const body = (await shown.json()) as { reconcile: { readyForRelease: boolean } };
    expect(body.reconcile.readyForRelease).toBe(false);
    expect(body.reconcile.state).toBe("released");
  });

  test("API validation errors surface as 4xx with error codes", async () => {
    const res = await post("/api/escrow", { ...spec, total: -5 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation");
  });
});
