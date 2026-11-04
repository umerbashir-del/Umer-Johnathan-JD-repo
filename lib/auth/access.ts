import "server-only";

export const ACTIONS = [
  "list_cases", "read_case", "read_audit", "upload_document", "verify_document",
  "start_run", "edit_claim", "resolve_issue", "approve",
] as const;
export type Action = (typeof ACTIONS)[number];
export type Role = "clinician" | "coordinator" | "supervisor";
export type SessionUser = { userId: string; role: string };
export type AccessDecision = { allowed: true } | { allowed: false; status: 401 | 403 | 404 };

export const ACCESS_RULES: Readonly<Record<Action, { roles: readonly Role[]; caseScoped: boolean }>> = {
  list_cases: { roles: ["clinician"], caseScoped: false },
  read_case: { roles: ["clinician"], caseScoped: true },
  read_audit: { roles: ["clinician"], caseScoped: true },
  upload_document: { roles: ["clinician"], caseScoped: true },
  verify_document: { roles: ["clinician"], caseScoped: true },
  start_run: { roles: ["clinician"], caseScoped: true },
  edit_claim: { roles: ["clinician"], caseScoped: true },
  resolve_issue: { roles: ["clinician"], caseScoped: true },
  approve: { roles: ["clinician"], caseScoped: true },
};

export function checkRole(session: SessionUser | null, action: string): AccessDecision {
  if (session === null || session.userId.trim() === "") return { allowed: false, status: 401 };
  if (!Object.hasOwn(ACCESS_RULES, action)) return { allowed: false, status: 403 };
  const rule = ACCESS_RULES[action as Action];
  if (!rule.roles.some((role) => role === session.role)) return { allowed: false, status: 403 };
  return { allowed: true };
}

export function checkCaseAccess(
  session: SessionUser | null,
  action: string,
  caseRecord: { assignedTo: string | null } | null,
): AccessDecision {
  const roleDecision = checkRole(session, action);
  if (!roleDecision.allowed) return roleDecision;
  if (!ACCESS_RULES[action as Action].caseScoped) return { allowed: true };
  if (caseRecord === null || caseRecord.assignedTo === null || caseRecord.assignedTo !== session?.userId) {
    return { allowed: false, status: 404 };
  }
  return { allowed: true };
}

export function listScopeFor(session: SessionUser): { assignedTo: string } {
  if (!checkRole(session, "list_cases").allowed) throw new Error("access_denied");
  return { assignedTo: session.userId };
}
