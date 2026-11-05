#!/usr/bin/env bun
/**
 * aps — command-line interface for agent-payment-splitter.
 *
 * Every command prints a single-line JSON document; pass --json for
 * pretty-printed output. All commands accept --journal <file> (default
 * ./journal.jsonl).
 */
import { readFileSync } from "fs";
import { PaymentSplitter } from "./engine.js";
import { Journal } from "./store.js";
import { ApiError } from "./types.js";
import type { EscrowSpec, SplitPolicy } from "./types.js";

function usage(): string {
  return [
    "Usage: aps <command> [args] [--journal <file>] [--json]",
    "",
    "Commands:",
    "  create <spec.json | --spec-file <path>>   open an escrow",
    "  confirm <escrowId> <contributorId>        contributor acknowledges the split",
    "  dispute <escrowId> <reason>               freeze the escrow",
    "  resolve <escrowId> --policy <policy>      settle a dispute (optionally re-weight)",
    "  release <escrowId>                        pay out fee + shares once all confirmed",
    "  refund <escrowId>                         return the full total to the payer",
    "  show <escrowId>                           escrow state + reconciliation report",
    "  list                                      every escrow, one line each",
    "  reconcile <escrowId>                      projected payouts without mutating",
    "  verify                                    re-hash the journal end to end",
    "",
    "Policy syntax: 'equal' or 'contributor=weight,...' (e.g. 'alpha=5,beta=3,gamma=2')",
  ].join("\n");
}

function parsePolicy(raw: string): SplitPolicy {
  if (raw.trim() === "equal") return { kind: "equal" };
  const weights: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) {
      throw new Error(`invalid weight term '${trimmed}' — expected contributor=weight`);
    }
    const id = trimmed.slice(0, eq).trim();
    const weight = Number(trimmed.slice(eq + 1).trim());
    if (!Number.isInteger(weight) || weight < 0) {
      throw new Error(`invalid weight for '${id}' — must be a non-negative integer`);
    }
    if (id in weights) throw new Error(`duplicate weight for '${id}'`);
    weights[id] = weight;
  }
  if (Object.keys(weights).length === 0) {
    throw new Error("--policy must be 'equal' or a comma list of contributor=weight terms");
  }
  return { kind: "weights", weights };
}

function parseSpec(raw: string): EscrowSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`spec is not valid JSON: ${(err as Error).message}`);
  }
  const spec = parsed as Partial<EscrowSpec>;
  if (typeof spec.taskId !== "string" || typeof spec.payer !== "string") {
    throw new Error("spec JSON must include taskId (string) and payer (string)");
  }
  if (typeof spec.total !== "number" || !Number.isInteger(spec.total) || spec.total < 0) {
    throw new Error("spec JSON must include total (non-negative integer)");
  }
  if (!Array.isArray(spec.contributors) || spec.contributors.length === 0) {
    throw new Error("spec JSON must include contributors (non-empty string array)");
  }
  if (spec.policy === undefined) {
    throw new Error("spec JSON must include policy ({kind:'equal'} or {kind:'weights',weights:{...}})");
  }
  return {
    taskId: spec.taskId,
    payer: spec.payer,
    payee: typeof spec.payee === "string" ? spec.payee : undefined,
    total: spec.total,
    feeBps: typeof spec.feeBps === "number" ? spec.feeBps : undefined,
    contributors: spec.contributors,
    policy: spec.policy as SplitPolicy,
  };
}

interface Options {
  json: boolean;
  journalFile: string;
  policyRaw: string | null;
  specFile: string | null;
}

function parseOptions(argv: string[]): { rest: string[]; options: Options } {
  const rest: string[] = [];
  const options: Options = { json: false, journalFile: "journal.jsonl", policyRaw: null, specFile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--journal":
        options.journalFile = argv[i + 1] ?? "journal.jsonl";
        i += 1;
        break;
      case "--policy":
        options.policyRaw = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--spec-file":
        options.specFile = argv[i + 1] ?? "";
        i += 1;
        break;
      default:
        if (arg !== undefined) rest.push(arg);
    }
  }
  return { rest, options };
}

function print(value: unknown, json: boolean): void {
  console.log(JSON.stringify(value, null, json ? 2 : undefined));
}

function main(): void {
  const { rest, options } = parseOptions(process.argv.slice(2));
  const [cmd, ...args] = rest;
  const splitter = new PaymentSplitter(new Journal(options.journalFile));
  const escrowId = args[0] ?? "";

  switch (cmd) {
    case "create": {
      const raw = options.specFile
        ? readFileSync(options.specFile, "utf-8")
        : args[0];
      if (typeof raw !== "string" || raw.trim() === "") {
        throw new Error("create requires a JSON spec or --spec-file <path>");
      }
      const spec = parseSpec(raw);
      if (options.policyRaw) spec.policy = parsePolicy(options.policyRaw);
      print(splitter.createEscrow(spec), options.json);
      return;
    }
    case "confirm": {
      const contributorId = args[1];
      if (!escrowId || !contributorId) throw new Error("usage: aps confirm <escrowId> <contributorId>");
      print(splitter.confirm(escrowId, contributorId), options.json);
      return;
    }
    case "dispute": {
      const reason = args.slice(1).join(" ");
      if (!escrowId || !reason) throw new Error("usage: aps dispute <escrowId> <reason>");
      print(splitter.dispute(escrowId, reason), options.json);
      return;
    }
    case "resolve": {
      if (!escrowId || !options.policyRaw) throw new Error("usage: aps resolve <escrowId> --policy <equal|id=weight,...>");
      print(splitter.resolve(escrowId, parsePolicy(options.policyRaw)), options.json);
      return;
    }
    case "release": {
      if (!escrowId) throw new Error("usage: aps release <escrowId>");
      const payouts = splitter.release(escrowId);
      if (options.json) {
        print({ escrowId, payouts }, true);
        return;
      }
      for (const p of payouts) {
        console.log(`${p.to}\t${p.units}\t${p.role}`);
      }
      return;
    }
    case "refund": {
      if (!escrowId) throw new Error("usage: aps refund <escrowId>");
      print(splitter.refund(escrowId), options.json);
      return;
    }
    case "show": {
      if (!escrowId) throw new Error("usage: aps show <escrowId>");
      print({ escrow: splitter.get(escrowId), reconcile: splitter.reconcile(escrowId) }, options.json);
      return;
    }
    case "list": {
      for (const escrow of splitter.list()) {
        if (options.json) {
          print(escrow, true);
        } else {
          console.log(`${escrow.id}\t${escrow.taskId}\t${escrow.state}\t${escrow.total}`);
        }
      }
      return;
    }
    case "reconcile": {
      if (!escrowId) throw new Error("usage: aps reconcile <escrowId>");
      print(splitter.reconcile(escrowId), options.json);
      return;
    }
    case "verify": {
      print(Journal.verify(options.journalFile), options.json);
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(usage());
      return;
    default:
      throw new Error(
        `unknown command '${cmd}' — try create|confirm|dispute|resolve|release|refund|show|list|reconcile|verify`,
      );
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ApiError) {
    console.error(`error [${err.code}]: ${err.message}`);
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}
