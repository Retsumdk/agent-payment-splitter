import { createHash } from "crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function contentId(prefix: string, fields: unknown): string {
  const hash = createHash("sha256").update(canonicalJson(fields)).digest("hex").slice(0, 16);
  return `${prefix}_${hash}`;
}

export function recordHash(seq: number, prevHash: string, record: unknown): string {
  return createHash("sha256")
    .update(`${seq}|${prevHash}|${canonicalJson(record)}`)
    .digest("hex");
}
