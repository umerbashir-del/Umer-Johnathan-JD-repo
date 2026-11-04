import { createHash } from 'node:crypto';
import type { PacketKind, ClaimType, ClaimSourceKind, ClaimStatus, DocumentVerificationState, CheckResult } from '../db/enums';
import type { BlockerCode } from './gate';

export type CanonicalValue = string | number | boolean | null | CanonicalValue[] | { [key: string]: CanonicalValue };
export type HashSource = {
  packet: { id: string; version: number; kind: PacketKind; headings: readonly string[]; createdAt: string };
  claims: ReadonlyArray<{
    id: string; position: number; included: boolean; text: string; type: ClaimType; sourceKind: ClaimSourceKind; status: ClaimStatus; material: boolean;
    boundaryFlagged: boolean; originalText: string | null; agentRunId: string | null; createdAt: string | null;
    evidence: ReadonlyArray<{ spanId: string; documentId: string; documentVersion: number; contentHash: string; start: number; end: number }>;
  }>;
  documents: ReadonlyArray<{ id: string; version: number; contentHash: string; receivedAt: string; verificationState: DocumentVerificationState }>;
  runIds: readonly string[];
  policy: { policyId: string; policyVersion: string; effectiveFrom: string; effectiveTo: string | null } | null;
  periods: {
    reviewPeriodId: string; reviewPeriodVersion: number; requestedStart: string; requestedEnd: string;
    authorizations: ReadonlyArray<{ id: string; authNumber: string; approvedStart: string; approvedEnd: string; units: number | null; lastVerifiedAt: string | null }>;
  };
  validation: { generatedAt: string; checks: ReadonlyArray<{ name: string; result: CheckResult; detail: string; affected: readonly string[] }>; blockerCodes: readonly BlockerCode[] };
};

export function canonicalJson(value: CanonicalValue): string {
  const active = new Set<object>();
  function serialize(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || active.has(item)) throw new Error('non-canonical value');
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const values: string[] = [];
        for (let index = 0; index < item.length; index++) values.push(serialize(item[index]));
        return `[${values.join(',')}]`;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('non-canonical value');
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${serialize((item as Record<string, unknown>)[key])}`).join(',')}}`;
    } finally { active.delete(item); }
  }
  return serialize(value);
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export function buildHashInput(source: HashSource): CanonicalValue {
  const documents = new Map<string, { id: string; version: number; contentHash: string }>();
  for (const document of source.documents) {
    const key = JSON.stringify([document.id, document.version]);
    const previous = documents.get(key);
    if (previous && previous.contentHash !== document.contentHash) throw new Error('conflicting document versions');
    documents.set(key, { id: document.id, version: document.version, contentHash: document.contentHash });
  }
  return {
    packet: { kind: source.packet.kind, headings: [...source.packet.headings] },
    claims: source.claims.filter((claim) => claim.included).toSorted((a, b) => a.position - b.position).map((claim) => ({
      text: claim.text, type: claim.type, sourceKind: claim.sourceKind, status: claim.status, material: claim.material,
      evidence: claim.evidence.toSorted((a, b) => compareText(a.documentId, b.documentId) || a.documentVersion - b.documentVersion || a.start - b.start || a.end - b.end).map((evidence) => ({ documentId: evidence.documentId, documentVersion: evidence.documentVersion, contentHash: evidence.contentHash, start: evidence.start, end: evidence.end })),
    })),
    documents: [...documents.values()].sort((a, b) => compareText(a.id, b.id) || a.version - b.version),
    policy: source.policy === null ? null : { ...source.policy },
    periods: { requestedStart: source.periods.requestedStart, requestedEnd: source.periods.requestedEnd,
      authorizations: source.periods.authorizations.toSorted((a, b) => compareText(a.authNumber, b.authNumber)).map((authorization) => ({ authNumber: authorization.authNumber, approvedStart: authorization.approvedStart, approvedEnd: authorization.approvedEnd, units: authorization.units })) },
    validation: { checks: source.validation.checks.toSorted((a, b) => compareText(a.name, b.name)).map((check) => ({ name: check.name, result: check.result })), blockerCodes: [...new Set(source.validation.blockerCodes.filter((code) => code !== 'hash_mismatch'))].sort() },
  };
}

export function computeApprovalHash(source: HashSource): string {
  return createHash('sha256').update(canonicalJson(buildHashInput(source))).digest('hex');
}
