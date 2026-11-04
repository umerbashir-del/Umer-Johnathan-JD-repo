import { createHash } from 'node:crypto';
import { ISSUE_TYPES, ISSUE_SEVERITIES, type IssueType, type IssueSeverity, type CheckResult } from '../../db/enums';
import { scanText } from './boundary';

export type AcceptContext = { caseId: string; agentName: string; agentRunId: string; verifiedFactIds: ReadonlySet<string>; verifiedQuotes: readonly string[]; runAgentNames: ReadonlySet<string> };
export type ClaimDraft = { caseId: string; agentRunId: string; author: string; sectionHeading: string; position: number; text: string; type: 'clinical_fact' | 'narrative'; sourceKind: 'direct_quote' | 'extracted_fact' | 'agent_synthesis'; status: 'source_verified' | 'unsupported'; material: true; factIds: string[]; boundaryFlagged: boolean; originalText: null };
export type IssueDraft = { caseId: string; type: IssueType; severity: IssueSeverity; blocking: boolean; status: 'open'; source: string; sourceRunId: string; description: string; ownerId: null; dedupeKey: string; sendBackTo: string | null };
export type Check = { name: string; result: CheckResult; origin: 'code' | 'model' };

export function findDuplicateIds(items: ReadonlyArray<{ id: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of items) { if (seen.has(id)) duplicates.add(id); seen.add(id); }
  return [...duplicates].sort();
}

export function resolveFactIds(factIds: readonly string[], verifiedFactIds: ReadonlySet<string>): { resolved: boolean; missing: string[] } {
  const missing = [...new Set(factIds.filter((id) => !verifiedFactIds.has(id)))];
  return { resolved: factIds.length > 0 && missing.length === 0, missing };
}

export function acceptDraftClaims(sections: ReadonlyArray<{ heading: string; claims: ReadonlyArray<Record<string, unknown>> }>, ctx: AcceptContext): ClaimDraft[] {
  const drafts: ClaimDraft[] = [];
  for (const section of sections) {
    for (const claim of section.claims) {
      const text = typeof claim.text === 'string' ? claim.text : '';
      const factIds = Array.isArray(claim.factIds) ? claim.factIds.filter((id): id is string => typeof id === 'string') : [];
      const sourceKind = claim.sourceKind === 'direct_quote' || claim.sourceKind === 'extracted_fact' ? claim.sourceKind : 'agent_synthesis';
      drafts.push({ caseId: ctx.caseId, agentRunId: ctx.agentRunId, author: ctx.agentName, sectionHeading: section.heading, position: drafts.length,
        text, type: sourceKind === 'agent_synthesis' ? 'narrative' : 'clinical_fact', sourceKind,
        status: resolveFactIds(factIds, ctx.verifiedFactIds).resolved ? 'source_verified' : 'unsupported', material: true,
        factIds: [...factIds], boundaryFlagged: scanText(text, ctx.verifiedQuotes).length > 0, originalText: null });
    }
  }
  return drafts;
}

export function acceptQualityIssues(issues: ReadonlyArray<Record<string, unknown>>, ctx: AcceptContext): IssueDraft[] {
  return issues.map((issue) => {
    const type = ISSUE_TYPES.find((value) => value === issue.type) ?? 'other';
    const severity = ISSUE_SEVERITIES.find((value) => value === issue.severity) ?? 'critical';
    const description = typeof issue.description === 'string' ? issue.description : '';
    const sendBackTo = typeof issue.sendBackTo === 'string' && ctx.runAgentNames.has(issue.sendBackTo) ? issue.sendBackTo : null;
    return { caseId: ctx.caseId, type, severity, blocking: issue.blocking !== false, status: 'open', source: ctx.agentName,
      sourceRunId: ctx.agentRunId, description, ownerId: null,
      dedupeKey: `${ctx.agentName}:${type}:${createHash('sha256').update(description).digest('hex').slice(0, 16)}`, sendBackTo };
  });
}

export function mergeChecks(codeChecks: readonly Check[], modelChecks: readonly Check[]): Check[] {
  const rank = { pass: 0, needs_review: 1, fail: 2 };
  const merged = new Map<string, Check>();
  for (const check of [...codeChecks.map((entry) => ({ ...entry, origin: 'code' as const })), ...modelChecks.map((entry) => ({ ...entry, origin: 'model' as const }))]) {
    const previous = merged.get(check.name);
    if (!previous || rank[check.result] > rank[previous.result] || (rank[check.result] === rank[previous.result] && check.origin === 'code')) merged.set(check.name, { ...check });
  }
  return [...merged.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
