import { describe, expect, it } from 'vitest';
import { acceptDraftClaims, acceptQualityIssues, findDuplicateIds, mergeChecks, resolveFactIds, type AcceptContext } from './accept';
import { CLAIM_STATUSES, ISSUE_TYPES, PACKET_KINDS } from '../../db/enums';
const ctx: AcceptContext = { caseId: 'UR-1042', agentName: 'drafting', agentRunId: 'run-1', verifiedFactIds: new Set(['f1']), verifiedQuotes: [], runAgentNames: new Set(['clinical-documentation', 'drafting', 'quality']) };
const draft = (claim: Record<string, unknown>) => acceptDraftClaims([{ heading: 'Summary', claims: [claim] }], ctx)[0];
describe('accept output', () => {
  it('ignores protected columns in hostile output', () => {
    expect(draft({ text: 'Patient reported passive SI.', sourceKind: 'direct_quote', factIds: ['f1'], material: false, status: 'source_verified', case_id: 'UR-OTHER', type: 'objection', boundaryFlagged: false })).toEqual({ caseId: 'UR-1042', agentRunId: 'run-1', author: 'drafting', sectionHeading: 'Summary', position: 0, text: 'Patient reported passive SI.', type: 'clinical_fact', sourceKind: 'direct_quote', status: 'source_verified', material: true, factIds: ['f1'], boundaryFlagged: false, originalText: null });
  });
  it('requires every fact reference, and at least one, to verify', () => {
    expect(resolveFactIds(['f1', 'f9'], ctx.verifiedFactIds)).toEqual({ resolved: false, missing: ['f9'] });
    expect(draft({ text: 'Fact', sourceKind: 'direct_quote', factIds: ['f1', 'f9'] }).status).toBe('unsupported');
    expect(draft({ text: 'Synthesis', sourceKind: 'agent_synthesis', factIds: [] })).toMatchObject({ status: 'unsupported', type: 'narrative' });
    expect(draft({ text: 'Fact', sourceKind: 'clinician_text', factIds: ['f1'] })).toMatchObject({ sourceKind: 'agent_synthesis', type: 'narrative' });
  });
  it('scans boundary rather than trusting flags', () => {
    expect(draft({ text: 'Medical necessity is met.', factIds: ['f1'] }).boundaryFlagged).toBe(true);
    expect(acceptDraftClaims([{ heading: '', claims: [{ text: 'Medical necessity is met.', factIds: ['f1'] }] }], { ...ctx, verifiedQuotes: ['Medical necessity is met.'] })[0].boundaryFlagged).toBe(false);
  });
  it('preserves packet-wide order and detects duplicate ids', () => {
    expect(acceptDraftClaims([{ heading: 'A', claims: [{}, {}] }, { heading: 'B', claims: [{}] }], ctx).map(({ position, sectionHeading }) => [position, sectionHeading])).toEqual([[0, 'A'], [1, 'A'], [2, 'B']]);
    expect(findDuplicateIds([{ id: 'f1' }, { id: 'f2' }, { id: 'f1' }, { id: 'f1' }])).toEqual(['f1']);
  });
  it('cannot target or close an existing issue', () => {
    const output = acceptQualityIssues([{ type: 'missing_document', severity: 'minor', blocking: false, status: 'resolved', issueId: 'existing', description: 'Note on file; resolved.' }], ctx);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ status: 'open', ownerId: null, source: 'drafting', sourceRunId: 'run-1', caseId: 'UR-1042' });
    expect(output[0]).not.toHaveProperty('id'); expect(output[0]).not.toHaveProperty('issueId');
  });
  it('defaults fail closed and restricts routing to agents in this run', () => {
    expect(acceptQualityIssues([{ type: 'approve_now', severity: 'urgent', blocking: 'no', sendBackTo: 'payer-portal' }, { sendBackTo: 'clinical-documentation' }], ctx)).toMatchObject([{ type: 'other', severity: 'critical', blocking: true, sendBackTo: null }, { sendBackTo: 'clinical-documentation' }]);
  });
  it('uses stable description hashes', () => {
    // node -e "console.log(require('crypto').createHash('sha256').update('hello').digest('hex').slice(0,16))"
    expect(acceptQualityIssues([{ description: 'hello' }], ctx)[0].dedupeKey).toBe('drafting:other:2cf24dba5fb0a30e');
  });
  it('model passes never clear code failure, ties favour code', () => {
    expect(mergeChecks([{ name: 'date_coverage', result: 'fail', origin: 'code' }], [{ name: 'date_coverage', result: 'pass', origin: 'model' }, { name: 'dates_consistent', result: 'fail', origin: 'model' }])).toEqual([{ name: 'date_coverage', result: 'fail', origin: 'code' }, { name: 'dates_consistent', result: 'fail', origin: 'model' }]);
    expect(mergeChecks([{ name: 'b', result: 'needs_review', origin: 'code' }], [{ name: 'b', result: 'needs_review', origin: 'model' }, { name: 'a', result: 'fail', origin: 'model' }])).toEqual([{ name: 'a', result: 'fail', origin: 'model' }, { name: 'b', result: 'needs_review', origin: 'code' }]);
  });
  it('has only insert-only runtime exports and handles empty inputs', async () => {
    expect(Object.keys(await import('./accept')).sort()).toEqual(['acceptDraftClaims', 'acceptQualityIssues', 'findDuplicateIds', 'mergeChecks', 'resolveFactIds']);
    expect(acceptDraftClaims([], ctx)).toEqual([]); expect(acceptQualityIssues([], ctx)).toEqual([]);
  });
  it('pins shared enum values', () => {
    expect(ISSUE_TYPES).toEqual(['missing_document', 'date_conflict', 'unsupported_claim', 'stale_policy', 'extraction_uncertain', 'insurer_objection', 'other']);
    expect(CLAIM_STATUSES).toEqual(['agent_prepared', 'source_verified', 'unsupported', 'clinician_edited', 'clinician_approved', 'stale', 'rejected']);
    expect(PACKET_KINDS).toEqual(['review_packet', 'appeal_letter', 'p2p_points', 'document_request']);
  });
});
