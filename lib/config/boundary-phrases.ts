export const BOUNDARY_PHRASES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'mn_met', pattern: /\bmedical necessity (criteria )?((is|are|was|were|has been|have been) )?(met|satisfied|established)\b/ },
  { id: 'mn_not_met', pattern: /\b(does not|doesn't|do not|don't|did not|didn't|fails to|failed to) meet (the )?medical necessity\b/ },
  { id: 'meets_mn', pattern: /\b(meets|meet|met|satisfies|satisfied) (the )?medical necessity\b/ },
  { id: 'medically_necessary', pattern: /\bmedically necessary\b/ },
  { id: 'meets_criteria', pattern: /\b(meets|meet|met|satisfies|satisfy|satisfied|fulfills|fulfils) (the |all |all the )?([a-z0-9]+ )?criteria\b/ },
  { id: 'criteria_met', pattern: /\bcriteria ((is|are|was|were|has been|have been) )?(met|satisfied)\b/ },
  { id: 'should_decide', pattern: /\b(should|must|will) (be )?(approved|denied|overturned|upheld|authorized)\b/ },
  { id: 'chance_of_outcome', pattern: /\b(chance|chances|odds|likelihood|probability) (of|to) (win|winning|success|succeed|succeeding|approval|being approved|overturn|overturning|being overturned)\b/ },
  { id: 'likely_outcome', pattern: /\blikely to (win|succeed|be approved|be overturned|be upheld|be denied)\b/ },
  { id: 'recommend_treatment', pattern: /\b(recommend|recommends|recommended|recommending) (continued |continuing |further |additional )?(treatment|admission|discharge|medication|medications|hospitalization|inpatient|detox|detoxification|level of care)\b/ },
];
