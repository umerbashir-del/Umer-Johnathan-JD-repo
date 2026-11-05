/** Synthetic database/API adversarial tests. No model client is created. */
import "../scripts/load-env";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { connectDatabase, type Transaction } from "../lib/db";
import * as s from "../lib/db/schema";
import { seed, DEMO_USER_ID } from "../lib/db/seed";
import { fixtureId, contentHash } from "../lib/fixtures/ids";
import { parseFrontMatter } from "../lib/fixtures/load-fixture";
import { getEnv } from "../lib/env";
import { handleApi } from "../lib/http/api";
import type { SessionUser } from "../lib/auth/access";
import { withCaseLock } from "../lib/cases/lock";
import { loadValidation, refreshPacketHash } from "../lib/validation/snapshot";
import { approve as approvePacket } from "../lib/cases/approval";
import { editClaim } from "../lib/cases/claims";
import { uploadDocument } from "../lib/cases/documents";
import { assignCase } from "../lib/cases/role-workspace";
import { startGroup } from "../lib/orchestrator/run";

const env = getEnv();
assert.equal(env.APP_DEPLOYMENT, "local");
assert(env.DATABASE_URL && new URL(env.DATABASE_URL).pathname.endsWith("_test"));
assert(["localhost", "127.0.0.1"].includes(new URL(env.DATABASE_URL).hostname));
assert.equal(env.FREEFORM_UPLOAD_ENABLED, false, "Run with the synthetic upload allowlist enabled");
const { db, pool } = connectDatabase(env.DATABASE_URL);
const local = { ...env, APP_ORIGIN: "http://localhost:3000", AGENT_REPLAY: true, ANTHROPIC_API_KEY: null };
const actor = (account: string, role: string): SessionUser => ({ userId: fixtureId("users", account), role });
const clinician = actor("clinician_a", "clinician"), coordinator = actor("coordinator_a", "coordinator"), manager = actor("manager_a", "supervisor"), packetStaff = actor("packet_a", "packet_staff");
const runLabel = z.enum(["before", "after"]).parse(process.argv[2] ?? "after");
type Fixture = { caseId: string; packetId: string; claimId: string; spanId: string; noteId: string; hash: string; issueId: string; groupId: string };
const mutations = ["edit", "reject", "upload", "reassign", "start-run"] as const;
type Mutation = typeof mutations[number];
const results: { name: string; passed: boolean; detail?: string }[] = [];
let lateContent = "";
async function api(user: SessionUser | null, method: string, path: string, body?: unknown, origin = local.APP_ORIGIN) {
 return handleApi(new Request(`${local.APP_ORIGIN}/api/${path}`, { method, headers: { "Content-Type": "application/json", Origin: origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split("/"), { db, session: async () => user, env: local, schedule: () => { /* Deliberately leave a started run incomplete. No model calls. */ } });
}
const approvalBody = (fixture: Fixture) => ({ packetVersionId: fixture.packetId, contentHash: fixture.hash, acknowledgement: "Reviewed the exact synthetic security-test packet and sources" });
const approve = (fixture: Fixture, user = clinician) => api(user, "POST", `cases/${fixture.caseId}/approve`, approvalBody(fixture));
async function check(name: string, work: () => Promise<void>) {
 try { await work(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
 catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : "assertion_failed" }); console.log(`FAIL ${name}`); }
}
async function fixture(label: string, assignee = DEMO_USER_ID): Promise<Fixture> {
 const [template] = await db.select().from(s.cases).where(eq(s.cases.id, "UR-1042"));
 const sourceDocs = await db.select().from(s.documents).where(eq(s.documents.caseId, "UR-1042"));
 const [period] = await db.select().from(s.reviewPeriods).where(eq(s.reviewPeriods.caseId, "UR-1042"));
 const [authorization] = await db.select().from(s.authorizations).where(eq(s.authorizations.caseId, "UR-1042"));
 const allow = await db.select().from(s.uploadAllowlist).where(eq(s.uploadAllowlist.caseId, "UR-1042"));
 const caseId = `UR-1042-SEC-${label}-${randomUUID().slice(0, 8)}`;
 const ids = new Map(sourceDocs.map(document => [document.id, randomUUID()]));
 const packetId = randomUUID(), claimId = randomUUID(), spanId = randomUUID(), groupId = randomUUID(), issueId = randomUUID();
 const note = sourceDocs.find(document => document.type === "progress_note" && document.serviceDate === "2026-11-03")!;
 const quote = note.content.split(/\r?\n/).find(line => line.startsWith("Subjective:"))!;
 assert(quote);
 await db.transaction(async tx => {
  await tx.insert(s.cases).values({ ...template, id: caseId, assignedTo: assignee, status: "needs_review", createdAt: new Date(), updatedAt: new Date() });
  await tx.insert(s.documents).values(sourceDocs.map(document => ({ ...document, id: ids.get(document.id)!, caseId })));
  await tx.insert(s.documents).values({ id: randomUUID(), caseId, type: "progress_note", title: "Synthetic late source", author: "Fictional clinician", serviceDate: "2026-11-02", receivedAt: new Date("2026-11-03T14:00:00Z"), version: 1, content: lateContent, contentHash: contentHash(lateContent), verificationState: "verified", verificationSource: "seed", origin: "seed" });
  await tx.insert(s.reviewPeriods).values({ ...period, id: randomUUID(), caseId, sourceDocumentId: ids.get(period.sourceDocumentId!)! });
  await tx.insert(s.authorizations).values({ ...authorization, id: randomUUID(), caseId, sourceDocumentId: ids.get(authorization.sourceDocumentId!)! });
  await tx.insert(s.uploadAllowlist).values(allow.map(row => ({ ...row, caseId })));
  for (const member of [clinician, coordinator, manager, packetStaff, actor("clinician_b", "clinician")]) await tx.insert(s.caseMembers).values({ caseId, userId: member.userId });
  await tx.insert(s.issues).values({ id: issueId, caseId, type: "date_conflict", severity: "minor", blocking: false, ownerId: assignee, status: "open", source: "code", description: "Synthetic nonblocking permission-test issue", dedupeKey: "security-test" });
  await tx.insert(s.runGroups).values({ id: groupId, caseId, status: "complete", startedBy: assignee, asOf: new Date("2026-11-03T20:00:00Z"), finishedAt: new Date() });
  const documents = await tx.select().from(s.documents).where(eq(s.documents.caseId, caseId));
  const runIds = [randomUUID(), randomUUID(), randomUUID()];
  await tx.insert(s.agentRuns).values(["clinical_documentation", "case_assembly_drafting", "independent_quality"].map((agent, index) => ({ id: runIds[index], caseId, runGroupId: groupId, agent, agentVersion: "synthetic-security-fixture", model: "no-model-call", inputHash: "synthetic-fixture", inputDocumentIds: documents.filter(document => document.type !== "policy").map(document => document.id), status: "succeeded", attempts: 1, finishedAt: new Date() })));
  await tx.insert(s.packetVersions).values({ id: packetId, caseId, version: 1, kind: "review_packet", content: { sections: [{ heading: "Synthetic source-backed summary", claimIds: [claimId] }] }, includedClaimIds: [claimId], contentHash: "pending", hashInput: {}, validationReport: { checks: [] }, runGroupId: groupId });
  await tx.insert(s.claims).values({ id: claimId, caseId, packetVersionId: packetId, sectionHeading: "Synthetic source-backed summary", position: 0, text: quote, type: "clinical_fact", sourceKind: "direct_quote", status: "source_verified", author: "case_assembly_drafting", agentRunId: runIds[1], factIds: ["f1"] });
  const start = note.content.indexOf(quote);
  await tx.insert(s.evidenceSpans).values({ id: spanId, documentId: ids.get(note.id)!, startOffset: start, endOffset: start + quote.length, excerpt: quote, method: "verified_quote" });
  await tx.insert(s.claimEvidence).values({ claimId, evidenceSpanId: spanId });
 });
 const ready = await withCaseLock(db, caseId, tx => refreshPacketHash(tx, caseId, packetId));
 assert.deepEqual(ready.blockers, [], `${label}: initial fixture must be approvable`); assert(ready.hash);
 return { caseId, packetId, claimId, spanId, noteId: ids.get(note.id)!, hash: ready.hash, issueId, groupId };
}
async function noValidApproval(f: Fixture) {
 assert.equal((await db.select().from(s.approvals).where(and(eq(s.approvals.caseId, f.caseId), eq(s.approvals.status, "valid")))).length, 0);
}
async function waitForBlockedRequest() {
 for (let attempt = 0; attempt < 160; attempt++) {
  const rows = await db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()) AS waiting`);
  if (rows.rows[0]?.waiting === true) return;
  await delay(25);
 }
 throw new Error("Request never reached the PostgreSQL lock barrier");
}
/** Confirm the API request is waiting on the case row before changing its authority. */
async function queuedRequest(f: Fixture, request: () => Promise<Response>, change: (tx: Transaction) => Promise<void>) {
 const pending: { response?: Promise<Response> } = {};
 try { await withCaseLock(db, f.caseId, async tx => { pending.response = request(); await waitForBlockedRequest(); await change(tx); }); }
 catch (error) { if (pending.response) await pending.response; throw error; }
 assert(pending.response); return pending.response;
}
function mutationRequest(f: Fixture, mutation: Mutation) {
 return mutation === "edit" ? api(clinician, "PATCH", `claims/${f.claimId}`, { text: "Reviewed wording: synthetic source-backed statement" })
  : mutation === "reject" ? api(clinician, "PATCH", `claims/${f.claimId}`, { status: "rejected" })
  : mutation === "upload" ? api(coordinator, "POST", `cases/${f.caseId}/documents`, { type: "progress_note", title: "Synthetic late source", content: lateContent })
  : mutation === "reassign" ? api(manager, "PATCH", `cases/${f.caseId}/assignment`, { assignedTo: fixtureId("users", "clinician_b"), expectedAssignedTo: DEMO_USER_ID })
  : api(clinician, "POST", `cases/${f.caseId}/runs`, {});
}
async function mutationUnderLock(tx: Transaction, f: Fixture, mutation: Mutation) {
 const context = { db: tx, user: clinician, caseId: f.caseId, request: new Request(`${local.APP_ORIGIN}/api/cases/${f.caseId}`) };
 if (mutation === "edit" || mutation === "reject") await editClaim({ ...context, body: mutation === "edit" ? { text: "Reviewed wording: synthetic source-backed statement" } : { status: "rejected" } }, f.claimId);
 else if (mutation === "upload") await uploadDocument({ ...context, user: coordinator, body: { type: "progress_note", title: "Synthetic late source", content: lateContent } });
 else if (mutation === "reassign") await assignCase({ ...context, user: manager, body: { assignedTo: fixtureId("users", "clinician_b"), expectedAssignedTo: DEMO_USER_ID } });
 else await startGroup(tx, f.caseId, clinician.userId, local);
}
async function main() {
 assert.equal((await db.select().from(s.cases).limit(1)).length, 0, "Fresh test DB required");
 await seed(db);
 const originals = await db.select().from(s.documents).where(eq(s.documents.caseId, "UR-1042"));
 lateContent = parseFrontMatter(await readFile("fixtures/ur-1042/late-arrival/note-2026-11-02.md", "utf8")).body;
 await check("ten concurrent sign-offs are idempotent and audited once", async () => {
  const f = await fixture("concurrent-approvals");
  const responses = await Promise.all(Array.from({ length: 10 }, () => approve(f)));
  for (const response of responses) assert.equal(response.status, 200);
  const ids = await Promise.all(responses.map(async response => z.object({ id: z.string() }).parse(await response.json()).id));
  assert.equal(new Set(ids).size, 1);
  assert.equal((await db.select().from(s.approvals).where(eq(s.approvals.caseId, f.caseId))).length, 1);
  assert.equal((await db.select().from(s.auditEvents).where(and(eq(s.auditEvents.caseId, f.caseId), eq(s.auditEvents.action, "packet_approved")))).length, 1);
 });
 for (const mutation of mutations) await check(`concurrent sign-off versus ${mutation} cannot release a stale packet`, async () => {
  const f = await fixture(`race-${mutation}`);
  const [approval, changed] = await Promise.all([approve(f), mutationRequest(f, mutation)]);
  assert([200, 403, 404, 409].includes(approval.status)); assert.equal(changed.status, 200);
  assert.equal((await api(packetStaff, "GET", `cases/${f.caseId}/packet`)).status, 409);
  if (mutation !== "start-run") await noValidApproval(f);
  if (mutation === "start-run") assert.equal((await approve(f)).status, 409);
 });
 for (const mutation of mutations) for (const first of ["approval", "mutation"] as const) await check(`lock barrier: ${first} commits before ${mutation} race finishes`, async () => {
  const f = await fixture(`ordered-${first}-${mutation}`);
  if (first === "mutation") {
   const response = await queuedRequest(f, () => approve(f), tx => mutationUnderLock(tx, f, mutation));
   assert.equal(response.status, mutation === "reassign" ? 404 : 409);
  } else {
   const response = await queuedRequest(f, () => mutationRequest(f, mutation), async tx => {
    const saved = await approvePacket(tx, f.caseId, clinician, approvalBody(f));
    assert(!("error" in saved), "The valid approval must commit before the queued change");
   });
   assert.equal(response.status, 200);
  }
  assert.equal((await api(packetStaff, "GET", `cases/${f.caseId}/packet`)).status, 409);
  if (mutation !== "start-run") await noValidApproval(f);
  else assert.equal((await approve(f)).status, 409);
 });
 await check("an unverified source arriving after recheck blocks direct API sign-off", async () => {
  const f = await fixture("new-source");
  assert.equal((await api(coordinator, "POST", `cases/${f.caseId}/documents`, { type: "progress_note", title: "Synthetic duplicate arrival", content: lateContent })).status, 200);
  assert.equal((await approve(f)).status, 409);
  await noValidApproval(f);
 });
 await check("source content changed outside the quote is detected despite unchanged stored fingerprint", async () => {
  const f = await fixture("source-content");
  const [note] = await db.select().from(s.documents).where(eq(s.documents.id, f.noteId));
  await db.update(s.documents).set({ content: note.content + "\nSYNTHETIC ALTERED CONTEXT OUTSIDE THE QUOTE" }).where(eq(s.documents.id, f.noteId));
  assert.equal((await approve(f)).status, 409);
  await noValidApproval(f);
 });
 for (const mode of ["quote", "offset", "missing-link", "rejected-source"] as const) await check(`evidence tampering: ${mode} blocks approval`, async () => {
  const f = await fixture(mode);
  if (mode === "quote") await db.update(s.evidenceSpans).set({ excerpt: "Invented synthetic quote" }).where(eq(s.evidenceSpans.id, f.spanId));
  if (mode === "offset") await db.update(s.evidenceSpans).set({ startOffset: 0 }).where(eq(s.evidenceSpans.id, f.spanId));
  if (mode === "missing-link") await db.delete(s.claimEvidence).where(eq(s.claimEvidence.claimId, f.claimId));
  if (mode === "rejected-source") await db.update(s.documents).set({ verificationState: "rejected" }).where(eq(s.documents.id, f.noteId));
  assert.equal((await approve(f)).status, 409); await noValidApproval(f);
 });
 await check("edited material claims still require evidence after hash refresh", async () => {
  const f = await fixture("edited-no-evidence");
  await db.update(s.claims).set({ status: "clinician_edited" }).where(eq(s.claims.id, f.claimId));
  await db.delete(s.claimEvidence).where(eq(s.claimEvidence.claimId, f.claimId));
  const current = await withCaseLock(db, f.caseId, tx => refreshPacketHash(tx, f.caseId, f.packetId));
  assert(current.blockers.some(blocker => blocker.objectId === "evidence_integrity"));
  assert.equal((await approve({ ...f, hash: current.hash! })).status, 409);
 });
 await check("cross-case source substitution is rejected without leaking source text", async () => {
  const f = await fixture("cross-case"), other = await fixture("foreign-source");
  await db.update(s.evidenceSpans).set({ documentId: other.noteId }).where(eq(s.evidenceSpans.id, f.spanId));
  const response = await approve(f); assert.equal(response.status, 409);
  assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code, "validation_data_invalid"); await noValidApproval(f);
 });
 await check("application database role cannot mutate original contents", async () => {
  const f = await fixture("db-grant");
  await assert.rejects(db.transaction(async tx => { await tx.execute(sql`SET LOCAL ROLE app_rw`); await tx.update(s.documents).set({ content: "tampered" }).where(eq(s.documents.id, f.noteId)); }));
  assert.deepEqual((await loadValidation(db, f.caseId)).blockers, []);
 });
 for (const role of [coordinator, manager, packetStaff]) await check(`${role.role} cannot forge clinical or approval permissions`, async () => {
  const f = await fixture(`deny-${role.role}`);
  for (const [method, path, body] of [["POST", `cases/${f.caseId}/approve`, approvalBody(f)], ["PATCH", `claims/${f.claimId}`, { text: "forged" }], ["POST", `documents/${f.noteId}/verify`, { decision: "verified" }], ["POST", `cases/${f.caseId}/runs`, {}], ["POST", `issues/${f.issueId}/resolve`, { resolution: "verify_period", reason: "forged", evidenceDocumentId: f.noteId, verifiedPeriod: { start: "2026-11-04", end: "2026-11-06" } }]] as const) assert.equal((await api(role, method, path, body)).status, 403);
  await noValidApproval(f);
 });
 await check("foreign clinician cannot read or change another case by resource ID", async () => {
  const f = await fixture("foreign-case", fixtureId("users", "clinician_b"));
  for (const path of [`cases/${f.caseId}`, `documents/${f.noteId}`, `runs/${f.groupId}`]) assert.equal((await api(clinician, "GET", path)).status, 404);
  assert.equal((await api(clinician, "PATCH", `claims/${f.claimId}`, { text: "forged" })).status, 404);
  assert.equal((await approve(f)).status, 404);
 });
 await check("forged approval fields, hashes and origins are rejected", async () => {
  const f = await fixture("forged-payload");
  assert.equal((await api(null, "POST", `cases/${f.caseId}/approve`, approvalBody(f))).status, 401);
  assert.equal((await api(clinician, "POST", `cases/${f.caseId}/approve`, { ...approvalBody(f), role: "clinician", approvedBy: coordinator.userId, status: "valid" })).status, 400);
  assert.equal((await approve({ ...f, hash: "0".repeat(64) })).status, 409);
  assert.equal((await api(clinician, "POST", `cases/${f.caseId}/approve`, approvalBody(f), "https://evil.example.test")).status, 403);
  await noValidApproval(f);
 });
 await check("upload cannot forge verification or introduce altered allowlisted content", async () => {
  const f = await fixture("forged-upload");
  assert.equal((await api(coordinator, "POST", `cases/${f.caseId}/documents`, { type: "progress_note", title: "forged", content: lateContent, verificationState: "verified", contentHash: contentHash(lateContent) })).status, 400);
  assert.equal((await api(coordinator, "POST", `cases/${f.caseId}/documents`, { type: "progress_note", title: "altered", content: lateContent + "\nAltered" })).status, 422);
 });
 await check("membership revoked while waiting on a case lock blocks the queued write", async () => {
  const f = await fixture("membership-race");
  const response = await queuedRequest(f, () => api(coordinator, "POST", `cases/${f.caseId}/documents`, { type: "progress_note", title: "queued", content: lateContent }), async tx => { await tx.delete(s.caseMembers).where(and(eq(s.caseMembers.caseId, f.caseId), eq(s.caseMembers.userId, coordinator.userId))); });
  assert.equal(response.status, 404);
 });
 await check("role revoked while waiting on a case lock blocks queued sign-off", async () => {
  const f = await fixture("role-race");
  try {
   const response = await queuedRequest(f, () => approve(f), async tx => { await tx.update(s.users).set({ role: "coordinator" }).where(eq(s.users.id, clinician.userId)); });
   assert.equal(response.status, 403); await noValidApproval(f);
  } finally { await db.update(s.users).set({ role: "clinician" }).where(eq(s.users.id, clinician.userId)); }
 });
 await check("manager role revoked while waiting blocks queued reassignment", async () => {
  const f = await fixture("manager-role-race");
  try {
   const response = await queuedRequest(f, () => api(manager, "PATCH", `cases/${f.caseId}/assignment`, { assignedTo: fixtureId("users", "clinician_b"), expectedAssignedTo: DEMO_USER_ID }), async tx => { await tx.update(s.users).set({ role: "coordinator" }).where(eq(s.users.id, manager.userId)); });
   assert.equal(response.status, 403);
   const [row] = await db.select().from(s.cases).where(eq(s.cases.id, f.caseId)); assert.equal(row.assignedTo, DEMO_USER_ID);
  } finally { await db.update(s.users).set({ role: "supervisor" }).where(eq(s.users.id, manager.userId)); }
 });
 await check("a newer completed run cannot launder an unverified source", async () => {
  const f = await fixture("unverified-rerun");
  assert.equal((await api(coordinator, "POST", `cases/${f.caseId}/documents`, { type: "progress_note", title: "Synthetic new source", content: lateContent })).status, 200);
  // Fault-inject the resulting completed-run state: unverified documents are
  // excluded from agent input, so a newer timestamp alone must not clear them.
  await db.update(s.runGroups).set({ startedAt: new Date(Date.now() + 1000) }).where(eq(s.runGroups.id, f.groupId));
  const current = await withCaseLock(db, f.caseId, tx => refreshPacketHash(tx, f.caseId, f.packetId));
  assert(current.blockers.some(blocker => blocker.objectId === "source_verification"));
  assert.equal((await approve({ ...f, hash: current.hash! })).status, 409);
 });
 await check("hash refresh and model pass cannot clear source-content corruption", async () => {
  const f = await fixture("refresh-corruption");
  const [source] = await db.select().from(s.documents).where(eq(s.documents.id, f.noteId));
  await db.update(s.documents).set({ content: source.content + "\nSynthetic corrupted context" }).where(eq(s.documents.id, f.noteId));
  await db.update(s.packetVersions).set({ validationReport: { checks: [{ name: "source_integrity", result: "pass", origin: "model" }] } }).where(eq(s.packetVersions.id, f.packetId));
  const current = await withCaseLock(db, f.caseId, tx => refreshPacketHash(tx, f.caseId, f.packetId));
  assert(current.blockers.some(blocker => blocker.objectId === "source_integrity"));
  assert.equal((await approve({ ...f, hash: current.hash! })).status, 409);
 });
 await check("old packet ID cannot borrow the new packet hash after an approved edit", async () => {
  const f = await fixture("old-version-new-hash");
  assert.equal((await approve(f)).status, 200);
  assert.equal((await api(clinician, "PATCH", `claims/${f.claimId}`, { text: "Reviewed wording: exact synthetic review context" })).status, 200);
  const current = await loadValidation(db, f.caseId); assert.notEqual(current.packet?.id, f.packetId);
  assert.equal((await approve({ ...f, hash: current.hash! })).status, 409);
  await noValidApproval(f);
 });
 await check("HTTP clients cannot patch original text or supply new evidence links", async () => {
  const f = await fixture("http-evidence-fields");
  assert.equal((await api(clinician, "PATCH", `documents/${f.noteId}`, { content: "tampered" })).status, 404);
  assert.equal((await api(clinician, "PATCH", `claims/${f.claimId}`, { text: "tampered", evidence: [{ documentId: f.noteId, excerpt: "invented" }] })).status, 400);
  assert.deepEqual((await loadValidation(db, f.caseId)).blockers, []);
 });
 await check("revoked packet-reader role cannot finish a queued packet read", async () => {
  const f = await fixture("packet-role-race"); assert.equal((await approve(f)).status, 200);
  try {
   const response = await queuedRequest(f, () => api(packetStaff, "GET", `cases/${f.caseId}/packet`), async tx => { await tx.update(s.users).set({ role: "coordinator" }).where(eq(s.users.id, packetStaff.userId)); });
   assert.equal(response.status, 403);
  } finally { await db.update(s.users).set({ role: "packet_staff" }).where(eq(s.users.id, packetStaff.userId)); }
 });
 assert.deepEqual((await db.select().from(s.documents).where(eq(s.documents.caseId, "UR-1042"))).toSorted((a, b) => a.id.localeCompare(b.id)), originals.toSorted((a, b) => a.id.localeCompare(b.id)), "Original UR-1042 sources must remain untouched");
 const report = { passed: results.every(result => result.passed), scenarios: results.length, passedCount: results.filter(result => result.passed).length, liveModelCalls: 0, mode: "seeded synthetic packets + real API/PostgreSQL; no model client", originalUR1042Unchanged: true, results };
 await mkdir(".e2e-results", { recursive: true }); await writeFile(`.e2e-results/security-${runLabel}.json`, JSON.stringify(report, null, 2));
 console.log(JSON.stringify({ ...report, results: results.filter(result => !result.passed) }, null, 2)); if (!report.passed) process.exitCode = 1;
}
main().finally(() => pool.end());
