import "./load-env";
/**
 * Reference fixture runner. Prints counts and run metadata only.
 * Run with the react-server condition; replay is free. Live calls need the
 * configured shared spend ledger and are bounded by the same harness as the app.
 */
import { clinicalDocumentationAgent } from "../lib/agents/clinical-documentation";
import { loadFixture } from "../lib/fixtures/load-fixture";
import { runAgent } from "../lib/harness/run-agent";
import { getEnv, deploymentOf } from "../lib/env";
import { businessDate, businessNow } from "../lib/clock";
import { getSpendLedger } from "../lib/db/spend-ledger";

async function main() {
  const env = getEnv();
  if (deploymentOf(env) === "preview" && !env.AGENT_REPLAY) throw new Error("live_preview_refused");
  const late = process.argv.includes("--late");
  const { caseJson, documents } = await loadFixture("fixtures/ur-1042", { includeLateArrival: late });
  const clinical = documents.filter((document) => ["intake", "treatment_plan", "progress_note"].includes(document.type));
  if (!caseJson.authorization) throw new Error("fixture_authorization_missing");
  const result = await runAgent(clinicalDocumentationAgent, {
    caseId: caseJson.case.id,
    levelOfCare: caseJson.case.level_of_care,
    reviewPeriod: { start: caseJson.authorization.approved_start, end: caseJson.authorization.approved_end },
    asOf: businessDate(businessNow(env)),
    documents: clinical,
  }, {
    env,
    spend: { ledger: getSpendLedger(), environment: deploymentOf(env), agentRunRef: null },
    recordRun: (record) => console.log(JSON.stringify({
      agent: record.agent, version: record.version, model: record.model, status: record.status,
      attempts: record.attempts, costUsd: record.costUsd, replayed: record.replayed,
      errorKind: record.errorKind, recordingError: record.recordingError, spendUnsettled: record.spendUnsettled,
    })),
  });
  console.log(JSON.stringify({ verifiedQuotes: result.quoteChecks.filter((check) => check.status === "verified").length,
    unsupportedQuotes: result.quoteChecks.filter((check) => check.status === "unsupported").length }));
  if (result.status === "failed") process.exitCode = 1;
}
main().catch(() => { console.error("Reference agent run failed."); process.exitCode = 1; });
