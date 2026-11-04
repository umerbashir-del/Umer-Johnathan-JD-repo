import "./load-env";
import "server-only";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../lib/db";
import * as s from "../lib/db/schema";
import { editClaim } from "../lib/cases/claims";
import { withCaseLock } from "../lib/cases/lock";
import { approve, recheckApproval } from "../lib/cases/approval";
import { loadValidation, refreshPacketHash } from "../lib/validation/snapshot";
import { contentHash } from "../lib/fixtures/ids";
import { businessDate, businessNow } from "../lib/clock";

export async function testApproval(db: Database): Promise<void> {
  const caseId = `TEST-APPROVAL-${randomUUID()}`;
  const userId = randomUUID();
  const packetId = randomUUID();
  const claimId = randomUUID();
  const noteId = randomUUID();
  const authId = randomUUID();
  const requestId = randomUUID();
  const groupId = randomUUID();
  const runId = randomUUID();
  const periodId = randomUUID();
  const today = businessDate(businessNow());
  const actor = { userId, role: "clinician" };
  await db.transaction(async (tx) => {
    await tx.insert(s.users).values({ id: userId, accountKey: caseId.toLowerCase(), email: `${userId}@example.test`, name: "Synthetic Approval Tester", role: "clinician" });
    await tx.insert(s.cases).values({ id: caseId, type: "concurrent_review", patientLabel: "Synthetic Test", service: "Synthetic review", levelOfCare: "Synthetic", facility: "Synthetic", payer: "Synthetic", plan: "Synthetic", assignedTo: userId, status: "needs_review", synthetic: true });
    for (const document of [{ id: noteId, type: "progress_note" as const, content: "Patient reports improved sleep.", serviceDate: today }, { id: authId, type: "authorization_record" as const, content: "Authorized synthetic period.", serviceDate: null }, { id: requestId, type: "authorization_record" as const, content: "Requested synthetic period.", serviceDate: null }]) {
      await tx.insert(s.documents).values({ ...document, caseId, title: "Synthetic test source", version: 1, contentHash: contentHash(document.content), verificationState: "verified", verificationSource: "seed", origin: "seed" });
    }
    await tx.insert(s.reviewPeriods).values({ id: periodId, caseId, requestedStart: today, requestedEnd: today, sourceDocumentId: requestId, version: 1 });
    await tx.insert(s.authorizations).values({ id: randomUUID(), caseId, authNumber: "SYNTHETIC-AUTH", status: "authorized", approvedStart: today, approvedEnd: today, sourceDocumentId: authId, units: 1 });
    await tx.insert(s.runGroups).values({ id: groupId, caseId, status: "complete", asOf: businessNow(), startedBy: userId });
    await tx.insert(s.agentRuns).values({ id: runId, caseId, runGroupId: groupId, agent: "clinical_documentation", agentVersion: "test", model: "fake", inputHash: "fake", inputDocumentIds: [noteId, authId, requestId], status: "succeeded" });
    await tx.insert(s.packetVersions).values({ id: packetId, caseId, version: 1, kind: "review_packet", content: { sections: [{ heading: "Summary", claimIds: [claimId] }] }, includedClaimIds: [claimId], contentHash: "", hashInput: {}, validationReport: { checks: [] }, runGroupId: groupId });
    await tx.insert(s.claims).values({ id: claimId, caseId, packetVersionId: packetId, sectionHeading: "Summary", position: 0, text: "Patient reports improved sleep.", type: "clinical_fact", sourceKind: "direct_quote", status: "source_verified", author: "clinical-documentation", agentRunId: runId, factIds: ["f1"] });
    const spanId = randomUUID();
    await tx.insert(s.evidenceSpans).values({ id: spanId, documentId: noteId, startOffset: 0, endOffset: 31, excerpt: "Patient reports improved sleep.", method: "manual" });
    await tx.insert(s.claimEvidence).values({ claimId, evidenceSpanId: spanId });
  });
  const initial = await withCaseLock(db, caseId, (tx) => refreshPacketHash(tx, caseId, packetId));
  assert.deepEqual(initial.blockers, [], "ready synthetic packet must pass");
  assert.ok(initial.hash);
  const refused = await withCaseLock(db, caseId, (tx) => approve(tx, caseId, actor, { packetVersionId: packetId, contentHash: "0".repeat(64), acknowledgement: "Reviewed synthetic sources" }));
  assert.ok("error" in refused);
  assert.equal(refused.error.code, "stale_hash");
  const request = { packetVersionId: packetId, contentHash: initial.hash, acknowledgement: "Reviewed synthetic sources" };
  const results = await Promise.all([withCaseLock(db, caseId, (tx) => approve(tx, caseId, actor, request)), withCaseLock(db, caseId, (tx) => approve(tx, caseId, actor, request))]);
  for (const result of results) assert.ok(!("error" in result), "simultaneous approvals should succeed idempotently");
  assert.equal((results[0] as typeof s.approvals.$inferSelect).id, (results[1] as typeof s.approvals.$inferSelect).id);
  assert.equal((await db.select().from(s.approvals).where(eq(s.approvals.caseId, caseId))).length, 1);
  await withCaseLock(db, caseId, async (tx) => {
    await editClaim({ db: tx, user: actor, caseId, body: { text: "Patient reports improved sleep." }, request: new Request("http://localhost/test") }, claimId);
    assert.equal((await tx.select().from(s.packetVersions).where(eq(s.packetVersions.caseId, caseId))).length, 1, "no-op edit must not create a packet version");
    const [approval] = await tx.select().from(s.approvals).where(eq(s.approvals.caseId, caseId));
    assert.equal(approval.status, "valid", "no-op edit must preserve approval");
  });
  const harmless = await withCaseLock(db, caseId, async (tx) => {
    await tx.insert(s.reviewPeriods).values({ id: randomUUID(), caseId, requestedStart: today, requestedEnd: today, sourceDocumentId: requestId, version: 2 });
    assert.equal(await recheckApproval(tx, caseId), false);
    return loadValidation(tx, caseId, packetId);
  });
  assert.equal(harmless.hash, initial.hash, "new period version with same dates does not invalidate");
  await withCaseLock(db, caseId, async (tx) => {
    await tx.update(s.claims).set({ text: "Patient reports poor sleep.", status: "clinician_edited" }).where(eq(s.claims.id, claimId));
    assert.equal(await recheckApproval(tx, caseId), true);
  });
  const [invalidated] = await db.select().from(s.approvals).where(eq(s.approvals.caseId, caseId));
  assert.equal(invalidated.status, "invalidated");
  const [caseRecord] = await db.select().from(s.cases).where(eq(s.cases.id, caseId));
  assert.equal(caseRecord.status, "needs_review");
  await withCaseLock(db, caseId, async (tx) => {
    await tx.update(s.claims).set({ status: "source_verified" }).where(eq(s.claims.id, claimId));
    await tx.update(s.documents).set({ verificationState: "rejected" }).where(eq(s.documents.id, noteId));
    const validation = await loadValidation(tx, caseId, packetId);
    assert.ok(validation.blockers.some(({ code }) => code === "date_coverage_gap"));
    assert.ok(validation.blockers.some(({ code, objectId }) => code === "validation_failed" && objectId === "evidence_integrity"));
    const history = await refreshPacketHash(tx, caseId, packetId);
    assert.equal(history.packet?.contentHash, initial.hash, "approval history freezes stored packet hash");
  });
  // Rejection removes a claim from both the content layout and hash membership.
  const nextPacketId = randomUUID(), firstCloneId = randomUUID(), secondCloneId = randomUUID();
  await withCaseLock(db, caseId, async (tx) => {
    await tx.update(s.documents).set({ verificationState: "verified" }).where(eq(s.documents.id, noteId));
    await tx.insert(s.packetVersions).values({ id: nextPacketId, caseId, version: 2, kind: "review_packet", content: { sections: [{ heading: "Summary", claimIds: [firstCloneId, secondCloneId] }] }, includedClaimIds: [firstCloneId, secondCloneId], contentHash: "", hashInput: {}, validationReport: { checks: [] }, runGroupId: groupId });
    for (const [position, id] of [firstCloneId, secondCloneId].entries()) {
      await tx.insert(s.claims).values({ id, caseId, packetVersionId: nextPacketId, sectionHeading: "Summary", position, text: "Patient reports improved sleep.", type: "clinical_fact", sourceKind: "direct_quote", status: "source_verified", author: "clinical-documentation", agentRunId: runId });
      const spanId = randomUUID();
      await tx.insert(s.evidenceSpans).values({ id: spanId, documentId: noteId, startOffset: 0, endOffset: 31, excerpt: "Patient reports improved sleep.", method: "manual" });
      await tx.insert(s.claimEvidence).values({ claimId: id, evidenceSpanId: spanId });
    }
    await tx.update(s.packetVersions).set({ validationReport: { checks: [{ name: "packet_integrity", result: "fail", detail: "Synthetic model finding", affected: [], origin: "model" }] } }).where(eq(s.packetVersions.id, nextPacketId));
    const modelFailure = await loadValidation(tx, caseId, nextPacketId);
    assert.ok(modelFailure.blockers.some(({ code, objectId }) => code === "validation_failed" && objectId === "packet_integrity"), "recomputing code checks never drops a same-named model failure");
    await tx.update(s.packetVersions).set({ validationReport: { checks: [] } }).where(eq(s.packetVersions.id, nextPacketId));
    await refreshPacketHash(tx, caseId, nextPacketId);
    await editClaim({ db: tx, user: actor, caseId, body: { status: "rejected" }, request: new Request("http://localhost/test") }, firstCloneId);
    const validation = await loadValidation(tx, caseId, nextPacketId);
    assert.deepEqual(validation.blockers, [], "rejecting one of two claims leaves a coherent packet");
    await editClaim({ db: tx, user: actor, caseId, body: { status: "rejected" }, request: new Request("http://localhost/test") }, secondCloneId);
    const empty = await loadValidation(tx, caseId, nextPacketId);
    assert.ok(empty.blockers.some(({ code, objectId }) => code === "validation_failed" && objectId === "packet_integrity"), "empty packet cannot be approved");
  });
  const audits = await db.select().from(s.auditEvents).where(eq(s.auditEvents.caseId, caseId));
  assert.equal(audits.filter(({ action }) => action === "packet_approved").length, 1);
  assert.equal(audits.filter(({ action }) => action === "approval_refused").length, 1);
  assert.equal(audits.filter(({ action }) => action === "approval_invalidated").length, 1);
}
