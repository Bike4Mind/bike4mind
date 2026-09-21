import { describe, it, expect } from 'vitest';
import { FEEDBACK_SUBJECTS } from '@bike4mind/common';
import { FEEDBACK_SUBJECT_ANY, FEEDBACK_SUBJECT_LABELS, toSubjectFilter } from './constants';

describe('FEEDBACK_SUBJECT_LABELS', () => {
  // The filter menu maps over FEEDBACK_SUBJECTS and reads a label per entry. TypeScript already
  // requires the Record to be exhaustive, but nothing at runtime stops a label from being blank -
  // which would render an option an operator cannot read or distinguish.
  it('labels every subject the server accepts', () => {
    for (const subject of FEEDBACK_SUBJECTS) {
      expect(FEEDBACK_SUBJECT_LABELS[subject]?.trim()).toBeTruthy();
    }
  });

  it('gives each subject a distinct label', () => {
    const labels = FEEDBACK_SUBJECTS.map(subject => FEEDBACK_SUBJECT_LABELS[subject]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  // The "all" entry shares the Select's value space with the real subjects, so a subject named
  // 'all' would make the clear-the-filter option indistinguishable from a filter on it.
  it('keeps the clear-the-filter sentinel out of the subject space', () => {
    expect(FEEDBACK_SUBJECTS).not.toContain(FEEDBACK_SUBJECT_ANY);
  });
});

describe('toSubjectFilter', () => {
  it('passes a real subject through', () => {
    expect(toSubjectFilter('turn')).toBe('turn');
    expect(toSubjectFilter('product')).toBe('product');
  });

  // Both of these have to clear the filter rather than reach the query: 'all' is not a subject the
  // server knows, so sending it would return nothing instead of everything.
  it('clears the filter for the sentinel and for a null selection', () => {
    expect(toSubjectFilter(FEEDBACK_SUBJECT_ANY)).toBeUndefined();
    expect(toSubjectFilter(null)).toBeUndefined();
  });
});
