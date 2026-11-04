import { BOUNDARY_PHRASES } from '../../config/boundary-phrases';
import { normalizeWithMap } from '../../harness/verify-quotes';
import type { RunStatus } from '../../harness/run-agent';

export type BoundaryHit = { path: string; phraseId: string };
type Interval = { start: number; end: number };

function scanNormalize(text: string): { norm: string; starts: number[]; ends: number[] } {
  let norm = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const point of text) {
    const end = index + point.length;
    const normalized = point.normalize('NFKC').toLowerCase()
      .replace(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g, '')
      .replace(/[-\u2010-\u2015\u2212]/g, ' ')
      .replace(/[‘’‛]/g, "'").replace(/[“”‟]/g, '"');
    for (const char of normalized) {
      if (/\s/.test(char)) {
        if (norm.length && !norm.endsWith(' ')) {
          norm += ' '; starts.push(index); ends.push(end);
        }
      } else {
        norm += char;
        for (let unit = 0; unit < char.length; unit++) { starts.push(index); ends.push(end); }
      }
    }
    index = end;
  }
  return { norm, starts, ends };
}

function quoteIntervals(text: string, quotes: readonly string[]): Interval[] {
  const hay = normalizeWithMap(text);
  const intervals: Interval[] = [];
  for (const quote of quotes) {
    const needle = normalizeWithMap(quote).norm.trim();
    if (!needle) continue;
    let at = hay.norm.indexOf(needle);
    while (at !== -1) {
      const start = hay.map[at], end = hay.map[at + needle.length - 1] + 1;
      const before = text.slice(0, start).trimEnd();
      const after = text.slice(end).trimStart();
      const opening = before.at(-1), closing = after[0];
      const quoted = (opening === '"' && closing === '"') || (opening === "'" && closing === "'") || (opening === '“' && closing === '”') || (opening === '‘' && closing === '’');
      // A source substring alone cannot mask an unquoted clinical determination.
      if (hay.norm.trim() === needle || quoted) intervals.push({ start, end });
      at = hay.norm.indexOf(needle, at + 1);
    }
  }
  return intervals;
}

export function scanText(text: string, verifiedQuotes: readonly string[]): string[] {
  const scan = scanNormalize(text);
  const quotes = quoteIntervals(text, verifiedQuotes);
  return BOUNDARY_PHRASES.filter(({ pattern }) => {
    const matches = scan.norm.matchAll(new RegExp(pattern.source, 'g'));
    for (const match of matches) {
      const start = scan.starts[match.index];
      const end = scan.ends[match.index + match[0].length - 1];
      if (!quotes.some((quote) => quote.start <= start && quote.end >= end)) return true;
    }
    return false;
  }).map(({ id }) => id);
}

export function scanAgentOutput(output: unknown, verifiedQuotes: readonly string[]): { flagged: boolean; hits: BoundaryHit[] } {
  const hits: BoundaryHit[] = [];
  function walk(value: unknown, path: string, depth: number): void {
    if (depth > 32) { hits.push({ path, phraseId: 'depth_exceeded' }); return; }
    if (typeof value === 'string') {
      hits.push(...scanText(value, verifiedQuotes).map((phraseId) => ({ path, phraseId })));
    } else if (Array.isArray(value)) {
      value.forEach((item: unknown, index) => walk(item, `${path}[${index}]`, depth + 1));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key, depth + 1);
    }
  }
  walk(output, '', 0);
  return { flagged: hits.length > 0, hits };
}

export function applyBoundaryStatus(status: RunStatus, flagged: boolean): RunStatus {
  return status === 'ok' && flagged ? 'needs_review' : status;
}
