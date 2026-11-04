import { describe, expect, it } from "vitest";
import type { Database } from "../db";
import { parseEnv } from "../env";
import { executeRoute, readBody, type RouteDefinition } from "./with-route";

const env = parseEnv({ APP_DEPLOYMENT: "local", APP_ORIGIN: "https://example.test" });

describe("route authorization boundary", () => {
  it("denies a case-scoped route whose declaration omits its resource", async () => {
    const events: string[] = [];
    const db = new Proxy({}, { get() { events.push("database"); throw new Error("database_must_not_be_touched"); } }) as Database;
    const definition = { action: "read_case", handler: async () => { events.push("handler"); return {}; } } as unknown as RouteDefinition;
    const response = await executeRoute(new Request("https://example.test/api/cases/UR-1042"), definition, {
      db, env, session: async () => { events.push("session"); return { userId: "u-a", role: "clinician" }; },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "resource_required" } });
    expect(events).toEqual(["session"]);
  });

  it("checks roles before touching case lookup and never reaches the handler", async () => {
    const events: string[] = [];
    const db = new Proxy({}, { get() { events.push("database"); throw new Error("database_must_not_be_touched"); } }) as Database;
    const definition: RouteDefinition = { action: "read_case", resource: { kind: "case", id: "UR-1042" }, handler: async () => { events.push("handler"); return {}; } };
    for (const [user, status] of [[null, 401], [{ userId: "u-a", role: "coordinator" }, 403]] as const) {
      const response = await executeRoute(new Request("https://example.test/api/cases/UR-1042"), definition, {
        db, env, session: async () => { events.push("session"); return user; },
      });
      expect(response.status).toBe(status);
    }
    expect(events).toEqual(["session", "session"]);
  });

  it("caps actual UTF-8 body bytes independently of a forged Content-Length", async () => {
    await expect(readBody(new Request("https://example.test", { method: "POST", headers: { "content-length": "1" }, body: '"éé"' }), 5)).rejects.toMatchObject({ status: 413, code: "body_too_large" });
    expect(await readBody(new Request("https://example.test", { method: "POST", body: '"é"' }), 4)).toBe("é");
    await expect(readBody(new Request("https://example.test", { method: "POST", body: "not-json" }), 100)).rejects.toMatchObject({ status: 400, code: "invalid_json" });
  });
});
