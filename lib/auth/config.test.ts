import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createAuthConfig, guardAuthRequest, loginIp } from "./config";
import { parseEnv } from "../env";

const origin = "https://demo.example.test";

describe("Auth.js request boundary", () => {
  it("trusts only the platform-provided IP header and otherwise shares a conservative bucket", () => {
    const request = new Request(`${origin}/api/auth/session`, { headers: { "x-forwarded-for": "forged", "x-vercel-forwarded-for": "192.0.2.1" } });
    expect(loginIp(request, { VERCEL: null })).toBe("unknown");
    expect(loginIp(request, { VERCEL: "1" })).toBe("192.0.2.1");
    expect(loginIp(new Request(origin), { VERCEL: "1" })).toBe("unknown");
  });
  it("requires origin and secret without local fallback", () => {
    expect(() => createAuthConfig(parseEnv({ APP_DEPLOYMENT: "local" }))).toThrow("auth_unavailable");
    expect(() => createAuthConfig(parseEnv({ APP_DEPLOYMENT: "local", APP_ORIGIN: origin }))).toThrow("auth_unavailable");
    const config = createAuthConfig(parseEnv({ APP_DEPLOYMENT: "local", APP_ORIGIN: origin, AUTH_SECRET: "x".repeat(32) }));
    expect(config.session).toEqual({ strategy: "jwt", maxAge: 28800 });
    expect(config.providers).toHaveLength(1);
    expect(config.useSecureCookies).toBe(true);
  });

  it("allows only same-origin callback redirects, including slash/backslash edge cases", async () => {
    const config = createAuthConfig(parseEnv({ APP_DEPLOYMENT: "local", APP_ORIGIN: origin, AUTH_SECRET: "x".repeat(32) }));
    const redirect = config.callbacks!.redirect!;
    expect(await redirect({ url: "/case/UR-1042", baseUrl: origin })).toBe(`${origin}/case/UR-1042`);
    for (const url of ["https://evil.example.test", "//evil.example.test", "/\\evil.example.test", "javascript:alert(1)"]) {
      expect(await redirect({ url, baseUrl: origin })).toBe(origin);
    }
  });

  it.each([null, "https://attacker.example.test", "null"])("refuses mismatched POST origin %s", async (value) => {
    const headers: Record<string, string> = value ? { origin: value } : {};
    const result = await guardAuthRequest(new NextRequest(`${origin}/api/auth/signout`, { method: "POST", headers, body: "x" }), { APP_ORIGIN: origin });
    expect(result instanceof Response && result.status).toBe(403);
  });

  it("normalizes Host and preserves the bounded form body", async () => {
    const result = await guardAuthRequest(new NextRequest("https://evil.example.test/api/auth/callback/credentials", {
      method: "POST", headers: { origin, host: "evil.example.test", "x-forwarded-host": "evil.example.test", "content-type": "application/x-www-form-urlencoded" }, body: "account=clinician_a&credential=test",
    }), { APP_ORIGIN: origin });
    expect(result instanceof NextRequest).toBe(true);
    if (!(result instanceof NextRequest)) throw new Error("expected request");
    expect(result.url).toBe(`${origin}/api/auth/callback/credentials`);
    expect(result.headers.get("host")).toBe("demo.example.test");
    expect(result.headers.get("x-forwarded-host")).toBe(null);
    expect(await result.text()).toBe("account=clinician_a&credential=test");
  });

  it("rejects actual oversized bytes even when Content-Length lies", async () => {
    const result = await guardAuthRequest(new NextRequest(`${origin}/api/auth/callback/credentials`, {
      method: "POST", headers: { origin, "content-length": "1" }, body: "x".repeat(16385),
    }), { APP_ORIGIN: origin });
    expect(result instanceof Response && result.status).toBe(413);
    const declared = await guardAuthRequest(new NextRequest(`${origin}/api/auth/signout`, {
      method: "POST", headers: { origin, "content-length": "16385" }, body: "x",
    }), { APP_ORIGIN: origin });
    expect(declared instanceof Response && declared.status).toBe(413);
  });

  it("accepts exactly the byte cap and refuses missing configuration", async () => {
    const result = await guardAuthRequest(new NextRequest(`${origin}/api/auth/callback/credentials`, {
      method: "POST", headers: { origin }, body: "x".repeat(16384),
    }), { APP_ORIGIN: origin });
    expect(result instanceof NextRequest).toBe(true);
    const unavailable = await guardAuthRequest(new NextRequest(`${origin}/api/auth/session`), { APP_ORIGIN: null });
    expect(unavailable instanceof Response && unavailable.status).toBe(503);
  });
});
