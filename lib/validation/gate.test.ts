import { describe, expect, it } from 'vitest';
import { BLOCKER_MESSAGES, evaluateGate, requiredNoteDates, type GateSnapshot } from './gate';
import type { ClaimStatus, IssueStatus, RunGroupStatus } from '../db/enums';
const ready: GateSnapshot = {
  asOfDate: '2026-11-03', latestRunGroupStatus: 'complete', issues: [],
  documents: [{ id: 'auth', type: 'authorization_record', serviceDate: null, verificationState: 'verified' }, { id: 'request', type: 'authorization_record', serviceDate: null, verificationState: 'verified' }, ...['01', '02', '03'].map((day) => ({ id: `note-${day}`, type: 'progress_note' as const, serviceDate: `2026-11-${day}`, verificationState: 'verified' as const }))],
  authorizationDocumentId: 'auth', requestDocumentId: 'request', stay: { start: '2026-11-01', end: '2026-11-03' },
  claims: [{ id: 'claim', included: true, material: true, status: 'source_verified', boundaryFlagged: false }], checks: [{ name: 'coverage', result: 'pass' }],
  hash: { stored: 'abc', recomputed: 'abc', requested: 'abc' },
};
const claimGate = (changes: Partial<GateSnapshot['claims'][number]>) => evaluateGate({ ...ready, claims: [{ ...ready.claims[0], ...changes }] });
describe('approval gate', () => {
  it('allows a fully sourced, complete packet', () => expect(evaluateGate(ready)).toEqual([]));
  it('blocks the initial missing note and cannot be cleared by model pass', () => {
    const snapshot: GateSnapshot = { ...ready, documents: ready.documents.filter((document) => document.id !== 'note-02'), issues: [{ id: 'i-note', blocking: true, status: 'open' }] };
    const expected = [{ code: 'open_blocking_issue', objectType: 'issue', objectId: 'i-note', message: BLOCKER_MESSAGES.open_blocking_issue }, { code: 'date_coverage_gap', objectType: 'date', objectId: '2026-11-02', message: BLOCKER_MESSAGES.date_coverage_gap }];
    expect(evaluateGate(snapshot)).toEqual(expected);
    expect(evaluateGate({ ...snapshot, checks: [{ name: 'documents_complete', result: 'pass' }] })).toEqual(expected);
  });
  it.each(['unverified', 'rejected'] as const)('does not count %s notes', (verificationState) => expect(evaluateGate({ ...ready, documents: ready.documents.map((document) => document.id === 'note-02' ? { ...document, verificationState } : document) }).map((blocker) => [blocker.code, blocker.objectId])).toEqual([['date_coverage_gap', '2026-11-02']]));
  it('requires the correct note date and no future notes', () => {
    expect(evaluateGate({ ...ready, documents: ready.documents.map((document) => document.id === 'note-02' ? { ...document, serviceDate: '2026-11-04' } : document) }).map((blocker) => blocker.objectId)).toEqual(['2026-11-02']);
    expect(requiredNoteDates(ready.stay!, '2026-11-02')).toEqual(['2026-11-01', '2026-11-02']);
    expect(requiredNoteDates(ready.stay!, '2026-10-31')).toEqual([]);
    expect(evaluateGate({ ...ready, stay: null }).map((blocker) => blocker.code)).toEqual(['date_coverage_gap']);
  });
  it.each<RunGroupStatus | null>(['running', 'partial', 'failed', 'budget_exceeded', null])('blocks incomplete run %s', (latestRunGroupStatus) => expect(evaluateGate({ ...ready, latestRunGroupStatus }).map((blocker) => blocker.code)).toEqual(['run_incomplete']));
  it.each<IssueStatus>(['open', 'awaiting_document', 'in_rework', 'escalated'])('keeps %s blocking issues open', (status) => expect(evaluateGate({ ...ready, issues: [{ id: 'i', status, blocking: true }] }).map((blocker) => blocker.code)).toEqual(['open_blocking_issue']));
  it('does not block resolved or nonblocking issues', () => expect(evaluateGate({ ...ready, issues: [{ id: 'a', status: 'resolved', blocking: true }, { id: 'b', status: 'open', blocking: false }] })).toEqual([]));
  it.each(['unsupported', 'agent_prepared', 'weird'])('fails closed on material claim status %s', (status) => expect(claimGate({ status: status as ClaimStatus }).map((blocker) => blocker.code)).toEqual(['unsupported_material_claim']));
  it.each<ClaimStatus>(['source_verified', 'clinician_edited', 'clinician_approved', 'rejected'])('allows claim status %s', (status) => expect(claimGate({ status })).toEqual([]));
  it('handles claim inclusion, materiality, stale and boundary independently', () => {
    expect(claimGate({ status: 'unsupported', material: false })).toEqual([]);
    expect(claimGate({ status: 'unsupported', included: false })).toEqual([]);
    expect(claimGate({ status: 'stale' }).map((blocker) => blocker.code)).toEqual(['stale_output']);
    expect(claimGate({ status: 'clinician_edited', boundaryFlagged: true }).map((blocker) => blocker.code)).toEqual(['boundary_phrase']);
    expect(claimGate({ status: 'rejected', boundaryFlagged: true })).toEqual([]);
  });
  it.each([null, 'absent', 'rejected'])('requires a verified authorization source %s', (id) => {
    expect(evaluateGate({ ...ready, authorizationDocumentId: id, documents: [...ready.documents, { id: 'rejected', type: 'authorization_record', serviceDate: null, verificationState: 'rejected' }] }).map((blocker) => [blocker.code, blocker.objectId])).toEqual([['required_document_missing', 'authorization_record']]);
  });
  it.each([{ stored: null, recomputed: 'abc', requested: null }, { stored: 'old', recomputed: 'abc', requested: null }, { stored: 'abc', recomputed: 'abc', requested: 'old' }])('blocks hash mismatch', (hash) => expect(evaluateGate({ ...ready, hash }).map((blocker) => blocker.code)).toEqual(['hash_mismatch']));
  it('only failed validation checks block, with sorted stable identifiers', () => {
    expect(evaluateGate({ ...ready, checks: [{ name: 'z', result: 'fail' }, { name: 'a', result: 'fail' }, { name: 'review', result: 'needs_review' }] }).map((blocker) => [blocker.code, blocker.objectId])).toEqual([['validation_failed', 'a'], ['validation_failed', 'z']]);
    expect(evaluateGate(ready).some((blocker) => blocker.code === 'objections_missing')).toBe(false);
  });
});
