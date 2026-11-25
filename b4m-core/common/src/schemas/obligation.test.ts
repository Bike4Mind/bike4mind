import { describe, expect, it } from 'vitest';
import {
  ObligationAmountSchema,
  ObligationDueDateSchema,
  ObligationHandoffRequestSchema,
  ObligationSchema,
  ObligationUpdateRequestSchema,
  OBLIGATION_LIMITS,
} from './obligation';
import { isCalendarDate } from './settings';

describe('isCalendarDate', () => {
  it('accepts real days, including a leap day', () => {
    expect(isCalendarDate('2026-12-01')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
  });

  it('rejects impossible days and other shapes', () => {
    for (const value of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-1-5', '2026-12-01T00:00Z', '']) {
      expect(isCalendarDate(value)).toBe(false);
    }
  });
});

describe('ObligationAmountSchema', () => {
  it('accepts zero and a decimal amount', () => {
    expect(ObligationAmountSchema.safeParse({ value: 0, currency: 'USD' }).success).toBe(true);
    expect(ObligationAmountSchema.safeParse({ value: 120.5, currency: 'EUR' }).success).toBe(true);
  });

  it('rejects negative, NaN, infinite and lower-case currency', () => {
    expect(ObligationAmountSchema.safeParse({ value: -1, currency: 'USD' }).success).toBe(false);
    expect(ObligationAmountSchema.safeParse({ value: Number.NaN, currency: 'USD' }).success).toBe(false);
    expect(ObligationAmountSchema.safeParse({ value: Number.POSITIVE_INFINITY, currency: 'USD' }).success).toBe(false);
    expect(ObligationAmountSchema.safeParse({ value: 1, currency: 'usd' }).success).toBe(false);
    expect(ObligationAmountSchema.safeParse({ value: 1, currency: 'US' }).success).toBe(false);
  });
});

describe('ObligationHandoffRequestSchema', () => {
  it('requires a non-empty file id and caps text', () => {
    expect(ObligationHandoffRequestSchema.safeParse({ file_id: 'f1' }).success).toBe(true);
    expect(ObligationHandoffRequestSchema.safeParse({ file_id: '' }).success).toBe(false);
    expect(
      ObligationHandoffRequestSchema.safeParse({ file_id: 'f1', text: 'x'.repeat(OBLIGATION_LIMITS.text + 1) }).success
    ).toBe(false);
  });
});

describe('ObligationUpdateRequestSchema', () => {
  it('lets an empty object through, since the route owns the at-least-one-field rule', () => {
    expect(ObligationUpdateRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts nulls that clear a field', () => {
    const parsed = ObligationUpdateRequestSchema.parse({
      amount: null,
      payee: null,
      due_date: null,
      destination_lake_id: null,
    });
    expect(parsed).toEqual({ amount: null, payee: null, due_date: null, destination_lake_id: null });
  });

  it('rejects an empty payee, a bad date, a negative amount and status pending', () => {
    expect(ObligationUpdateRequestSchema.safeParse({ payee: '' }).success).toBe(false);
    expect(ObligationUpdateRequestSchema.safeParse({ due_date: '2026-02-30' }).success).toBe(false);
    expect(ObligationUpdateRequestSchema.safeParse({ amount: { value: -5, currency: 'USD' } }).success).toBe(false);
    expect(ObligationUpdateRequestSchema.safeParse({ destination_lake_id: '' }).success).toBe(false);
    expect(ObligationUpdateRequestSchema.safeParse({ status: 'pending' }).success).toBe(false);
  });
});

describe('ObligationSchema', () => {
  it('round-trips an invoice with every nullable field null', () => {
    const wire = {
      id: 'o1',
      status: 'pending',
      document_kind: 'letter',
      file_id: 'f1',
      amount: null,
      payee: null,
      due_date: null,
      destination: null,
      summary: 'A letter about a policy change.',
      created_at: '2026-11-25T00:00:00.000Z',
      confirmed_at: null,
    };
    expect(ObligationSchema.parse(wire)).toEqual(wire);
    expect(ObligationDueDateSchema.safeParse('2026-11-31').success).toBe(false);
  });
});
