import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildHashInput, canonicalJson, computeApprovalHash, type CanonicalValue, type HashSource } from './approval-hash';
const base: HashSource = {
  packet: { id: 'p', version: 1, kind: 'review_packet', headings: ['Summary'], createdAt: 'now' },
  claims: [
    { id: 'c1', position: 0, included: true, text: 'First', type: 'clinical_fact', sourceKind: 'extracted_fact', status: 'source_verified', material: true, boundaryFlagged: false, originalText: null, agentRunId: 'r', createdAt: null, evidence: [{ spanId: 's2', documentId: 'b', documentVersion: 1, contentHash: 'hb', start: 2, end: 3 }, { spanId: 's1', documentId: 'a', documentVersion: 1, contentHash: 'ha', start: 0, end: 1 }] },
    { id: 'c2', position: 1, included: true, text: 'Second', type: 'narrative', sourceKind: 'agent_synthesis', status: 'source_verified', material: true, boundaryFlagged: false, originalText: null, agentRunId: 'r', createdAt: null, evidence: [] },
    { id: 'c3', position: 2, included: false, text: 'Excluded', type: 'clinical_fact', sourceKind: 'direct_quote', status: 'rejected', material: true, boundaryFlagged: false, originalText: null, agentRunId: null, createdAt: null, evidence: [] },
  ],
  documents: [{ id: 'b', version: 1, contentHash: 'hb', receivedAt: 'now', verificationState: 'verified' }, { id: 'a', version: 1, contentHash: 'ha', receivedAt: 'now', verificationState: 'verified' }],
  runIds: ['r'], policy: null,
  periods: { reviewPeriodId: 'rp', reviewPeriodVersion: 1, requestedStart: '2026-11-04', requestedEnd: '2026-11-06', authorizations: [{ id: 'au', authNumber: 'AUTH', approvedStart: '2026-11-01', approvedEnd: '2026-11-03', units: 3, lastVerifiedAt: 'now' }] },
  validation: { generatedAt: 'now', checks: [{ name: 'b', result: 'pass', detail: '', affected: [] }, { name: 'a', result: 'pass', detail: '', affected: [] }], blockerCodes: [] },
};
const literal = '{"claims":[{"evidence":[{"contentHash":"ha","documentId":"a","documentVersion":1,"end":1,"start":0},{"contentHash":"hb","documentId":"b","documentVersion":1,"end":3,"start":2}],"material":true,"sourceKind":"extracted_fact","status":"source_verified","text":"First","type":"clinical_fact"},{"evidence":[],"material":true,"sourceKind":"agent_synthesis","status":"source_verified","text":"Second","type":"narrative"}],"documents":[{"contentHash":"ha","id":"a","version":1},{"contentHash":"hb","id":"b","version":1}],"packet":{"headings":["Summary"],"kind":"review_packet"},"periods":{"authorizations":[{"approvedEnd":"2026-11-03","approvedStart":"2026-11-01","authNumber":"AUTH","units":3}],"requestedEnd":"2026-11-06","requestedStart":"2026-11-04"},"policy":null,"validation":{"blockerCodes":[],"checks":[{"name":"a","result":"pass"},{"name":"b","result":"pass"}]}}';
function changed(edit: (source: MutableSource) => void): HashSource { const copy = structuredClone(base) as MutableSource; edit(copy); return copy; }
type Mutable<T> = T extends ReadonlyArray<infer U> ? Mutable<U>[] : T extends object ? { -readonly [P in keyof T]: Mutable<T[P]> } : T;
type MutableSource = Mutable<HashSource>;
describe('canonical approval hash', () => {
  it('matches independent canonical and hash known answers', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: '1', y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":"1"}}');
    expect(canonicalJson(buildHashInput(base))).toBe(literal);
    expect(computeApprovalHash(base)).toBe(createHash('sha256').update(literal).digest('hex'));
  });
  const noChange: [string, (source: MutableSource) => void][] = [
    ['claim metadata', (s) => { s.claims[0].id = 'new'; s.claims[0].agentRunId = 'new'; s.claims[0].createdAt = 'later'; s.claims[0].originalText = 'old'; s.claims[0].evidence[0].spanId = 'new'; }],
    ['packet metadata', (s) => { s.packet.id = 'new'; s.packet.version = 20; s.packet.createdAt = 'later'; }],
    ['document metadata', (s) => { s.documents[0].receivedAt = 'later'; s.documents[0].verificationState = 'rejected'; }],
    ['run and period metadata', (s) => { s.runIds = ['new']; s.periods.reviewPeriodId = 'new'; s.periods.reviewPeriodVersion = 5; s.periods.authorizations[0].id = 'new'; s.periods.authorizations[0].lastVerifiedAt = 'later'; }],
    ['validation metadata', (s) => { s.validation.generatedAt = 'later'; s.validation.checks[0].detail = 'new'; s.validation.checks[0].affected = ['new']; }],
    ['evidence order', (s) => { s.claims[0].evidence.reverse(); }],
    ['documents order and duplicates', (s) => { s.documents.reverse(); s.documents.push({ ...s.documents[0] }); }],
    ['claim array order', (s) => { s.claims.reverse(); }],
    ['circular hash blocker', (s) => { s.validation.blockerCodes.push('hash_mismatch'); }],
    ['excluded claim text', (s) => { s.claims[2].text = 'new'; }],
  ];
  it.each(noChange)('does not falsely invalidate %s', (_, edit) => expect(computeApprovalHash(changed(edit))).toBe(computeApprovalHash(base)));
  const invalidating: [string, (source: MutableSource) => void][] = [
    ['text', (s) => { s.claims[0].text = 'new'; }], ['status', (s) => { s.claims[0].status = 'unsupported'; }],
    ['include', (s) => { s.claims[2].included = true; }], ['exclude', (s) => { s.claims[0].included = false; }],
    ['order', (s) => { s.claims[0].position = 1; s.claims[1].position = 0; }], ['material', (s) => { s.claims[0].material = false; }],
    ['evidence hash', (s) => { s.claims[0].evidence[0].contentHash = 'new'; }], ['evidence version', (s) => { s.claims[0].evidence[0].documentVersion = 2; }], ['evidence offset', (s) => { s.claims[0].evidence[0].start = 1; }],
    ['read document version', (s) => { s.documents[0].version = 2; }],
    ['policy', (s) => { s.policy = { policyId: 'p', policyVersion: '1', effectiveFrom: '2026-01-01', effectiveTo: null }; }],
    ['requested dates', (s) => { s.periods.requestedEnd = '2026-11-07'; }], ['authorized dates', (s) => { s.periods.authorizations[0].approvedEnd = '2026-11-04'; }], ['units', (s) => { s.periods.authorizations[0].units = 4; }],
    ['check result', (s) => { s.validation.checks[0].result = 'fail'; }], ['blocker', (s) => { s.validation.blockerCodes.push('date_coverage_gap'); }],
    ['packet kind', (s) => { s.packet.kind = 'appeal_letter'; }], ['heading', (s) => { s.packet.headings[0] = 'Changed'; }],
  ];
  it.each(invalidating)('invalidates %s', (_, edit) => expect(computeApprovalHash(changed(edit))).not.toBe(computeApprovalHash(base)));
  it.each([undefined, { a: undefined }, [undefined], new Array(1), NaN, Infinity, -Infinity, new Date(), new (class Example {})(), BigInt(1), () => 'x'])('refuses ambiguous canonical values %#', (value) => expect(() => canonicalJson(value as CanonicalValue)).toThrow('non-canonical value'));
  it('refuses conflicting immutable document versions', () => expect(() => computeApprovalHash(changed((s) => { s.documents.push({ ...s.documents[0], contentHash: 'conflicting' }); }))).toThrow('conflicting document versions'));
  it('hashes stored Unicode exactly', () => expect(computeApprovalHash(changed((s) => { s.claims[0].text = '\u00e9'; }))).not.toBe(computeApprovalHash(changed((s) => { s.claims[0].text = 'e\u0301'; }))));
});
