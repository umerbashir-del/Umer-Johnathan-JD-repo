import { describe, expect, it } from 'vitest';
import { applyBoundaryStatus, scanAgentOutput, scanText } from './boundary';

// This phrase floor cannot detect every clinical paraphrase; clinician review remains required.
describe('clinical boundary', () => {
  it.each([
    ['Medical necessity met.', ['mn_met']],
    ['The patient meets criteria for inpatient care.', ['meets_criteria']],
    ['The request should be approved.', ['should_decide']],
    ['There is a strong chance of winning on appeal.', ['chance_of_outcome']],
    ['The stay does not meet medical necessity.', ['mn_not_met', 'meets_mn']],
  ])('flags %s', (text, expected) => expect(scanText(text, [])).toEqual(expected));
  it('walks mocked output and ignores its self-assigned quote label', () => {
    expect(scanAgentOutput({ sections: [{ heading: 'Summary', claims: [{ text: 'Medical necessity is met for continued stay.', sourceKind: 'agent_synthesis', factIds: [] }] }] }, [])).toEqual({ flagged: true, hits: [{ path: 'sections[0].claims[0].text', phraseId: 'mn_met' }] });
    expect(scanAgentOutput({ text: 'medically necessary', sourceKind: 'direct_quote' }, [])).toEqual({ flagged: true, hits: [{ path: 'text', phraseId: 'medically_necessary' }] });
  });
  it('exempts only a phrase fully contained by a verified quote', () => {
    expect(scanText('The denial letter states "not medically necessary" for days 4 to 6.', ['not medically necessary'])).toEqual([]);
    expect(scanText('Medical necessity met.', ['met'])).toEqual(['mn_met']);
    expect(scanText('Medical necessity met.', ['Medical necessity'])).toEqual(['mn_met']);
    expect(scanText('Medical necessity met.', [''])).toEqual(['mn_met']);
  });
  it('does not mask an unquoted repetition of a verified phrase', () => {
    expect(scanText('"medically necessary"; medically necessary', ['medically necessary'])).toEqual(['medically_necessary']);
    expect(scanText('"not medically necessary"; medically necessary', ['not medically necessary'])).toEqual(['medically_necessary']);
    expect(scanText('The letter says “medically necessary”.', ['medically necessary'])).toEqual([]);
    expect(scanText('Care is medically necessary.', ['medically necessary'])).toEqual(['medically_necessary']);
    expect(scanText('medically necessary', ['medically necessary'])).toEqual([]);
  });
  it.each(['MEDICAL   NECESSITY\nMET', 'medical\u2011necessity met', 'medi\u200bcal necessity met', Array.from('medical necessity met', (char) => char === ' ' ? char : String.fromCodePoint(char.charCodeAt(0) + 0xfee0)).join('')])('normalizes evasion %s', (text) => expect(scanText(text, [])).toEqual(['mn_met']));
  it.each(['Patient met with the therapist on 2026-11-02.', 'ASAM dimension 1: documented.', 'See criteria summary.', 'Medical necessity criteria dimensions are incomplete in the record.', 'The authorization should be extended pending review.', ''])('allows neutral text %s', (text) => expect(scanText(text, [])).toEqual([]));
  it('never improves status', () => {
    expect(applyBoundaryStatus('ok', true)).toBe('needs_review');
    expect(applyBoundaryStatus('failed', true)).toBe('failed');
    expect(applyBoundaryStatus('needs_review', false)).toBe('needs_review');
    expect(applyBoundaryStatus('ok', false)).toBe('ok');
  });
  it('reports exact depth-first paths and fails closed on excessive depth', () => {
    expect(scanAgentOutput({ a: [1, null, false, { b: 'should be approved' }], c: 'medically necessary' }, [])).toEqual({ flagged: true, hits: [{ path: 'a[3].b', phraseId: 'should_decide' }, { path: 'c', phraseId: 'medically_necessary' }] });
    let nested: unknown = 'neutral';
    for (let depth = 0; depth < 33; depth++) nested = [nested];
    expect(scanAgentOutput(nested, [])).toEqual({ flagged: true, hits: [{ path: '[0]'.repeat(33), phraseId: 'depth_exceeded' }] });
  });
});
