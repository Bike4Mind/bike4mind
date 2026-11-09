import { describe, it, expect } from 'vitest';
import { FEEDBACK_LIST_MAX_LIMIT, FEEDBACK_SUBJECTS, FeedbackStatus } from '@bike4mind/common';
import {
  FEEDBACK_DEFAULT_PAGE_SIZE,
  FEEDBACK_PAGE_SIZE_OPTIONS,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUS_ORDER,
  FEEDBACK_SUBJECT_LABELS,
  toSubjectFilter,
} from './constants';

// DataTable's footer select offers exactly these sizes, and the list's URL parser accepts only them.
describe('FEEDBACK_PAGE_SIZE_OPTIONS', () => {
  it('matches the table pager and stays within the server cap', () => {
    expect(FEEDBACK_PAGE_SIZE_OPTIONS).toEqual([25, 50, 100]);
    expect(Math.max(...FEEDBACK_PAGE_SIZE_OPTIONS)).toBeLessThanOrEqual(FEEDBACK_LIST_MAX_LIMIT);
    expect(FEEDBACK_DEFAULT_PAGE_SIZE).toBe(25);
  });
});

describe('FEEDBACK_STATUS_LABELS', () => {
  it('labels every status in triage order, in sentence case', () => {
    expect(FEEDBACK_STATUS_ORDER.map(status => FEEDBACK_STATUS_LABELS[status])).toEqual([
      'New',
      'In progress',
      'Closed',
    ]);
    expect(FEEDBACK_STATUS_ORDER).toHaveLength(Object.values(FeedbackStatus).length);
  });
});

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
});

describe('toSubjectFilter', () => {
  it('passes a real subject through', () => {
    expect(toSubjectFilter('turn')).toBe('turn');
    expect(toSubjectFilter('product')).toBe('product');
  });

  // Both of these have to clear the filter rather than reach the query: a value the server does not
  // know as a subject would return nothing instead of everything.
  it('clears the filter for a cleared chip and for an unknown value', () => {
    expect(toSubjectFilter(undefined)).toBeUndefined();
    expect(toSubjectFilter('all')).toBeUndefined();
  });
});
