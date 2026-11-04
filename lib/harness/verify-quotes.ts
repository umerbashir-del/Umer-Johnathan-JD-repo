import "server-only";
/**
 * Quote verification: the main guard against invented facts.
 *
 * PATTERN: the model may only state clinical facts it can quote. Code, not the
 * model, decides whether a quote is real: it must appear in the named document
 * (ignoring differences in whitespace and curly vs straight quotes). A verified
 * quote gets character offsets so the UI can highlight it. Anything else is
 * "unsupported" and must be shown as such; never silently dropped or kept.
 */
import type { SourceDocument } from "./documents";

export interface QuoteRef {
  documentId: string;
  text: string;
}

export type QuoteCheck =
  | { status: "verified"; documentId: string; text: string; start: number; end: number; excerpt: string }
  | { status: "unsupported"; documentId: string; text: string; reason: "document_not_found" | "text_not_found" | "empty_quote" };

/** Normalize one character for comparison: curly quotes and dashes to plain ASCII. */
function normChar(ch: string): string {
  if ("‘’‛".includes(ch)) return "'";
  if ("“”‟".includes(ch)) return '"';
  if ("–—".includes(ch)) return "-";
  return ch.toLowerCase();
}

/**
 * Build a normalized copy of `text` (runs of whitespace collapsed to one space)
 * plus a map from each normalized index back to the original index.
 */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!lastWasSpace && norm.length > 0) {
        norm += " ";
        map.push(i);
      }
      lastWasSpace = true;
    } else {
      const normalized = normChar(ch);
      norm += normalized;
      for (let unit = 0; unit < normalized.length; unit++) map.push(i);
      lastWasSpace = false;
    }
  }
  return { norm: norm.trimEnd(), map };
}

export function verifyQuote(quote: QuoteRef, docs: SourceDocument[]): QuoteCheck {
  const doc = docs.find((d) => d.id === quote.documentId);
  if (!doc) return { status: "unsupported", documentId: quote.documentId, text: quote.text, reason: "document_not_found" };

  const needle = normalizeWithMap(quote.text).norm.trim();
  if (!needle) return { status: "unsupported", documentId: quote.documentId, text: quote.text, reason: "empty_quote" };

  const hay = normalizeWithMap(doc.content);
  const at = hay.norm.indexOf(needle);
  if (at === -1) return { status: "unsupported", documentId: quote.documentId, text: quote.text, reason: "text_not_found" };

  const start = hay.map[at];
  const end = hay.map[at + needle.length - 1] + 1;
  return { status: "verified", documentId: doc.id, text: quote.text, start, end, excerpt: doc.content.slice(start, end) };
}

export function verifyQuotes(quotes: QuoteRef[], docs: SourceDocument[]): QuoteCheck[] {
  return quotes.map((q) => verifyQuote(q, docs));
}
