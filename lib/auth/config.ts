import "server-only";
import NextAuth, { CredentialsSignin, type DefaultSession, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type {} from "next-auth/jwt";
import { NextRequest } from "next/server";
import { getEnv, type Env } from "../env";
import { LIMITS } from "../config/limits";
import { getDb } from "../db";
import { writeAudit } from "../audit/write";
import { authorizeDemoLogin } from "./login";
import type { SessionUser } from "./access";

declare module "next-auth" {
  interface User { role?: string }
  interface Session { user: { id: string; role: string } & DefaultSession["user"] }
}
declare module "next-auth/jwt" {
  interface JWT { userId?: string; role?: string }
}

class LoginThrottled extends CredentialsSignin { code = "login_throttled"; }

export function loginIp(request: Request, env: Pick<Env, "VERCEL">): string {
  // Vercel overwrites this header. Else use a shared bucket rather than trust caller-supplied IPs.
  if (env.VERCEL === "1") return request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return "unknown";
}

export function createAuthConfig(env: Env): NextAuthConfig {
  if (!env.AUTH_SECRET || !env.APP_ORIGIN) throw new Error("auth_unavailable");
  return {
    secret: env.AUTH_SECRET,
    trustHost: true,
    useSecureCookies: new URL(env.APP_ORIGIN).protocol === "https:",
    session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
    providers: [Credentials({
      credentials: { account: { label: "Account", type: "text" }, credential: { label: "Credential", type: "password" } },
      async authorize(credentials, request) {
        const result = await authorizeDemoLogin(credentials, loginIp(request, env));
        if (result.status === "throttled") throw new LoginThrottled();
        return result.status === "ok" ? result.user : null;
      },
    })],
    callbacks: {
      async jwt({ token, user }) {
        if (user) { token.userId = user.id; token.role = user.role; }
        return token;
      },
      async session({ session, token }) {
        session.user.id = typeof token.userId === "string" ? token.userId : "";
        session.user.role = typeof token.role === "string" ? token.role : "";
        return session;
      },
      async redirect({ url }) {
        const origin = new URL(env.APP_ORIGIN!).origin;
        try {
          const target = new URL(url, origin);
          if (target.origin === origin) return target.href;
        } catch { /* Invalid redirect falls back to configured origin. */ }
        return origin;
      },
    },
    // Auth.js errors can include request internals; privacy-safe audit is persisted by login.ts.
    logger: { error() {}, warn() {}, debug() {} },
  };
}

const nextAuth = NextAuth(() => createAuthConfig(getEnv()));
export const auth = nextAuth.auth;

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id || !session.user.role) return null;
  return { userId: session.user.id, role: session.user.role };
}

export async function guardAuthRequest(request: NextRequest, env: Pick<Env, "APP_ORIGIN">): Promise<NextRequest | Response> {
  if (!env.APP_ORIGIN) return Response.json({ error: "auth_unavailable" }, { status: 503 });
  // Normalize the host used by Auth.js; forwarded or Host headers never select callback origins.
  const url = new URL(request.url);
  const configured = new URL(env.APP_ORIGIN);
  url.protocol = configured.protocol;
  url.host = configured.host;
  const headers = new Headers(request.headers);
  headers.set("host", configured.host);
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  if (request.method === "GET") return new NextRequest(url, { method: "GET", headers });
  if (request.headers.get("origin") !== configured.origin) return Response.json({ error: "origin_refused" }, { status: 403 });
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > LIMITS.BODY_CAP_DEFAULT_BYTES)) {
    return Response.json({ error: "body_too_large" }, { status: 413 });
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMITS.BODY_CAP_DEFAULT_BYTES) {
        await reader.cancel();
        return Response.json({ error: "body_too_large" }, { status: 413 });
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new NextRequest(url, { method: "POST", headers, body });
}

async function authHandler(request: NextRequest, method: "GET" | "POST"): Promise<Response> {
  try {
    const guarded = await guardAuthRequest(request, getEnv());
    if (guarded instanceof Response) {
      if (request.method === "POST" && guarded.status !== 503) {
        await writeAudit(getDb(), {
          actor: "anonymous", actorType: "system", action: "auth_request", objectType: "authentication",
          outcome: "refused", reasonCode: guarded.status === 413 ? "body_too_large" : "origin_refused",
        });
      }
      return guarded;
    }
    const response = await nextAuth.handlers[method](guarded);
    let redirect = response.headers.get("location");
    if (!redirect && response.headers.get("content-type")?.includes("application/json")) {
      const json: unknown = await response.clone().json();
      if (json && typeof json === "object" && "url" in json && typeof json.url === "string") redirect = json.url;
    }
    if (redirect && new URL(redirect, guarded.url).searchParams.get("code") === "login_throttled") {
      return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "900" } });
    }
    return response;
  } catch {
    return Response.json({ error: "auth_unavailable" }, { status: 503 });
  }
}

export const handlers = {
  GET: (request: NextRequest) => authHandler(request, "GET"),
  POST: (request: NextRequest) => authHandler(request, "POST"),
};
