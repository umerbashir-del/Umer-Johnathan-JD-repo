/**
 * ============================================================================
 * REFERENCE AGENT. Copy this file's shape for every other agent.
 * ============================================================================
 *
 * Clinical Documentation agent: reads intake, treatment plan and progress
 * notes, and returns quoted clinical facts plus documentation gaps.
 *
 * The pattern, in order (keep this order in every agent file):
 *   1. Input type        - what the orchestrator passes in. Always includes `documents`.
 *   2. Output schema     - Zod, every field .describe()d. This IS the contract.
 *   3. Deterministic prep - anything code can compute, code computes (dates, counts, lookups).
 *                          The model gets the result as context; it never recomputes it.
 *   4. System prompt     - SHARED_RULES + this agent's job. Static text only, so it caches.
 *   5. buildPrompt       - case data goes here, documents wrapped by formatDocuments().
 *   6. extractQuotes     - every quote in the output, so the harness can verify them.
 *   7. The AgentDef export.
 *
 * What an agent file must NOT do: import the Anthropic SDK, call fetch, read
 * the database, read env vars, catch API errors or log. The harness
 * (lib/harness/run-agent.ts) does all of that. Agents get no tools.
 *
 * Run it: `npx tsx scripts/run-clinical-documentation.ts` (see docs/architecture/reference-agent.md).
 */
import { z } from "zod";
import { formatDocuments, type SourceDocument } from "../harness/documents";
import { wrapUntrusted } from "../harness/untrusted";
import { Gap, Quote, SHARED_RULES } from "./shared";
import type { AgentDef } from "./types";

// ---------------------------------------------------------------------------
// 1. Input
// ---------------------------------------------------------------------------
export interface ClinicalDocumentationInput {
  caseId: string;
  levelOfCare: string; // e.g. "inpatient psychiatric"
  /** Days that should be documented so far (for UR-1042: the authorized stay, Nov 1-3). */
  reviewPeriod: { start: string; end: string }; // ISO dates, inclusive
  /** "Today" for this run. Passed in, never read from the clock, so prompts stay reproducible (replay, evals). */
  asOf: string;
  documents: SourceDocument[];
}

// ---------------------------------------------------------------------------
// 2. Output schema
// ---------------------------------------------------------------------------
export const FACT_CATEGORIES = [
  "risk",
  "symptoms",
  "withdrawal",
  "medical",
  "functioning",
  "engagement",
  "prior_treatment",
  "environment",
  "discharge_plan",
] as const;

export const Fact = z.object({
  id: z.string().describe("Short id, f1, f2, ... unique within this output"),
  category: z.enum(FACT_CATEGORIES),
  statement: z
    .string()
    .describe("One neutral sentence stating what the record says. No judgment about necessity."),
  serviceDate: z
    .string()
    .nullable()
    .describe("ISO date the fact applies to, copied from the document's service_date, or null"),
  quotes: z.array(Quote).min(1).describe("One to three exact quotes that support the statement"),
});
export type Fact = z.infer<typeof Fact>;

export const ClinicalDocumentationOutput = z.object({
  facts: z.array(Fact).describe("Clinically relevant facts, most important first, at most 25"),
  gaps: z.array(Gap).describe("Missing or unclear documentation a reviewer would ask about"),
});
export type ClinicalDocumentationOutput = z.infer<typeof ClinicalDocumentationOutput>;

// ---------------------------------------------------------------------------
// 3. Deterministic prep: code finds missing note dates; the model does not count days.
// ---------------------------------------------------------------------------
export function datesInRange(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Which days in the period have at least one progress note. Shown in the UI as-is. */
export function computeDateCoverage(input: ClinicalDocumentationInput) {
  const noteDates = new Set(
    input.documents.filter((d) => d.type === "progress_note" && d.serviceDate).map((d) => d.serviceDate),
  );
  return datesInRange(input.reviewPeriod.start, input.reviewPeriod.end)
    .filter((date) => date <= input.asOf) // future days are not "missing"
    .map((date) => ({ date, hasNote: noteDates.has(date) }));
}

// ---------------------------------------------------------------------------
// 4. System prompt: static, no case data. Bump `version` whenever it changes.
// ---------------------------------------------------------------------------
const SYSTEM = `${SHARED_RULES}

Your job: Clinical Documentation agent.
Read the case documents and extract the facts a utilization reviewer would look for to understand this patient's current clinical picture, then list documentation gaps.

What counts as a fact, by category:
- risk: suicidal or homicidal ideation, plans, intent, self-harm, safety events, observation level
- symptoms: current psychiatric symptoms and their severity or trend
- withdrawal: withdrawal signs, scores (e.g. CIWA, COWS), detox needs
- medical: medical conditions or medication issues affecting care
- functioning: ability to perform daily activities, self-care, judgment
- engagement: participation in treatment, adherence, refusals
- prior_treatment: previous admissions, lower levels of care tried and their outcome
- environment: housing, supports, stressors, safety of the home
- discharge_plan: discharge criteria, step-down plan, aftercare, barriers

How to work:
- Prefer the most recent documentation. If documents disagree, extract both facts and add a gap describing the conflict.
- Keep each statement neutral and specific ("Patient reported passive suicidal ideation without plan on 2026-11-03"), not evaluative ("Patient is high risk").
- The user message includes a date coverage table computed by code. Treat it as correct. For each day with hasNote=false, add a gap with severity "high".
- Also add gaps for: missing risk assessment in the latest note, no documented discharge plan, missing or unsigned treatment plan, vague notes that do not describe current status.
- If there is nothing to report in a category, report nothing; do not pad.`;

// ---------------------------------------------------------------------------
// 5. buildPrompt: case data + documents. Keep instructions out of here.
// ---------------------------------------------------------------------------
function buildPrompt(input: ClinicalDocumentationInput): string {
  const coverage = computeDateCoverage(input);
  return [
    wrapUntrusted("db_text", [["kind", "case_context"]], JSON.stringify({ caseId: input.caseId, levelOfCare: input.levelOfCare, reviewPeriod: input.reviewPeriod })),
    "",
    "Progress note coverage (computed by code, authoritative):",
    ...coverage.map((c) => `- ${c.date}: ${c.hasNote ? "note present" : "NO NOTE"}`),
    "",
    formatDocuments(input.documents),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 6 + 7. The definition the harness runs.
// ---------------------------------------------------------------------------
export const clinicalDocumentationAgent: AgentDef<ClinicalDocumentationInput, ClinicalDocumentationOutput> = {
  name: "clinical-documentation",
  version: "1.2.0",
  system: SYSTEM,
  output: ClinicalDocumentationOutput,
  buildPrompt,
  extractQuotes: (out) => out.facts.flatMap((f) => f.quotes),
  maxTokens: 8000,
  timeoutMs: 60_000, // PRD section 8: 60-second timeout per call, one retry
  maxRetries: 1,
};
