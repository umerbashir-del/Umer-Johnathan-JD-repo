import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { connectDatabase, type Database } from "../lib/db";
import * as s from "../lib/db/schema";
import { installInvariantChecks } from "../lib/db/security";
import { getEnv } from "../lib/env";

function postgresFailure(error: unknown, constraint: string): boolean {
  if (error === null || typeof error !== "object") return false;
  if ("code" in error && error.code === "23514" && "constraint" in error && error.constraint === constraint) return true;
  return "cause" in error && postgresFailure(error.cause, constraint);
}

export async function testInvariantChecks(db: Database): Promise<void> {
  await installInvariantChecks(db);
  await installInvariantChecks(db);
  const [document] = await db.select({ id: s.documents.id }).from(s.documents).limit(1);
  assert.ok(document, "seeded_test_document_required");
  await assert.rejects(async () => db.execute(sql`UPDATE documents SET verification_state = 'bogus' WHERE id = ${document.id}`), (error) => postgresFailure(error, "document_verification_valid"));
  await assert.rejects(async () => db.execute(sql`UPDATE documents SET origin = 'bogus' WHERE id = ${document.id}`), (error) => postgresFailure(error, "document_origin_valid"));
  await assert.rejects(async () => db.execute(sql`UPDATE documents SET version = 0 WHERE id = ${document.id}`), (error) => postgresFailure(error, "document_version_positive"));
  await assert.rejects(async () => db.execute(sql`UPDATE spend_ledger SET recorded_usd = 'NaN'::numeric WHERE id = 'global'`), (error) => postgresFailure(error, "spend_finite"));
  await assert.rejects(async () => db.insert(s.spendReservations).values({ id: randomUUID(), environment: "bogus", estimateUsd: "0", status: "held" }), (error) => postgresFailure(error, "reservation_environment_valid"));
  await assert.rejects(async () => db.insert(s.spendReservations).values({ id: randomUUID(), environment: "eval", estimateUsd: "NaN", status: "held" }), (error) => postgresFailure(error, "reservation_amount_valid"));
  await assert.rejects(async () => db.insert(s.rateLimitCounters).values({ key: "synthetic-invalid-counter", windowStart: new Date(), count: -1 }), (error) => postgresFailure(error, "rate_counter_nonnegative"));
}

async function main() {
  const url = getEnv().DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("test_database_required");
  const { db, pool } = connectDatabase(url);
  try { await testInvariantChecks(db); console.log("Database invariant integration passed."); }
  finally { await pool.end(); }
}
if (process.argv[1]?.endsWith("security-integration.ts")) {
  main().catch(() => { console.error("Database invariant integration failed."); process.exitCode = 1; });
}
