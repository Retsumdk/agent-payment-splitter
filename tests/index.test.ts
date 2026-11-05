import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ApiError,
  Journal,
  PaymentSplitter,
  canonicalJson,
  contentId,
  feeUnitsFor,
  formatUnits,
  recordHash,
  splitByWeights,
} from "../src/index.js";
import type { EscrowSpec } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "aps-barrel-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("public barrel surface", () => {
  test("exports the documented runtime API", () => {
    expect(typeof PaymentSplitter).toBe("function");
    expect(typeof Journal).toBe("function");
    expect(typeof splitByWeights).toBe("function");
    expect(typeof feeUnitsFor).toBe("function");
    expect(typeof formatUnits).toBe("function");
    expect(typeof canonicalJson).toBe("function");
    expect(typeof contentId).toBe("function");
    expect(typeof recordHash).toBe("function");
  });

  test("ApiError carries a machine code and HTTP status", () => {
    const err = ApiError.validation("bad input");
    expect(err.code).toBe("validation");
    expect(err.status).toBe(400);
    expect(ApiError.notFound("nope").status).toBe(404);
    expect(ApiError.state("wrong phase").status).toBe(409);
  });

  test("formatUnits renders cents as dollars without float drift", () => {
    expect(formatUnits(12_500)).toBe("$125.00");
    expect(formatUnits(1_000_001)).toBe("$10,000.01");
    expect(formatUnits(5)).toBe("$0.05");
  });
});

describe("Journal", () => {
  test("creates, appends, reloads, and replays identical records", () => {
    const file = join(dir, "j1.jsonl");
    const spec: EscrowSpec = {
      taskId: "t",
      payer: "p",
      total: 100,
      contributors: ["a"],
      policy: { kind: "equal" },
    };
    const a = new Journal(file);
    a.append({ kind: "escrow_created", escrowId: "esc_x", spec, at: 1 });
    a.close();
    const b = new Journal(file);
    expect(b.size()).toBe(1);
    expect(b.all()).toEqual([{ kind: "escrow_created", escrowId: "esc_x", spec, at: 1 }]);
    expect(b.verify()).toEqual({ ok: true, records: 1, head: expect.any(String) });
  });

  test("verify() detects a tampered payload after reopening", () => {
    const file = join(dir, "j2.jsonl");
    const journal = new Journal(file);
    journal.append({ kind: "dispute_opened", escrowId: "esc_y", reason: "r", at: 2 });
    journal.close();
    const lines = readLines(file);
    const rec = JSON.parse(lines[0]) as { record: { reason: string } };
    rec.record.reason = "tampered";
    lines[0] = JSON.stringify(rec);
    writeFileSync(file, lines.join("\n") + "\n");
    expect(() => new Journal(file).verify()).toThrow("hash mismatch");
  });

  test("constructor rejects unknown record kinds and corrupt lines", () => {
    const bad = join(dir, "j3.jsonl");
    writeFileSync(bad, '{"seq":0,"hash":"x","record":{"kind":"mystery"}}\n');
    expect(() => new Journal(bad)).toThrow(/unknown record kind|missing key|hash mismatch/);

    const corrupt = join(dir, "j4.jsonl");
    writeFileSync(corrupt, "{not json}\n");
    expect(() => new Journal(corrupt)).toThrow("not valid JSON");
  });

  test("journal files are created lazily only when written", () => {
    const file = join(dir, "never.jsonl");
    const journal = new Journal(file);
    expect(journal.size()).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});

function readLines(file: string): string[] {
  return readFileSync(file, "utf-8").trimEnd().split("\n");
}
