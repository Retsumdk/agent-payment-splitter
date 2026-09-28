import { describe, test, expect } from "bun:test";
describe("agent-payment-splitter", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});
