import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { ObligationSchema } from '@bike4mind/common';
import type { IObligation } from '@bike4mind/database';
import { serializeObligation } from './serializeObligation';

const base: IObligation = {
  _id: new mongoose.Types.ObjectId('6650c0ffee0000000000abcd'),
  userId: 'user-me',
  fileId: 'file-1',
  status: 'confirmed',
  documentKind: 'invoice',
  amountValue: 0,
  currency: 'EUR',
  payee: 'Example Utilities',
  dueDate: new Date('2026-12-15T00:00:00.000Z'),
  destinationLakeId: 'lake-1',
  destinationName: 'Bills',
  summary: 'Power bill',
  model: 'model-x',
  confirmedAt: new Date('2026-11-25T10:00:00.000Z'),
  createdAt: new Date('2026-11-24T10:00:00.000Z'),
  updatedAt: new Date('2026-11-25T10:00:00.000Z'),
};

describe('serializeObligation', () => {
  it('maps a confirmed row to the wire shape, keeping a zero amount', () => {
    const wire = serializeObligation(base, { showDestination: true });
    expect(wire).toEqual({
      id: '6650c0ffee0000000000abcd',
      status: 'confirmed',
      document_kind: 'invoice',
      file_id: 'file-1',
      amount: { value: 0, currency: 'EUR' },
      payee: 'Example Utilities',
      due_date: '2026-12-15',
      destination: { lake_id: 'lake-1', name: 'Bills' },
      summary: 'Power bill',
      created_at: '2026-11-24T10:00:00.000Z',
      confirmed_at: '2026-11-25T10:00:00.000Z',
    });
    expect(ObligationSchema.safeParse(wire).success).toBe(true);
    expect(wire).not.toHaveProperty('userId');
    expect(wire).not.toHaveProperty('model');
  });

  it('nulls an amount missing its currency, an absent due date and destination', () => {
    const wire = serializeObligation(
      {
        ...base,
        status: 'pending',
        currency: null,
        dueDate: null,
        destinationLakeId: null,
        destinationName: null,
        confirmedAt: null,
      },
      { showDestination: true }
    );
    expect(wire).toMatchObject({ amount: null, due_date: null, destination: null, confirmed_at: null });
    expect(ObligationSchema.safeParse(wire).success).toBe(true);
  });

  it('hides a stored destination from a caller that may not read lakes', () => {
    expect(serializeObligation(base, { showDestination: false }).destination).toBeNull();
  });
});
