import { describe, expect, it } from 'vitest';
import { orderAccountsByRecentTeams } from './teamPreferences';

const personal = { id: 'me', personal: true };
const alpha = { id: 'alpha', personal: false };
const beta = { id: 'beta', personal: false };
const gamma = { id: 'gamma', personal: false };

describe('orderAccountsByRecentTeams', () => {
  it('keeps the personal account first and puts recent teams ahead of the rest', () => {
    const ordered = orderAccountsByRecentTeams([alpha, beta, personal, gamma], ['gamma', 'beta']);
    expect(ordered.map(account => account.id)).toEqual(['me', 'gamma', 'beta', 'alpha']);
  });

  it('keeps the input order when there is no history', () => {
    const ordered = orderAccountsByRecentTeams([personal, beta, alpha], []);
    expect(ordered.map(account => account.id)).toEqual(['me', 'beta', 'alpha']);
  });

  it('ignores recent ids for teams the user no longer belongs to', () => {
    const ordered = orderAccountsByRecentTeams([personal, alpha, beta], ['gone', 'beta']);
    expect(ordered.map(account => account.id)).toEqual(['me', 'beta', 'alpha']);
  });

  it('does not mutate the input', () => {
    const input = [alpha, personal];
    orderAccountsByRecentTeams(input, []);
    expect(input).toEqual([alpha, personal]);
  });
});
