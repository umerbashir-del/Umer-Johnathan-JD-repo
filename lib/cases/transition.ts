import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { cases } from "../db/schema";
import { systemNow } from "../clock";
import { writeAudit } from "../audit/write";
import { HttpError } from "../http/errors";

type CaseStatus = typeof cases.$inferSelect.status;

// The caller holds the case lock; the state and its audit share that transaction.
export async function transition(tx: Db, caseId: string, status: CaseStatus, actor: string, reasonCode?: string): Promise<void> {
  const [current] = await tx.select({ status: cases.status }).from(cases).where(eq(cases.id, caseId));
  if (!current) throw new HttpError(404, "not_found");
  if (current.status === status) return;
  await tx.update(cases).set({ status, updatedAt: systemNow() }).where(eq(cases.id, caseId));
  await writeAudit(tx, { actor, actorType: actor === "system" ? "system" : "user", caseId, action: "case_status_changed", objectType: "case", objectId: caseId, reasonCode });
}
