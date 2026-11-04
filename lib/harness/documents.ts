import "server-only";
import { wrapUntrusted } from "./untrusted";
/**
 * Source documents as the agents see them.
 *
 * PATTERN: agents never receive raw strings glued together. Every document is
 * wrapped in a <document> tag carrying its id and metadata, so the model can cite
 * `documentId` and the harness can verify quotes against the exact same text.
 */

export type DocumentType =
  | "intake"
  | "treatment_plan"
  | "progress_note"
  | "authorization_record"
  | "denial_letter"
  | "approval_letter"
  | "request_for_info_letter"
  | "appeal_decision_letter"
  | "policy"
  | "criteria_summary";

export interface SourceDocument {
  id: string; // stable id; quotes cite this
  type: DocumentType;
  title: string;
  author?: string;
  serviceDate?: string; // ISO date, e.g. "2026-11-03"
  version: number;
  content: string; // the exact text quotes are verified against
}

/** Wrap every document through the shared untrusted-text boundary. */
export function formatDocuments(docs: SourceDocument[]): string {
  return docs.map((d) => wrapUntrusted("document", [
    ["id", d.id], ["type", d.type], ["title", d.title],
    ["service_date", d.serviceDate], ["version", d.version],
  ], d.content)).join("\n\n");
}
