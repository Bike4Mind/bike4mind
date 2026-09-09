import { describe, it, expect, vi } from 'vitest';
import { EmailSendAttemptRepository, IEmailSendAttemptModel } from './EmailSendAttemptModel';

/**
 * `findByJob` extends `endDate` to the end of its day so the whole day is included. That
 * `setHours(23, 59, 59, 999)` overflows to an Invalid Date when `endDate` already sits at the
 * top of the representable range, and an Invalid Date reaching the Date-typed `createdAt`
 * throws a CastError from both queries below. The caller-facing route validates that its
 * date string parses, which this input does - the overflow happens after that check.
 */

const makeRepo = () => {
  const find = vi.fn(() => ({
    sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
  }));
  const countDocuments = vi.fn(() => Promise.resolve(0));
  // any: a two-method stand-in for the mongoose Model, which is all findByJob touches
  const model = { find, countDocuments } as any as IEmailSendAttemptModel;
  return { repo: new EmailSendAttemptRepository(model), find, countDocuments };
};

const upperBound = (find: ReturnType<typeof vi.fn>): Date =>
  (find.mock.calls[0][0] as { createdAt: { $lte: Date } }).createdAt.$lte;

describe('EmailSendAttemptRepository.findByJob - end-of-day extension', () => {
  it('extends a normal endDate to the end of its day', async () => {
    const { repo, find } = makeRepo();
    await repo.findByJob('job-1', { page: 1, limit: 10, endDate: new Date('2026-01-01T00:00:00.000Z') });

    const bound = upperBound(find);
    expect(Number.isNaN(bound.getTime())).toBe(false);
    expect(bound.getMilliseconds()).toBe(999);
  });

  it('never puts an Invalid Date on the filter for an endDate at the top of the range', async () => {
    const { repo, find, countDocuments } = makeRepo();
    const endDate = new Date('+275760-09-13');
    // The premise: this date is valid, so a parseability check upstream passes it through.
    expect(Number.isNaN(endDate.getTime())).toBe(false);

    await repo.findByJob('job-1', { page: 1, limit: 10, endDate });

    expect(Number.isNaN(upperBound(find).getTime())).toBe(false);
    expect(Number.isNaN((countDocuments.mock.calls[0][0] as { createdAt: { $lte: Date } }).createdAt.$lte.getTime())).toBe(
      false
    );
  });

  it('falls back to the un-extended date rather than dropping the bound', async () => {
    const { repo, find } = makeRepo();
    const endDate = new Date('+275760-09-13');
    await repo.findByJob('job-1', { page: 1, limit: 10, endDate });

    expect(upperBound(find).getTime()).toBe(endDate.getTime());
  });
});
