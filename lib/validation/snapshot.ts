import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import * as s from "../db/schema";
import { CHECK_RESULTS, CLAIM_SOURCE_KINDS, CLAIM_STATUSES, CLAIM_TYPES, DOCUMENT_VERIFICATION_STATES, ISSUE_STATUSES, PACKET_KINDS, RUN_GROUP_STATUSES } from "../db/enums";
import { businessDate, businessNow } from "../clock";
import { HttpError } from "../http/errors";
import { buildHashInput, computeApprovalHash, type CanonicalValue, type HashSource } from "./approval-hash";
import { evaluateGate, type Blocker, type GateSnapshot } from "./gate";

const checkSchema = z.object({ name: z.string().min(1), result: z.enum(CHECK_RESULTS), detail: z.string().default(""), affected: z.array(z.string()).default([]), origin: z.enum(["code", "model"]).optional() });
const reportSchema = z.object({ checks: z.array(checkSchema) });
const contentSchema = z.object({ sections: z.array(z.object({ heading: z.string(), claimIds: z.array(z.string()) })) });
export type ValidationReport = { checks: z.infer<typeof checkSchema>[]; blockerCodes: Blocker["code"][] };
export type LoadedValidation = {
  packet: typeof s.packetVersions.$inferSelect | null;
  report: ValidationReport;
  blockers: Blocker[];
  hash: string | null;
  hashInput: CanonicalValue | null;
  snapshot: GateSnapshot;
};

function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(409, "validation_data_invalid");
  return result.data;
}

export async function loadValidation(tx: Db, caseId: string, packetId?: string, requestedHash?: string): Promise<LoadedValidation> {
  const [caseRecord] = await tx.select().from(s.cases).where(eq(s.cases.id, caseId));
  if (!caseRecord) throw new HttpError(404, "not_found");
  const [packet] = await tx.select().from(s.packetVersions).where(packetId ? and(eq(s.packetVersions.caseId, caseId), eq(s.packetVersions.id, packetId)) : eq(s.packetVersions.caseId, caseId)).orderBy(desc(s.packetVersions.version)).limit(1);
  if (packetId && !packet) throw new HttpError(404, "not_found");
  const [period] = await tx.select().from(s.reviewPeriods).where(eq(s.reviewPeriods.caseId, caseId)).orderBy(desc(s.reviewPeriods.version)).limit(1);
  const authorizationRows = await tx.select().from(s.authorizations).where(eq(s.authorizations.caseId, caseId)).orderBy(desc(s.authorizations.createdAt));
  const documentRows = await tx.select().from(s.documents).where(eq(s.documents.caseId, caseId));
  const issueRows = await tx.select().from(s.issues).where(eq(s.issues.caseId, caseId));
  const [latestGroup] = await tx.select().from(s.runGroups).where(eq(s.runGroups.caseId, caseId)).orderBy(desc(s.runGroups.startedAt), desc(s.runGroups.createdAt)).limit(1);
  const claimRows = packet ? await tx.select().from(s.claims).where(and(eq(s.claims.caseId, caseId), eq(s.claims.packetVersionId, packet.id))) : [];
  const includedIds = new Set(packet?.includedClaimIds ?? []);
  const checks = packet ? decode(reportSchema, packet.validationReport).checks.filter(({ name, origin }) => origin !== "code" || (name !== "packet_integrity" && name !== "evidence_integrity")) : [];
  const content = packet ? decode(contentSchema, packet.content) : null;
  const documents = documentRows.map((document) => ({ ...document, verificationState: decode(z.enum(DOCUMENT_VERIFICATION_STATES), document.verificationState) }));
  const snapshot: GateSnapshot = {
    asOfDate: businessDate(businessNow()),
    latestRunGroupStatus: latestGroup ? decode(z.enum(RUN_GROUP_STATUSES), latestGroup.status) : null,
    issues: issueRows.map((issue) => ({ id: issue.id, blocking: issue.blocking, status: decode(z.enum(ISSUE_STATUSES), issue.status) })),
    documents: documents.map(({ id, type, serviceDate, verificationState }) => ({ id, type, serviceDate, verificationState })),
    authorizationDocumentId: authorizationRows[0]?.sourceDocumentId ?? null,
    requestDocumentId: period?.sourceDocumentId ?? null,
    stay: authorizationRows[0] ? { start: authorizationRows[0].approvedStart, end: authorizationRows[0].approvedEnd } : null,
    claims: claimRows.map((claim) => ({ id: claim.id, included: includedIds.has(claim.id), status: decode(z.enum(CLAIM_STATUSES), claim.status), material: claim.material, boundaryFlagged: claim.boundaryFlagged })),
    checks,
    hash: { recomputed: "", stored: packet?.contentHash ?? null, requested: requestedHash ?? null },
  };
  if (!packet || !period || !content) {
    if (packet && !period) snapshot.checks = [...checks, { name: "review_period_missing", result: "fail" }];
    const blockers = evaluateGate(snapshot);
    return { packet: packet ?? null, report: { checks, blockerCodes: blockers.map(({ code }) => code) }, blockers, hash: null, hashInput: null, snapshot };
  }
  const packetRuns = packet.runGroupId ? await tx.select().from(s.agentRuns).where(and(eq(s.agentRuns.caseId, caseId), eq(s.agentRuns.runGroupId, packet.runGroupId))) : [];
  const evidence = claimRows.length ? await tx.select({ claimId: s.claimEvidence.claimId, span: s.evidenceSpans, document: s.documents }).from(s.claimEvidence)
    .innerJoin(s.evidenceSpans, eq(s.claimEvidence.evidenceSpanId, s.evidenceSpans.id))
    .innerJoin(s.documents, eq(s.evidenceSpans.documentId, s.documents.id))
    .where(inArray(s.claimEvidence.claimId, claimRows.map(({ id }) => id))) : [];
  const readDocumentIds = new Set(packetRuns.flatMap((run) => run.inputDocumentIds));
  for (const entry of evidence) {
    if (entry.document.caseId !== caseId) throw new HttpError(409, "validation_data_invalid");
    readDocumentIds.add(entry.document.id);
  }
  const actualClaimIds = new Set(claimRows.map(({ id }) => id));
  const contentClaimIds = content.sections.flatMap(({ claimIds }) => claimIds);
  const layoutValid = includedIds.size > 0 && contentClaimIds.length === new Set(contentClaimIds).size && contentClaimIds.length === includedIds.size && contentClaimIds.every((id) => includedIds.has(id) && actualClaimIds.has(id));
  if (!layoutValid) checks.push({ name: "packet_integrity", result: "fail", detail: "", affected: [], origin: "code" });
  const evidenceValid = claimRows.filter((claim) => includedIds.has(claim.id) && claim.material && claim.status === "source_verified").every((claim) => evidence.some((entry) => entry.claimId === claim.id)) && evidence.every(({ span, document }) => document.verificationState === "verified" && span.startOffset >= 0 && span.endOffset > span.startOffset && span.endOffset <= document.content.length && document.content.slice(span.startOffset, span.endOffset) === span.excerpt);
  if (!evidenceValid) checks.push({ name: "evidence_integrity", result: "fail", detail: "", affected: [], origin: "code" });
  const source: HashSource = {
    packet: { id: packet.id, version: packet.version, kind: decode(z.enum(PACKET_KINDS), packet.kind), headings: content.sections.map(({ heading }) => heading), createdAt: packet.createdAt.toISOString() },
    claims: claimRows.map((claim) => ({ ...claim, included: includedIds.has(claim.id), type: decode(z.enum(CLAIM_TYPES), claim.type), sourceKind: decode(z.enum(CLAIM_SOURCE_KINDS), claim.sourceKind), status: decode(z.enum(CLAIM_STATUSES), claim.status), createdAt: claim.createdAt.toISOString(), evidence: evidence.filter((entry) => entry.claimId === claim.id).map(({ span, document }) => ({ spanId: span.id, documentId: document.id, documentVersion: document.version, contentHash: document.contentHash, start: span.startOffset, end: span.endOffset })) })),
    documents: documents.filter(({ id }) => readDocumentIds.has(id)).map((document) => ({ id: document.id, version: document.version, contentHash: document.contentHash, receivedAt: document.receivedAt.toISOString(), verificationState: document.verificationState })),
    runIds: packetRuns.map(({ id }) => id), policy: null,
    periods: { reviewPeriodId: period.id, reviewPeriodVersion: period.version, requestedStart: period.requestedStart, requestedEnd: period.requestedEnd, authorizations: authorizationRows.map((authorization) => ({ ...authorization, lastVerifiedAt: authorization.lastVerifiedAt?.toISOString() ?? null })) },
    validation: { generatedAt: new Date().toISOString(), checks, blockerCodes: evaluateGate({ ...snapshot, hash: { recomputed: "", stored: "", requested: null } }).map(({ code }) => code) },
  };
  const hash = computeApprovalHash(source);
  snapshot.hash.recomputed = hash;
  const blockers = evaluateGate(snapshot);
  return { packet, report: { checks, blockerCodes: blockers.map(({ code }) => code) }, blockers, hash, hashInput: buildHashInput(source), snapshot };
}

export async function refreshPacketHash(tx: Db, caseId: string, packetId: string): Promise<LoadedValidation> {
  const [history] = await tx.select({ id: s.approvals.id }).from(s.approvals).where(and(eq(s.approvals.caseId, caseId), eq(s.approvals.packetVersionId, packetId))).limit(1);
  const validation = await loadValidation(tx, caseId, packetId);
  if (history || validation.hash === null || validation.hashInput === null) return validation;
  const report = { ...validation.report, blockerCodes: validation.report.blockerCodes.filter((code) => code !== "hash_mismatch") };
  await tx.update(s.packetVersions).set({ contentHash: validation.hash, hashInput: validation.hashInput, validationReport: report }).where(and(eq(s.packetVersions.caseId, caseId), eq(s.packetVersions.id, packetId)));
  return loadValidation(tx, caseId, packetId);
}
