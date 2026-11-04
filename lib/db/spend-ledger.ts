import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { getEnv, type Env } from "../env";
import { LIMITS } from "../config/limits";
import { spendStopMicroUsd, type SpendLedger } from "../harness/spend";
import { connectDatabase, type Database, type Transaction } from "./index";
import { spendLedger, spendReservations } from "./schema";

function dollarAmount(microUsd: number): string {
  if (!Number.isSafeInteger(microUsd) || microUsd < 0) throw new Error("invalid_spend_amount");
  return `${Math.floor(microUsd / 1_000_000)}.${String(microUsd % 1_000_000).padStart(6, "0")}`;
}

async function expireHeld(tx: Transaction): Promise<number> {
  const expired = await tx.select().from(spendReservations)
    .where(and(eq(spendReservations.status, "held"), lt(spendReservations.createdAt,
      sql`now() - (${LIMITS.RESERVATION_EXPIRY_MINUTES} * interval '1 minute')`)))
    .orderBy(spendReservations.createdAt).limit(1000).for("update", { skipLocked: true });
  if (expired.length === 0) return 0;
  // Reservation locks serialize expiry against late or duplicated settlement.
  for (const reservation of expired) {
    const updated = await tx.update(spendLedger).set({
      recordedUsd: sql`${spendLedger.recordedUsd} + ${reservation.estimateUsd}::numeric`,
      reservedUsd: sql`${spendLedger.reservedUsd} - ${reservation.estimateUsd}::numeric`,
      updatedAt: sql`now()`,
    }).where(eq(spendLedger.id, "global")).returning({ id: spendLedger.id });
    if (updated.length !== 1) throw new Error("ledger_unavailable");
    await tx.update(spendReservations).set({ status: "expired", actualUsd: reservation.estimateUsd })
      .where(eq(spendReservations.id, reservation.id));
  }
  return expired.length;
}

export type PostgresSpendLedger = SpendLedger & { expireReservations(): Promise<number> };

export function createSpendLedger(db: Database): PostgresSpendLedger {
  return {
    async reserve(request) {
      const estimateUsd = dollarAmount(request.estimateMicroUsd);
      const stopUsd = dollarAmount(request.stopMicroUsd);
      return db.transaction(async (tx) => {
        await expireHeld(tx);
        // The WHERE is re-evaluated after waiting for the global row lock.
        const held = await tx.update(spendLedger).set({
          reservedUsd: sql`${spendLedger.reservedUsd} + ${estimateUsd}::numeric`,
          updatedAt: sql`now()`,
        }).where(and(eq(spendLedger.id, "global"),
          sql`${spendLedger.recordedUsd} + ${spendLedger.reservedUsd} + ${estimateUsd}::numeric <= ${stopUsd}::numeric`))
          .returning({ id: spendLedger.id });
        if (held.length === 0) {
          const row = await tx.select({ id: spendLedger.id }).from(spendLedger).where(eq(spendLedger.id, "global"));
          if (row.length === 0) throw new Error("ledger_unavailable");
          return { status: "refused" as const };
        }
        const reservationId = randomUUID();
        await tx.insert(spendReservations).values({ id: reservationId, environment: request.environment,
          agentRunRef: request.agentRunRef, estimateUsd, status: "held" });
        return { status: "held" as const, reservationId };
      });
    },
    async settle(reservationId, actualMicroUsd) {
      const actualUsd = dollarAmount(actualMicroUsd);
      await db.transaction(async (tx) => {
        const [reservation] = await tx.select().from(spendReservations)
          .where(eq(spendReservations.id, reservationId)).for("update");
        if (!reservation) throw new Error("reservation_not_found");
        if (reservation.status !== "held") return;
        const updated = await tx.update(spendLedger).set({
          recordedUsd: sql`${spendLedger.recordedUsd} + ${actualUsd}::numeric`,
          reservedUsd: sql`${spendLedger.reservedUsd} - ${reservation.estimateUsd}::numeric`,
          updatedAt: sql`now()`,
        }).where(eq(spendLedger.id, "global")).returning({ id: spendLedger.id });
        if (updated.length !== 1) throw new Error("ledger_unavailable");
        await tx.update(spendReservations).set({ status: "settled", actualUsd })
          .where(eq(spendReservations.id, reservationId));
      });
    },
    async expireReservations() { return db.transaction(expireHeld); },
  };
}

let connection: ReturnType<typeof connectDatabase> | undefined;
let connectionUrl: string | undefined;
function sharedLedgerDatabase(env: Env): Database | null {
  if (!env.SPEND_LEDGER_URL) return null;
  if (!connection || connectionUrl !== env.SPEND_LEDGER_URL) {
    // Configuration normally stays immutable; injected environments may change it in tests.
    if (connection) void connection.pool.end().catch(() => undefined);
    connection = connectDatabase(env.SPEND_LEDGER_URL);
    connectionUrl = env.SPEND_LEDGER_URL;
  }
  return connection.db;
}
export function getSpendLedger(): PostgresSpendLedger | null {
  const db = sharedLedgerDatabase(getEnv());
  return db ? createSpendLedger(db) : null;
}

/** Advisory admission only; every paid attempt must still reserve atomically. */
export async function checkSpendAdmission(env: Env, minimumFirstCallEstimateMicroUsd = 1): Promise<"ok" | "spend_stop" | "ledger_unavailable"> {
  if (!Number.isSafeInteger(minimumFirstCallEstimateMicroUsd) || minimumFirstCallEstimateMicroUsd < 1) return "spend_stop";
  try {
    const db = sharedLedgerDatabase(env);
    if (!db) return "ledger_unavailable";
    const [row] = await db.select({ allowed: sql<boolean>`${spendLedger.recordedUsd} + ${spendLedger.reservedUsd} + ${dollarAmount(minimumFirstCallEstimateMicroUsd)}::numeric <= ${dollarAmount(spendStopMicroUsd(env))}::numeric` })
      .from(spendLedger).where(eq(spendLedger.id, "global"));
    return row ? row.allowed ? "ok" : "spend_stop" : "ledger_unavailable";
  } catch { return "ledger_unavailable"; }
}
