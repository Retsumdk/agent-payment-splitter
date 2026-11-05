import { existsSync, openSync, closeSync, readFileSync, appendFileSync } from "fs";
import type { RecordKind } from "./types.js";
import { StoreError } from "./types.js";
import { canonicalJson, recordHash } from "./ids.js";

interface JournalRecord {
  seq: number;
  hash: string;
  record: RecordKind;
}

const KIND_KEYS: Record<RecordKind["kind"], string[]> = {
  escrow_created: ["at", "escrowId", "kind", "spec"],
  contributor_confirmed: ["at", "contributorId", "escrowId", "kind"],
  dispute_opened: ["at", "escrowId", "kind", "reason"],
  dispute_resolved: ["at", "escrowId", "kind", "policy"],
  escrow_released: ["at", "escrowId", "kind", "payouts"],
  escrow_refunded: ["at", "escrowId", "kind"],
};

function parseRecord(raw: unknown, file: string, line: number): RecordKind {
  if (typeof raw !== "object" || raw === null) {
    throw new StoreError("record is not an object", file, line);
  }
  const rec = raw as Record<string, unknown>;
  const kind = rec.kind;
  if (typeof kind !== "string" || !(kind in KIND_KEYS)) {
    throw new StoreError(`unknown record kind ${String(kind)}`, file, line);
  }
  for (const key of KIND_KEYS[kind as RecordKind["kind"]]) {
    if (!(key in rec)) {
      throw new StoreError(`record kind ${kind} missing key ${key}`, file, line);
    }
  }
  return rec as unknown as RecordKind;
}

/**
 * Append-only JSONL journal with a SHA-256 hash chain. Each line is
 * {"seq":N,"hash":H,"record":R}; H = sha256(seq|prevHash|canonical(record)).
 * On reopen the append head is repositioned at the last record's hash so a
 * corrupted tail fails loudly instead of forking the chain.
 */
export class Journal {
  private records: JournalRecord[] = [];
  private head = "";

  constructor(file: string, opts?: { create?: boolean }) {
    if (opts?.create || !existsSync(file)) {
      const fd = openSync(file, "a");
      this.file = file;
      this.fd = fd;
      return;
    }
    this.init(file);
  }

  private file!: string;
  private fd!: number;

  static open(file: string): Journal {
    return new Journal(file);
  }

  private init(file: string): void {
    const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() !== "");
    const records: JournalRecord[] = [];
    let prev = "";
    for (let i = 0; i < lines.length; i++) {
      const line = i + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i] as string);
      } catch (err) {
        throw new StoreError(`line is not valid JSON: ${(err as Error).message}`, file, line);
      }
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.seq !== "number" || typeof obj.hash !== "string") {
        throw new StoreError("record envelope missing seq/hash", file, line);
      }
      if (obj.seq !== i) {
        throw new StoreError(`seq mismatch: expected ${i}, got ${String(obj.seq)}`, file, line);
      }
      const record = parseRecord(obj.record, file, line);
      const expected = recordHash(obj.seq, prev, record);
      if (obj.hash !== expected) {
        throw new StoreError(`hash mismatch: expected ${expected.slice(0, 12)}…`, file, line);
      }
      records.push({ seq: obj.seq, hash: obj.hash, record });
      prev = obj.hash;
    }
    this.file = file;
    this.fd = openSync(file, "a");
    this.records = records;
    this.head = prev;
  }

  append(record: RecordKind): void {
    const seq = this.records.length;
    const hash = recordHash(seq, this.head, record);
    const line = `${JSON.stringify({ seq, hash, record })}\n`;
    appendFileSync(this.fd, line);
    this.records.push({ seq, hash, record });
    this.head = hash;
  }

  all(): readonly RecordKind[] {
    return this.records.map((r) => r.record);
  }

  size(): number {
    return this.records.length;
  }

  lastHash(): string {
    return this.head;
  }

  /** Re-read the journal from disk and verify the hash chain end to end. */
  verify(): { ok: true; records: number; head: string } {
    return Journal.verify(this.file);
  }

  /** Static integrity check usable without a live handle. */
  static verify(file: string): { ok: true; records: number; head: string } {
    const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() !== "");
    let prev = "";
    for (let i = 0; i < lines.length; i++) {
      const line = i + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i] as string);
      } catch (err) {
        throw new StoreError(`invalid JSON: ${(err as Error).message}`, file, line);
      }
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.seq !== "number" || typeof obj.hash !== "string") {
        throw new StoreError("record envelope missing seq/hash", file, line);
      }
      if (obj.seq !== i) {
        throw new StoreError(`seq mismatch: expected ${i}, got ${String(obj.seq)}`, file, line);
      }
      const record = parseRecord(obj.record, file, line);
      const expected = recordHash(obj.seq, prev, record);
      if (obj.hash !== expected) {
        throw new StoreError(`hash mismatch: expected ${expected.slice(0, 12)}…`, file, line);
      }
      prev = obj.hash;
    }
    return { ok: true, records: lines.length, head: prev };
  }

  close(): void {
    closeSync(this.fd);
  }

  get path(): string {
    return this.file;
  }
}
