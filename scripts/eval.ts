import "./load-env";
import { strict as assert } from "node:assert";
import path from "node:path";
import { clinicalDocumentationAgent, computeDateCoverage, type ClinicalDocumentationInput, type ClinicalDocumentationOutput } from "../lib/agents/clinical-documentation";
import { loadFixture } from "../lib/fixtures/load-fixture";
import { fixtureId } from "../lib/fixtures/ids";
import { parseEnv } from "../lib/env";
import { runAgent, type ClaudeClient } from "../lib/harness/run-agent";
import type { SpendLedger } from "../lib/harness/spend";
import { evaluateGate, type GateSnapshot } from "../lib/validation/gate";
import { scanAgentOutput } from "../lib/orchestrator/accept/boundary";

/** Deterministic controls only: hand-authored fake responses measure no model quality. */
export async function runEvaluation(fixtureDirectory = path.join(process.cwd(), "fixtures/ur-1042")) {
  const env = parseEnv({ APP_DEPLOYMENT: "local" });
  let fakeClientCalls = 0;
  let holds = 0;
  const ledger: SpendLedger = {
    async reserve() { return { status: "held", reservationId: `synthetic-eval-${++holds}` }; },
    async settle() { /* Fake settlement; no database or real money. */ },
  };
  function clientFor(output: ClinicalDocumentationOutput): ClaudeClient {
    return { messages: { async parse() {
      fakeClientCalls++;
      return { parsed_output: output, usage: { input_tokens: 1000, output_tokens: 500 }, stop_reason: "end_turn" };
    } } };
  }
  const initial = await loadFixture(fixtureDirectory);
  const complete = await loadFixture(fixtureDirectory, { includeLateArrival: true });
  const caseId = initial.caseJson.case.id;
  assert.equal(caseId, "UR-1042");
  const stay = { start: "2026-11-01", end: "2026-11-03" };
  const input: ClinicalDocumentationInput = { caseId, levelOfCare: initial.caseJson.case.level_of_care,
    reviewPeriod: stay, asOf: "2026-11-03", documents: initial.documents };
  const coverageBefore = computeDateCoverage(input);
  const coverageAfter = computeDateCoverage({ ...input, documents: complete.documents });
  assert.deepEqual(coverageBefore.filter((day) => !day.hasNote).map((day) => day.date), ["2026-11-02"]);
  assert.ok(coverageAfter.every((day) => day.hasNote));
  const quote = "Patient reports passive suicidal ideation without plan or intent.";
  const output: ClinicalDocumentationOutput = {
    facts: [{ id: "f1", category: "risk", statement: quote, serviceDate: "2026-11-03",
      quotes: [{ documentId: fixtureId(caseId, "note-2026-11-03.md"), text: quote }] }],
    gaps: [{ item: "Progress note for 2026-11-02", why: "Not present in the supplied documents.", severity: "high" }],
  };
  const sourceResult = await runAgent(clinicalDocumentationAgent, input, {
    env, client: clientFor(output), replay: "off", spend: { ledger, environment: "eval", agentRunRef: null },
  });
  assert.equal(sourceResult.status, "ok");
  assert.equal(sourceResult.quoteChecks[0].status, "verified");
  const unsupportedOutput: ClinicalDocumentationOutput = { ...output, facts: [{ ...output.facts[0],
    quotes: [{ documentId: fixtureId(caseId, "note-2026-11-03.md"), text: "An invented statement absent from this synthetic record." }] }] };
  const unsupportedResult = await runAgent(clinicalDocumentationAgent, input, {
    env, client: clientFor(unsupportedOutput), replay: "off", spend: { ledger, environment: "eval", agentRunRef: null },
  });
  assert.equal(unsupportedResult.status, "needs_review");
  assert.equal(unsupportedResult.quoteChecks[0].status, "unsupported");

  const snapshot: GateSnapshot = {
    asOfDate: input.asOf, latestRunGroupStatus: "complete",
    issues: [{ id: "missing-note", blocking: true, status: "open" }, { id: "date-conflict", blocking: true, status: "open" }],
    documents: initial.documents.map((document) => ({ id: document.id, type: document.type, serviceDate: document.serviceDate ?? null, verificationState: "verified" })),
    authorizationDocumentId: fixtureId(caseId, "auth-record.md"), requestDocumentId: fixtureId(caseId, "request.md"), stay,
    claims: [{ id: "synthetic-claim", included: true, status: "source_verified", material: true, boundaryFlagged: false }],
    checks: [], hash: { recomputed: "synthetic-eval-hash", stored: "synthetic-eval-hash", requested: null },
  };
  const initialBlockers = evaluateGate(snapshot);
  assert.ok(initialBlockers.some((blocker) => blocker.code === "date_coverage_gap" && blocker.objectId === "2026-11-02"));
  const lateId = fixtureId(caseId, "late-arrival/note-2026-11-02.md");
  const withUnverifiedNote: GateSnapshot = { ...snapshot, documents: complete.documents.map((document) => ({
    id: document.id, type: document.type, serviceDate: document.serviceDate ?? null,
    verificationState: document.id === lateId ? "unverified" : "verified",
  })) };
  assert.ok(evaluateGate(withUnverifiedNote).some((blocker) => blocker.code === "date_coverage_gap"));
  // Simulate explicit clinician verification and issue resolution in the snapshot, not the database.
  const resolved: GateSnapshot = { ...withUnverifiedNote,
    documents: withUnverifiedNote.documents.map((document) => ({ ...document, verificationState: "verified" })),
    issues: snapshot.issues.map((issue) => ({ ...issue, status: "resolved" })),
  };
  assert.deepEqual(evaluateGate(resolved), []);
  const unsupportedBlocked = evaluateGate({ ...resolved, claims: [{ ...resolved.claims[0], status: "unsupported" }] })
    .some((blocker) => blocker.code === "unsupported_material_claim");
  const boundaryFlagged = scanAgentOutput({ statement: "meets medical necessity" }, []).flagged;
  const boundaryBlocked = evaluateGate({ ...resolved, claims: [{ ...resolved.claims[0], boundaryFlagged }] })
    .some((blocker) => blocker.code === "boundary_phrase");
  const staleHashBlocked = evaluateGate({ ...resolved, hash: { ...resolved.hash, requested: "different" } })
    .some((blocker) => blocker.code === "hash_mismatch");
  assert.ok(unsupportedBlocked && boundaryBlocked && staleHashBlocked);
  return {
    mode: "deterministic_fixture_eval_with_fake_client",
    measuresLiveModelQuality: false,
    caseId,
    liveApiCalls: 0,
    realCostUsd: 0,
    fakeClientCalls,
    sourceChecks: { supportedQuotesVerified: 1, unsupportedQuotesDetected: 1 },
    coverage: { requiredDays: 3, documentedInitially: coverageBefore.filter((day) => day.hasNote).length,
      documentedWithLateNote: coverageAfter.filter((day) => day.hasNote).length, missingDateDetected: "2026-11-02" },
    gate: { initialBlockers: initialBlockers.map((blocker) => blocker.code), unverifiedLateNoteBlocked: true,
      simulatedClinicianResolutionClearsGate: true, unsupportedClaimBlocked: unsupportedBlocked,
      clinicalBoundaryBlocked: boundaryBlocked, staleHashBlocked },
  };
}

if (process.argv[1]?.endsWith("eval.ts")) {
  runEvaluation().then((metrics) => console.log(JSON.stringify(metrics, null, 2)))
    .catch(() => { console.error("Deterministic fixture evaluation failed."); process.exitCode = 1; });
}
