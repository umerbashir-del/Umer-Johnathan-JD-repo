import "./load-env";
import { strict as assert } from "node:assert";
import { eq, sql } from "drizzle-orm";
import { connectDatabase, type Database } from "../lib/db";
import { checkSpendAdmission, createSpendLedger } from "../lib/db/spend-ledger";
import { spendLedger, spendReservations } from "../lib/db/schema";
import { getEnv, parseEnv } from "../lib/env";

// Call only from a runner that has checked its dedicated database ends in _test.
export async function testSpendLedger(db: Database): Promise<void> {
  const adapter = createSpendLedger(db);
  async function reset(recordedUsd = "0") {
    await db.delete(spendReservations);
    await db.insert(spendLedger).values({ id: "global", recordedUsd, reservedUsd: "0" })
      .onConflictDoUpdate({ target: spendLedger.id, set: { recordedUsd, reservedUsd: "0", updatedAt: sql`now()` } });
  }
  async function balances() {
    const [row] = await db.select({ recordedUsd: spendLedger.recordedUsd, reservedUsd: spendLedger.reservedUsd })
      .from(spendLedger).where(eq(spendLedger.id, "global"));
    assert.ok(row);
    return row;
  }
  const request = { estimateMicroUsd: 4500, stopMicroUsd: 26_000_000, environment: "eval" as const, agentRunRef: "synthetic-spend-integration" };

  await reset("25.991001");
  const concurrent = await Promise.all([adapter.reserve(request), adapter.reserve(request)]);
  assert.equal(concurrent.filter((result) => result.status === "held").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "refused").length, 1);
  assert.deepEqual(await balances(), { recordedUsd: "25.991001", reservedUsd: "0.004500" });
  const hold = concurrent.find((result) => result.status === "held");
  assert.ok(hold && hold.status === "held");
  await Promise.all([adapter.settle(hold.reservationId, 350), adapter.settle(hold.reservationId, 350)]);
  assert.deepEqual(await balances(), { recordedUsd: "25.991351", reservedUsd: "0.000000" });
  const [settled] = await db.select().from(spendReservations).where(eq(spendReservations.id, hold.reservationId));
  assert.equal(settled.status, "settled");
  assert.equal(settled.actualUsd, "0.000350");

  await reset("25.995500");
  const boundary = await adapter.reserve(request);
  assert.equal(boundary.status, "held");
  assert.deepEqual(await adapter.reserve({ ...request, estimateMicroUsd: 1 }), { status: "refused" });
  assert.deepEqual(await balances(), { recordedUsd: "25.995500", reservedUsd: "0.004500" });

  await reset("25.999000");
  assert.deepEqual(await adapter.reserve(request), { status: "refused" });
  assert.equal((await adapter.reserve({ ...request, stopMicroUsd: 36_000_000 })).status, "held");
  await reset("35.999000");
  assert.deepEqual(await adapter.reserve({ ...request, stopMicroUsd: 36_000_000 }), { status: "refused" });

  await reset();
  const expiring = await adapter.reserve(request);
  assert.equal(expiring.status, "held");
  if (expiring.status !== "held") throw new Error("expected_hold");
  await db.update(spendReservations).set({ createdAt: sql`now() - interval '11 minutes'` }).where(eq(spendReservations.id, expiring.reservationId));
  const expiryCounts = await Promise.all([adapter.expireReservations(), adapter.expireReservations()]);
  assert.equal(expiryCounts.reduce((sum, count) => sum + count, 0), 1);
  assert.deepEqual(await balances(), { recordedUsd: "0.004500", reservedUsd: "0.000000" });
  await adapter.settle(expiring.reservationId, 350);
  assert.deepEqual(await balances(), { recordedUsd: "0.004500", reservedUsd: "0.000000" });
  const [expired] = await db.select().from(spendReservations).where(eq(spendReservations.id, expiring.reservationId));
  assert.equal(expired.status, "expired");
  assert.equal(expired.actualUsd, "0.004500");

  await reset("25.995500");
  const swept = await adapter.reserve(request);
  assert.ok(swept.status === "held");
  await db.update(spendReservations).set({ createdAt: sql`now() - interval '11 minutes'` }).where(eq(spendReservations.id, swept.reservationId));
  assert.deepEqual(await adapter.reserve(request), { status: "refused" });
  assert.deepEqual(await balances(), { recordedUsd: "26.000000", reservedUsd: "0.000000" });

  await assert.rejects(adapter.settle("00000000-0000-4000-8000-000000000000", 350), /reservation_not_found/);
  await assert.rejects(adapter.reserve({ ...request, estimateMicroUsd: NaN }), /invalid_spend_amount/);
  await assert.rejects(adapter.settle(expiring.reservationId, -1), /invalid_spend_amount/);
  const configured = getEnv();
  const url = configured.DATABASE_URL;
  assert.ok(url && new URL(url).pathname.endsWith("_test"), "test_database_required");
  const admissionEnv = parseEnv({ APP_DEPLOYMENT: "local", SPEND_LEDGER_URL: url });
  await reset();
  assert.equal(await checkSpendAdmission(admissionEnv), "ok");
  assert.equal((await db.select().from(spendReservations)).length, 0);
  await reset("26.000000");
  assert.equal(await checkSpendAdmission(admissionEnv), "spend_stop");
  assert.equal(await checkSpendAdmission({ ...admissionEnv, SPEND_DEMO_RESERVE_UNLOCKED: true }), "ok");
  await reset("25.999999");
  assert.equal(await checkSpendAdmission(admissionEnv, 1), "ok");
  assert.equal(await checkSpendAdmission(admissionEnv, 2), "spend_stop");
  assert.equal(await checkSpendAdmission({ ...admissionEnv, SPEND_LEDGER_URL: null }), "ledger_unavailable");
  assert.equal((await db.select().from(spendReservations)).length, 0);
  await reset();
}

async function main() {
  const url = getEnv().DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("test_database_required");
  const { db, pool } = connectDatabase(url);
  try { await testSpendLedger(db); console.log("Spend ledger integration passed (no model calls)."); }
  finally { await pool.end(); }
}
if (process.argv[1]?.endsWith("spend-integration.ts")) {
  main().catch(() => { console.error("Spend ledger integration failed."); process.exitCode = 1; });
}
