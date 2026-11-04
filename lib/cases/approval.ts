import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import * as s from "../db/schema";
import type { SessionUser } from "../auth/access";
import { checkCaseAccess } from "../auth/access";
import { systemNow } from "../clock";
import { writeAudit } from "../audit/write";
import { HttpError } from "../http/errors";
import { transition } from "./transition";
import { loadValidation } from "../validation/snapshot";

const approvalInput = z.object({ packetVersionId: z.string().uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), acknowledgement: z.string().trim().min(1).max(2000) }).strict();
export type ApprovalInput = z.infer<typeof approvalInput>;
export type ApprovalResult = typeof s.approvals.$inferSelect | { error: HttpError };

// Caller holds the case row lock for the entire transaction, including this audit.
export async function approve(tx: Db, caseId: string, actor: SessionUser, input: ApprovalInput): Promise<ApprovalResult> {
  async function refuse(error: HttpError): Promise<{ error: HttpError }> {
    await writeAudit(tx, { actor: actor.userId, caseId, action: "approval_refused", objectType: "case", objectId: caseId, outcome: "refused", reasonCode: error.code });
    return { error };
  }
  const [caseRecord] = await tx.select().from(s.cases).where(eq(s.cases.id, caseId));
  const access = checkCaseAccess(actor, "approve", caseRecord ?? null);
  if (!access.allowed) return refuse(new HttpError(access.status, access.status === 404 ? "not_found" : "access_denied"));
  const parsed = approvalInput.safeParse(input);
  if (!parsed.success) return refuse(new HttpError(400, "invalid_body"));
  const [latestPacket] = await tx.select({ id: s.packetVersions.id }).from(s.packetVersions).where(eq(s.packetVersions.caseId, caseId)).orderBy(desc(s.packetVersions.version)).limit(1);
  if (!latestPacket || latestPacket.id !== input.packetVersionId) return refuse(new HttpError(409, "stale_hash"));
  const [existing] = await tx.select().from(s.approvals).where(and(eq(s.approvals.caseId, caseId), eq(s.approvals.packetVersionId, input.packetVersionId), eq(s.approvals.status, "valid"))).limit(1);
  try {
    const validation = await loadValidation(tx, caseId, input.packetVersionId, input.contentHash);
    if (validation.blockers.length || validation.hash === null) {
      const code = validation.blockers.some(({ code }) => code === "run_incomplete") ? "run_incomplete" : validation.blockers.some(({ code }) => code === "hash_mismatch") ? "stale_hash" : "blockers_open";
      return refuse(new HttpError(409, code, { blockers: validation.blockers }));
    }
    if (existing && existing.contentHash === validation.hash) return existing;
    const [approval] = await tx.insert(s.approvals).values({ id: randomUUID(), caseId, packetVersionId: input.packetVersionId, contentHash: validation.hash, approvedBy: actor.userId, role: actor.role, acknowledgement: parsed.data.acknowledgement, status: "valid" }).onConflictDoNothing().returning();
    if (!approval) return refuse(new HttpError(409, "approval_conflict"));
    await transition(tx, caseId, "approved_for_submission", actor.userId, "packet_approved");
    await writeAudit(tx, { actor: actor.userId, caseId, action: "packet_approved", objectType: "approval", objectId: approval.id });
    return approval;
  } catch (error) {
    if (error instanceof HttpError) return refuse(error);
    throw error;
  }
}

export async function recheckApproval(tx: Db, caseId: string, actor = "system", forceReason?: string): Promise<boolean> {
  const approvals = await tx.select().from(s.approvals).where(and(eq(s.approvals.caseId, caseId), eq(s.approvals.status, "valid")));
  const [latestPacket] = await tx.select({ id: s.packetVersions.id }).from(s.packetVersions).where(eq(s.packetVersions.caseId, caseId)).orderBy(desc(s.packetVersions.version)).limit(1);
  let invalidated = false;
  for (const approval of approvals) {
    let reason: string | null = forceReason ?? (latestPacket && latestPacket.id !== approval.packetVersionId ? "packet_superseded" : null);
    try {
      const validation = await loadValidation(tx, caseId, approval.packetVersionId);
      if (!reason && validation.hash !== approval.contentHash) reason = "content_changed";
      else if (!reason && validation.blockers.some(({ code }) => code !== "hash_mismatch")) reason = "approval_blocked";
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      reason = "validation_data_invalid";
    }
    if (!reason) continue;
    await tx.update(s.approvals).set({ status: "invalidated", invalidatedReason: reason, invalidatedAt: systemNow() }).where(and(eq(s.approvals.id, approval.id), eq(s.approvals.status, "valid")));
    await transition(tx, caseId, "needs_review", actor, reason);
    await writeAudit(tx, { actor, actorType: actor === "system" ? "system" : "user", caseId, action: "approval_invalidated", objectType: "approval", objectId: approval.id, reasonCode: reason });
    invalidated = true;
  }
  return invalidated;
}
