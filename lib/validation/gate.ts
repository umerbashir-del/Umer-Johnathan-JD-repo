import { datesInRange } from '../agents/clinical-documentation';
import type { DocumentType } from '../harness/documents';
import type { RunGroupStatus, IssueStatus, DocumentVerificationState, ClaimStatus, CheckResult } from '../db/enums';

export const BLOCKER_CODES = ['open_blocking_issue', 'required_document_missing', 'date_coverage_gap', 'unsupported_material_claim', 'validation_failed', 'run_incomplete', 'stale_output', 'boundary_phrase', 'objections_missing', 'hash_mismatch'] as const;
export type BlockerCode = typeof BLOCKER_CODES[number];
export type Blocker = { code: BlockerCode; message: string; objectType?: string; objectId?: string };
export const BLOCKER_MESSAGES: Readonly<Record<BlockerCode, string>> = {
  run_incomplete: "The latest agent run hasn't completed.",
  open_blocking_issue: 'A blocking issue is still open.',
  required_document_missing: 'A required document is missing or unverified.',
  date_coverage_gap: 'A day of the stay has no verified progress note.',
  unsupported_material_claim: 'A material claim has no verified source.',
  stale_output: 'A claim is based on outdated agent output.',
  boundary_phrase: 'A claim states a clinical determination and needs editing.',
  validation_failed: 'An automated check failed.',
  objections_missing: "The likely objections haven't been listed.",
  hash_mismatch: 'The packet changed since it was reviewed.',
};
export type GateSnapshot = {
  asOfDate: string;
  latestRunGroupStatus: RunGroupStatus | null;
  issues: ReadonlyArray<{ id: string; blocking: boolean; status: IssueStatus }>;
  documents: ReadonlyArray<{ id: string; type: DocumentType; serviceDate: string | null; verificationState: DocumentVerificationState }>;
  authorizationDocumentId: string | null;
  requestDocumentId: string | null;
  stay: { start: string; end: string } | null;
  claims: ReadonlyArray<{ id: string; included: boolean; status: ClaimStatus; material: boolean; boundaryFlagged: boolean }>;
  checks: ReadonlyArray<{ name: string; result: CheckResult }>;
  hash: { recomputed: string; stored: string | null; requested: string | null };
};

export function requiredNoteDates(stay: { start: string; end: string }, asOfDate: string): string[] {
  return datesInRange(stay.start, stay.end < asOfDate ? stay.end : asOfDate);
}

export function evaluateGate(snapshot: GateSnapshot): Blocker[] {
  const blockers: Blocker[] = [];
  function add(code: BlockerCode, objectType: string, objectId?: string): void {
    blockers.push({ code, message: BLOCKER_MESSAGES[code], objectType, ...(objectId === undefined ? {} : { objectId }) });
  }
  if (snapshot.latestRunGroupStatus !== 'complete') add('run_incomplete', 'run_group');
  for (const issue of snapshot.issues) if (issue.blocking && issue.status !== 'resolved') add('open_blocking_issue', 'issue', issue.id);
  for (const [id, role] of [[snapshot.authorizationDocumentId, 'authorization_record'], [snapshot.requestDocumentId, 'request']] as const) {
    if (id === null || !snapshot.documents.some((document) => document.id === id && document.verificationState === 'verified')) add('required_document_missing', 'document_role', role);
  }
  const noteDates = new Set(snapshot.documents.filter((document) => document.type === 'progress_note' && document.verificationState === 'verified').map((document) => document.serviceDate));
  if (snapshot.stay === null) add('date_coverage_gap', 'date');
  else for (const date of requiredNoteDates(snapshot.stay, snapshot.asOfDate)) if (!noteDates.has(date)) add('date_coverage_gap', 'date', date);
  const allowedStatuses: readonly string[] = ['source_verified', 'clinician_edited', 'clinician_approved'];
  for (const claim of snapshot.claims) {
    if (!claim.included || claim.status === 'rejected') continue;
    if (claim.status === 'stale') add('stale_output', 'claim', claim.id);
    else if (claim.material && !allowedStatuses.includes(claim.status)) add('unsupported_material_claim', 'claim', claim.id);
    if (claim.boundaryFlagged) add('boundary_phrase', 'claim', claim.id);
  }
  for (const check of snapshot.checks) if (check.result === 'fail') add('validation_failed', 'check', check.name);
  const { recomputed, stored, requested } = snapshot.hash;
  if (stored === null || recomputed !== stored || (requested !== null && requested !== recomputed)) add('hash_mismatch', 'packet_version');
  return blockers.sort((a, b) => BLOCKER_CODES.indexOf(a.code) - BLOCKER_CODES.indexOf(b.code) || ((a.objectId ?? '') < (b.objectId ?? '') ? -1 : (a.objectId ?? '') > (b.objectId ?? '') ? 1 : 0));
}
