import { describe, expect, it } from "vitest";
import { ACTIONS, ACCESS_RULES, checkCaseAccess, checkRole, listScopeFor } from "./access";

const actions = ["list_cases", "read_case", "read_audit", "upload_document", "verify_document", "start_run", "edit_claim", "resolve_issue", "approve"];
const clinician = { userId: "u-a", role: "clinician" };

describe("default-deny access map", () => {
  it("pins all MVP actions and their allowed role", () => {
    expect([...ACTIONS]).toEqual(actions);
    expect(Object.keys(ACCESS_RULES).sort()).toEqual([...actions].sort());
    for (const rule of Object.values(ACCESS_RULES)) expect(rule.roles).toEqual(["clinician"]);
  });

  it.each(actions)("checks every role for %s", (action) => {
    for (const role of ["clinician", "coordinator", "supervisor", "admin", "Clinician", ""]) {
      const expected = role === "clinician" ? { allowed: true } : { allowed: false, status: 403 };
      expect(checkRole({ userId: "u-a", role }, action)).toEqual(expected);
      expect(checkCaseAccess({ userId: "u-a", role }, action, { assignedTo: "u-a" })).toEqual(expected);
    }
  });

  it.each(actions)("treats absent and unusable sessions as signed out for %s", (action) => {
    for (const session of [null, { userId: "", role: "clinician" }, { userId: "  ", role: "clinician" }]) {
      expect(checkRole(session, action)).toEqual({ allowed: false, status: 401 });
      expect(checkCaseAccess(session, action, { assignedTo: "" })).toEqual({ allowed: false, status: 401 });
    }
  });

  it.each(["delete_case", "constructor", "__proto__", ""])("denies unknown action %s", (action) => {
    expect(checkRole(clinician, action)).toEqual({ allowed: false, status: 403 });
    expect(checkCaseAccess(clinician, action, { assignedTo: "u-a" })).toEqual({ allowed: false, status: 403 });
  });

  it.each(actions.filter((action) => action !== "list_cases"))("hides foreign and missing cases identically for %s", (action) => {
    for (const record of [null, { assignedTo: null }, { assignedTo: "u-b" }]) {
      expect(checkCaseAccess(clinician, action, record)).toEqual({ allowed: false, status: 404 });
    }
    expect(checkCaseAccess(clinician, action, { assignedTo: "u-a" })).toEqual({ allowed: true });
    expect(checkCaseAccess({ userId: "u-a", role: "coordinator" }, action, { assignedTo: "u-a" })).toEqual({ allowed: false, status: 403 });
  });

  it("filters the list by assignment without requiring a case lookup", () => {
    expect(checkCaseAccess(clinician, "list_cases", null)).toEqual({ allowed: true });
    expect(listScopeFor(clinician)).toEqual({ assignedTo: "u-a" });
    expect(() => listScopeFor({ userId: "u-a", role: "coordinator" })).toThrow("access_denied");
  });
});
