import "./load-env";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../lib/db";
import { auditEvents, loginThrottles, users } from "../lib/db/schema";
import { authorizeDemoLogin, loginKey } from "../lib/auth/login";
import { executeRoute } from "../lib/http/with-route";
import { parseEnv } from "../lib/env";

/** Requires a dedicated migrated test database; never creates deployment credentials. */
export async function testAuth(db: Database): Promise<void> {
  const account = `auth_test_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  const credential = "synthetic-integration-only-credential";
  const env = { demoCredentials: { [account]: credential } };
  const now = new Date("2030-01-01T12:00:00Z");
  await db.insert(users).values({ id: userId, accountKey: account, name: "Synthetic Auth Test", email: `${account}@example.test`, role: "clinician" });

  const concurrentIp = `test-${randomUUID()}`;
  const failures = await Promise.all(Array.from({ length: 5 }, () => authorizeDemoLogin({ account, credential: "incorrect" }, concurrentIp, db, env, now)));
  assert.deepEqual(failures.map((result) => result.status).sort(), ["invalid", "invalid", "invalid", "invalid", "throttled"]);
  assert.deepEqual(await authorizeDemoLogin({ account, credential }, `other-${randomUUID()}`, db, env, now), { status: "throttled", retryAfterSeconds: 900 });
  const [accountState] = await db.select().from(loginThrottles).where(eq(loginThrottles.key, loginKey("account", account)));
  assert.equal(accountState.failureTimes.length, 5);
  assert.equal(accountState.blockedUntil?.toISOString(), "2030-01-01T12:15:00.000Z");
  assert.deepEqual(await authorizeDemoLogin({ account, credential }, concurrentIp, db, env, new Date("2030-01-01T12:14:59Z")), { status: "throttled", retryAfterSeconds: 1 });
  const success = await authorizeDemoLogin({ account, credential }, concurrentIp, db, env, new Date("2030-01-01T12:15:00Z"));
  assert.equal(success.status, "ok");
  if (success.status === "ok") assert.equal(success.user.id, userId);

  // Rotating unknown account names cannot bypass the independent IP bucket.
  const sharedIp = `test-${randomUUID()}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await authorizeDemoLogin({ account: `${account}_${attempt}`, credential: "incorrect" }, sharedIp, db, env, now);
    assert.equal(result.status, attempt === 4 ? "throttled" : "invalid");
  }
  assert.equal((await authorizeDemoLogin({ account, credential }, sharedIp, db, env, now)).status, "throttled");
  assert.deepEqual(await authorizeDemoLogin({ account, credential }, `missing-${randomUUID()}`, db, { demoCredentials: {} }, new Date("2030-01-01T12:16:00Z")), { status: "invalid" });

  // An audit insertion failure must roll back both failure counters.
  const rollbackIp = `rollback-${randomUUID()}`;
  const before = await db.select().from(loginThrottles).where(eq(loginThrottles.key, loginKey("account", account)));
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE audit_events ADD CONSTRAINT auth_test_refuse_login CHECK (action <> 'login') NOT VALID`);
    await assert.rejects(authorizeDemoLogin({ account, credential: "incorrect" }, rollbackIp, tx, env, new Date("2030-01-01T12:17:00Z")));
    assert.deepEqual(await tx.select().from(loginThrottles).where(eq(loginThrottles.key, loginKey("account", account))), before);
    assert.deepEqual(await tx.select().from(loginThrottles).where(eq(loginThrottles.key, loginKey("ip", rollbackIp))), []);
    await tx.execute(sql`ALTER TABLE audit_events DROP CONSTRAINT auth_test_refuse_login`);
  });
  const successEvents = await db.select().from(auditEvents).where(and(eq(auditEvents.actor, userId), eq(auditEvents.action, "login")));
  assert.equal(successEvents.length, 1);
  assert.equal(successEvents[0].reasonCode, "login_succeeded");
  assert.equal(successEvents[0].createdAt.getUTCFullYear() !== 2030, true);
  assert.equal(JSON.stringify(successEvents).includes(credential), false);

  const routeEnv = parseEnv({ APP_DEPLOYMENT: "local", APP_ORIGIN: "https://example.test" });
  for (const kind of ["case", "document"] as const) {
    const response = await executeRoute(new Request("https://example.test/api/invalid", {
      method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: "{}",
    }), { action: "verify_document", write: true, resource: { kind, id: "untrusted-user-text" }, handler: async () => { throw new Error("handler_must_not_run"); } }, {
      db, env: routeEnv, session: async () => ({ userId, role: "clinician" }),
    });
    assert.equal(response.status, 404);
  }
  const refusalEvents = await db.select().from(auditEvents).where(and(eq(auditEvents.actor, userId), eq(auditEvents.action, "action_refused")));
  assert.equal(refusalEvents.length, 2);
  for (const event of refusalEvents) {
    assert.equal(event.objectId, null);
    assert.equal(event.caseId, null);
    assert.equal(JSON.stringify(event).includes("untrusted-user-text"), false);
  }
}
