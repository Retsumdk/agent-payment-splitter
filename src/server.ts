/**
 * Minimal HTTP surface over the escrow engine — zero runtime dependencies.
 *
 * Reads (GET) are open; writes (POST) require `Authorization: Bearer <token>`
 * when APS_TOKEN is set. Without APS_TOKEN the server refuses writes entirely
 * so an unconfigured deployment can never be mutated by accident.
 *
 *   APS_TOKEN=secret PORT=8787 bun src/server.ts
 */
import { timingSafeEqual } from "node:crypto";
import { PaymentSplitter } from "./engine.js";
import { Journal } from "./store.js";
import { ApiError } from "./types.js";
import type { SplitPolicy } from "./types.js";

export interface App {
  fetch: (req: Request) => Promise<Response>;
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, "utf-8");
  const bBytes = Buffer.from(b, "utf-8");
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

function authorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice(7), token);
}

export function createApp(journalFile: string, deps?: { splitter?: PaymentSplitter }): App {
  const splitter = deps?.splitter ?? new PaymentSplitter(new Journal(journalFile));

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (req.method === "GET" && path === "/health") {
          return Response.json({ ok: true, service: "agent-payment-splitter" });
        }

        if (req.method === "GET" && path === "/api/escrows") {
          const escrows = splitter.list().map((e) => ({ ...e, reconcile: splitter.reconcile(e.id) }));
          return Response.json({ escrows });
        }

        if (req.method === "GET" && path.startsWith("/api/escrow/")) {
          const id = path.slice("/api/escrow/".length);
          return Response.json({ escrow: splitter.get(id), reconcile: splitter.reconcile(id) });
        }

        if (req.method === "POST") {
          const token = process.env.APS_TOKEN;
          if (!token || !authorized(req, token)) {
            return Response.json(
              { error: "unauthorized", message: "missing or invalid bearer token" },
              { status: 401 },
            );
          }
          let body: Record<string, unknown> = {};
          const raw = await req.text();
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              return Response.json(
                { error: "validation", message: "request body is not valid JSON" },
                { status: 400 },
              );
            }
          }

          if (path === "/api/escrow") {
            const escrow = splitter.createEscrow(body as unknown as Parameters<PaymentSplitter["createEscrow"]>[0]);
            return Response.json({ escrow }, { status: 201 });
          }

          const rest = path.slice("/api/escrow/".length);
          const slash = rest.lastIndexOf("/");
          if (slash > 0) {
            const id = rest.slice(0, slash);
            const action = rest.slice(slash + 1);
            switch (action) {
              case "confirm":
                return Response.json({ contributor: splitter.confirm(id, String(body.contributorId ?? "")) });
              case "dispute":
                return Response.json({ escrow: splitter.dispute(id, String(body.reason ?? "")) });
              case "resolve":
                return Response.json({ escrow: splitter.resolve(id, body.policy as SplitPolicy) });
              case "release":
                return Response.json({ payouts: splitter.release(id) });
              case "refund":
                return Response.json({ escrow: splitter.refund(id) });
              default:
                break;
            }
          }
        }

        return Response.json(
          { error: "not_found", message: `no route for ${req.method} ${path}` },
          { status: 404 },
        );
      } catch (err) {
        if (err instanceof ApiError) {
          return Response.json({ error: err.code, message: err.message }, { status: err.status });
        }
        console.error(err);
        return Response.json({ error: "internal", message: "unexpected server error" }, { status: 500 });
      }
    },
  };
}

if (import.meta.main) {
  const file = process.env.APS_JOURNAL ?? "journal.jsonl";
  const port = Number(process.env.PORT ?? 8787);
  Bun.serve({ fetch: createApp(file).fetch, port });
  console.log(`agent-payment-splitter listening on http://localhost:${port} (journal: ${file})`);
}
