import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkedFields } from './fields';
import { testLoop } from './testLoop';

const checkout = () => {
  const directory = mkdtempSync(join(tmpdir(), 'b4m-fields-'));
  mkdirSync(join(directory, '.git'));
  return directory;
};

describe('checkedFields', () => {
  it('refuses a folder the owner did not choose in the picker, even a git checkout', () => {
    expect(() => checkedFields({ directory: checkout() }, undefined, new Set())).toThrow(
      'Choose the folder with Choose folder.'
    );
  });

  it('takes a picked git checkout', () => {
    const directory = checkout();
    expect(checkedFields({ directory }, undefined, new Set([directory]))).toEqual({ directory });
  });

  it('still refuses a picked folder that is not a git checkout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'b4m-fields-'));
    expect(() => checkedFields({ directory }, undefined, new Set([directory]))).toThrow('Pick a local git checkout.');
  });

  it('lets an edit resend the folder the loop already has', () => {
    const directory = checkout();
    const current = testLoop({ directory });
    expect(checkedFields({ directory, name: 'Renamed' }, current, new Set())).toMatchObject({ name: 'Renamed' });
  });
});

describe('checkedFields optional fields', () => {
  it('clears an optional field sent as null and leaves an absent one alone', () => {
    const current = testLoop({ fallbackModel: 'gpt-old', budgetCreditsPerDay: 50 });
    const fields = checkedFields({ fallbackModel: null }, current, new Set());
    expect(fields).toHaveProperty('fallbackModel', undefined);
    expect(fields).not.toHaveProperty('budgetCreditsPerDay');
    const stored = JSON.parse(JSON.stringify({ ...current, ...fields }));
    expect(stored).not.toHaveProperty('fallbackModel');
    expect(stored.budgetCreditsPerDay).toBe(50);
  });
});

describe('checkedFields oversees', () => {
  it('takes other existing loops, deduped, and refuses itself or an unknown id', () => {
    const current = testLoop({ id: 'boss' });
    const ids = new Set(['boss', 'worker']);
    expect(checkedFields({ oversees: ['worker', 'worker'] }, current, new Set(), ids).oversees).toEqual(['worker']);
    expect(() => checkedFields({ oversees: ['boss'] }, current, new Set(), ids)).toThrow(
      'A loop can oversee only other Desktop loops.'
    );
    expect(() => checkedFields({ oversees: ['gone'] }, current, new Set(), ids)).toThrow(
      'A loop can oversee only other Desktop loops.'
    );
  });
});
