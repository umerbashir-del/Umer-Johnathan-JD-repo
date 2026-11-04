import { fixtureId } from "./ids";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentType, SourceDocument } from "../harness/documents";

/**
 * Loads a synthetic case from fixtures/<caseDir>/ into SourceDocuments.
 * Used by scripts and evals; the app loads documents from the database instead.
 * Never loads answer-key.md (that would leak the expected answer into a prompt).
 */
/** The parts of fixtures/<case>/case.json that code reads. */
export interface CaseJson {
  case: { id: string; level_of_care: string; due_at: string; payer: string };
  authorization?: { approved_start: string; approved_end: string; units: number };
  review_period?: { requested_start: string; requested_end: string };
  documents: string[];
  late_arrival?: string[];
}

export interface FixtureCase {
  caseJson: CaseJson;
  documents: SourceDocument[];
}

/** Minimal front matter parser for our fixtures: `key: value` lines between --- fences. */
export function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

export async function loadFixture(caseDir: string, opts: { includeLateArrival?: boolean } = {}): Promise<FixtureCase> {
  const caseJson: CaseJson = JSON.parse(await readFile(path.join(caseDir, "case.json"), "utf8"));
  const files: string[] = [...caseJson.documents, ...(opts.includeLateArrival ? (caseJson.late_arrival ?? []) : [])];
  const documents: SourceDocument[] = [];
  for (const file of files) {
    if (!file.endsWith(".md") || /answer-key|expected-fields|security|\.\./i.test(file)) throw new Error("invalid_fixture_path");
    const { meta, body } = parseFrontMatter(await readFile(path.join(caseDir, file), "utf8"));
    documents.push({
      id: fixtureId(caseJson.case.id, file),
      type: meta.type as DocumentType,
      title: meta.title ?? file,
      author: meta.author,
      serviceDate: meta.service_date,
      version: 1,
      content: body,
    });
  }
  return { caseJson, documents };
}
