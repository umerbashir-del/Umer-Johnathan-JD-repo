import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { LIMITS } from "../config/limits";
import { systemNow } from "../clock";
import { getEnv, type Env } from "../env";
import { getDb, type Db } from "../db";
import { loginThrottles, users } from "../db/schema";
import { writeAudit } from "../audit/write";

export const LoginInput = z.object({
  account: z.string().min(1).max(100).regex(/^[a-z0-9_]+$/),
  credential: z.string().min(1).max(1000),
});
export type LoginUser = { id: string; name: string; email: string; role: string };
export type ThrottleState = { failureTimes: Date[]; blockedUntil: Date | null };
export type LoginResult = { status: "ok"; user: LoginUser } | { status: "invalid" } | { status: "throttled"; retryAfterSeconds: number };

export function loginKey(kind: "account" | "ip", value: string): string {
  return `login:${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

export function credentialMatches(provided: string, expected: string | undefined): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected ?? "").digest();
  const equal = timingSafeEqual(providedHash, expectedHash);
  return expected !== undefined && expected.length >= 20 && equal;
}

export function recordLoginFailure(state: ThrottleState, now: Date): ThrottleState {
  const lowerBound = now.getTime() - LIMITS.LOGIN_WINDOW_MINUTES * 60_000;
  const failureTimes = state.failureTimes.filter((time) => time.getTime() > lowerBound);
  failureTimes.push(new Date(now));
  return {
    failureTimes,
    blockedUntil: failureTimes.length >= LIMITS.LOGIN_MAX_FAILURES
      ? new Date(now.getTime() + LIMITS.LOGIN_BLOCK_MINUTES * 60_000)
      : null,
  };
}

export function loginRetrySeconds(states: readonly ThrottleState[], now: Date): number {
  return Math.max(0, ...states.map((state) => Math.ceil(((state.blockedUntil?.getTime() ?? 0) - now.getTime()) / 1000)));
}

export interface LoginAttemptStore {
  getState(key: string): Promise<ThrottleState>;
  putState(key: string, state: ThrottleState): Promise<void>;
  findUser(account: string): Promise<LoginUser | null>;
  audit(outcome: "success" | "refused", reasonCode: string, userId?: string): Promise<void>;
}

/** The real store locks both rows before this function; tests fake that external boundary. */
export async function attemptLogin(
  store: LoginAttemptStore,
  raw: unknown,
  ip: string,
  env: Pick<Env, "demoCredentials">,
  now: Date,
): Promise<LoginResult> {
  const parsed = LoginInput.safeParse(raw);
  const rawAccount = typeof raw === "object" && raw !== null && "account" in raw && typeof raw.account === "string" ? raw.account.slice(0, 100) : "invalid";
  const account = parsed.success ? parsed.data.account : rawAccount;
  const accountKey = loginKey("account", account);
  const ipKey = loginKey("ip", ip);
  const [accountState, ipState] = await Promise.all([store.getState(accountKey), store.getState(ipKey)]);
  const retry = loginRetrySeconds([accountState, ipState], now);
  if (retry > 0) {
    await store.audit("refused", "login_throttled");
    return { status: "throttled", retryAfterSeconds: retry };
  }
  // Compare even for missing configuration and unknown users; no default credential exists.
  const equal = credentialMatches(parsed.success ? parsed.data.credential : "", env.demoCredentials[account]);
  const user = parsed.success ? await store.findUser(account) : null;
  if (parsed.success && equal && user?.role === "clinician") {
    await store.putState(accountKey, { failureTimes: [], blockedUntil: null });
    await store.audit("success", "login_succeeded", user.id);
    return { status: "ok", user };
  }
  const nextAccount = recordLoginFailure(accountState, now);
  const nextIp = recordLoginFailure(ipState, now);
  await Promise.all([store.putState(accountKey, nextAccount), store.putState(ipKey, nextIp)]);
  await store.audit("refused", "invalid_credentials");
  const blocked = loginRetrySeconds([nextAccount, nextIp], now);
  return blocked > 0 ? { status: "throttled", retryAfterSeconds: blocked } : { status: "invalid" };
}

export async function authorizeDemoLogin(
  raw: unknown,
  ip: string,
  database: Db = getDb(),
  env: Pick<Env, "demoCredentials"> = getEnv(),
  now?: Date,
): Promise<LoginResult> {
  const account = typeof raw === "object" && raw !== null && "account" in raw && typeof raw.account === "string" ? raw.account.slice(0, 100) : "invalid";
  const keys = [loginKey("account", account), loginKey("ip", ip)].sort();
  return database.transaction(async (tx) => {
    // Sorted row locks serialize attempts across instances without deadlocking account/IP pairs.
    for (const key of keys) {
      await tx.insert(loginThrottles).values({ key, failureTimes: [] }).onConflictDoNothing();
      await tx.select().from(loginThrottles).where(eq(loginThrottles.key, key)).for("update");
    }
    return attemptLogin({
      async getState(key) {
        const [state] = await tx.select().from(loginThrottles).where(eq(loginThrottles.key, key));
        if (!state) throw new Error("login_state_unavailable");
        return state;
      },
      async putState(key, state) { await tx.update(loginThrottles).set(state).where(eq(loginThrottles.key, key)); },
      async findUser(accountKey) {
        const [user] = await tx.select().from(users).where(eq(users.accountKey, accountKey));
        return user ?? null;
      },
      async audit(outcome, reasonCode, userId) {
        await writeAudit(tx, { actor: userId ?? "anonymous", actorType: userId ? "user" : "system", action: "login", objectType: "authentication", objectId: keys[0], outcome, reasonCode });
      },
    }, raw, ip, env, now ?? systemNow());
  });
}
