import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { setupMongoTest } from '../../../__test__/utils';
import {
  ABUSE_EVAL_MAX_RUNS,
  ABUSE_EVAL_MAX_VERDICTS_PER_EXAMPLE,
  AbuseEvalSetModel,
  abuseEvalSetRepository,
  type CreateAbuseEvalSetInput,
} from './AbuseEvalSetModel';

const adminId = new Types.ObjectId().toString();
const flaggedUser = new Types.ObjectId().toString();
const unflaggedUser = new Types.ObjectId().toString();
const otherUser = new Types.ObjectId().toString();

const example = (
  userId: string,
  overrides: Partial<CreateAbuseEvalSetInput['examples'][number]> = {}
): CreateAbuseEvalSetInput['examples'][number] => ({
  userId,
  kind: 'flagged',
  detectionIds: [new Types.ObjectId().toString()],
  campaignKey: userId,
  split: 'heldOut',
  cohorts: ['mobile'],
  signedUpAt: new Date('2026-10-02T00:00:00Z'),
  frozenLabel: { label: 'abuse', source: 'adminVerdict' },
  ...overrides,
});

const evalSet = (overrides: Partial<CreateAbuseEvalSetInput> = {}): CreateAbuseEvalSetInput => ({
  name: 'October draw',
  note: null,
  createdBy: adminId,
  window: { since: new Date('2026-10-01T00:00:00Z'), until: new Date('2026-10-31T00:00:00Z') },
  seed: 'abc123',
  heldOutShare: 0.5,
  population: { flagged: 1, unflagged: 40 },
  truncated: false,
  examples: [
    example(flaggedUser),
    example(unflaggedUser, { kind: 'unflagged', detectionIds: [], split: 'tuning', frozenLabel: null }),
  ],
  ...overrides,
});

const run = (note: string) => ({ ranAt: new Date(), ranBy: adminId, note, report: { n: note } });

describe('abuseEvalSetRepository', () => {
  setupMongoTest();

  beforeEach(async () => {
    await AbuseEvalSetModel.deleteMany({});
  });

  it('creates a set and reads it back with string ids and unreviewed examples', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());

    const found = await abuseEvalSetRepository.findById(id);
    expect(found?.id).toBe(id);
    expect(found?.createdBy).toBe(adminId);
    expect(found?.examples.map(e => [e.userId, e.verdicts, e.revision])).toEqual([
      [flaggedUser, [], 0],
      [unflaggedUser, [], 0],
    ]);
    expect(found?.runs).toEqual([]);
  });

  it('returns null for an unknown or malformed id', async () => {
    expect(await abuseEvalSetRepository.findById('nope')).toBeNull();
    expect(await abuseEvalSetRepository.findById(new Types.ObjectId().toString())).toBeNull();
  });

  it('lists summaries with counts and no example or run arrays', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());
    await abuseEvalSetRepository.addExampleVerdict({
      setId: id,
      userId: unflaggedUser,
      expectedRevision: 0,
      verdict: 'confirmed_abuse',
      reason: 'Spend pattern',
      reviewerId: adminId,
    });
    await abuseEvalSetRepository.appendRun(id, run('first'));

    const [summary] = await abuseEvalSetRepository.list();

    expect(summary).toMatchObject({
      id,
      name: 'October draw',
      createdBy: adminId,
      examples: 2,
      heldOutExamples: 1,
      unflaggedExamples: 1,
      runs: 1,
      population: { flagged: 1, unflagged: 40 },
      labelledByVerdict: {
        confirmed_abuse: 1,
        legitimate_human: 0,
        legitimate_automation: 0,
        insufficient_evidence: 0,
      },
    });
    expect(summary.lastRunAt).toBeInstanceOf(Date);
    expect(summary).not.toHaveProperty('seed');
  });

  it('summarises a set with no runs as lastRunAt null', async () => {
    await abuseEvalSetRepository.create(evalSet());
    const [summary] = await abuseEvalSetRepository.list();
    expect(summary.lastRunAt).toBeNull();
    expect(summary.runs).toBe(0);
  });

  it('counts an example by its latest verdict', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());
    const base = { setId: id, userId: flaggedUser, reviewerId: adminId, reason: 'r' };
    await abuseEvalSetRepository.addExampleVerdict({ ...base, expectedRevision: 0, verdict: 'confirmed_abuse' });
    await abuseEvalSetRepository.addExampleVerdict({ ...base, expectedRevision: 1, verdict: 'legitimate_human' });

    const [summary] = await abuseEvalSetRepository.list();
    expect(summary.labelledByVerdict.confirmed_abuse).toBe(0);
    expect(summary.labelledByVerdict.legitimate_human).toBe(1);
  });

  it('appends a verdict, bumps the revision and keeps the history', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());
    const base = { setId: id, userId: flaggedUser, reviewerId: adminId, reason: 'Checked' };

    expect(
      await abuseEvalSetRepository.addExampleVerdict({ ...base, expectedRevision: 0, verdict: 'confirmed_abuse' })
    ).toBe('updated');
    expect(
      await abuseEvalSetRepository.addExampleVerdict({ ...base, expectedRevision: 1, verdict: 'legitimate_human' })
    ).toBe('updated');

    const found = await abuseEvalSetRepository.findById(id);
    const graded = found?.examples.find(e => e.userId === flaggedUser);
    expect(graded?.revision).toBe(2);
    expect(graded?.verdicts.map(v => [v.verdict, v.reviewerId])).toEqual([
      ['confirmed_abuse', adminId],
      ['legitimate_human', adminId],
    ]);
    expect(found?.examples.find(e => e.userId === unflaggedUser)?.revision).toBe(0);
  });

  it('writes a verdict on the second example without touching the first', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());

    expect(
      await abuseEvalSetRepository.addExampleVerdict({
        setId: id,
        userId: unflaggedUser,
        reviewerId: adminId,
        reason: 'Checked',
        expectedRevision: 0,
        verdict: 'legitimate_human',
      })
    ).toBe('updated');

    const found = await abuseEvalSetRepository.findById(id);
    expect(found?.examples[0]).toMatchObject({ userId: flaggedUser, revision: 0, verdicts: [] });
    expect(found?.examples[1]).toMatchObject({ userId: unflaggedUser, revision: 1 });
    expect(found?.examples[1].verdicts.map(v => v.verdict)).toEqual(['legitimate_human']);
  });

  it('refuses a verdict past the per-example cap and writes nothing', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());
    await AbuseEvalSetModel.updateOne(
      { _id: id },
      { $set: { 'examples.0.revision': ABUSE_EVAL_MAX_VERDICTS_PER_EXAMPLE } }
    );

    const result = await abuseEvalSetRepository.addExampleVerdict({
      setId: id,
      userId: flaggedUser,
      reviewerId: adminId,
      reason: 'Checked',
      expectedRevision: ABUSE_EVAL_MAX_VERDICTS_PER_EXAMPLE,
      verdict: 'confirmed_abuse',
    });

    expect(result).toBe('limit_reached');
    const found = await abuseEvalSetRepository.findById(id);
    expect(found?.examples[0].verdicts).toEqual([]);
    expect(found?.examples[0].revision).toBe(ABUSE_EVAL_MAX_VERDICTS_PER_EXAMPLE);
  });

  it('reports a stale revision as a conflict and writes nothing', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());
    const base = { setId: id, userId: flaggedUser, reviewerId: adminId, reason: 'Checked' };
    await abuseEvalSetRepository.addExampleVerdict({ ...base, expectedRevision: 0, verdict: 'confirmed_abuse' });

    const result = await abuseEvalSetRepository.addExampleVerdict({
      ...base,
      expectedRevision: 0,
      verdict: 'legitimate_human',
    });

    expect(result).toBe('conflict');
    const found = await abuseEvalSetRepository.findById(id);
    expect(found?.examples.find(e => e.userId === flaggedUser)?.verdicts).toHaveLength(1);
  });

  it('lets exactly one of two concurrent same-revision verdicts win', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());
    const base = { setId: id, userId: flaggedUser, reviewerId: adminId, reason: 'Checked', expectedRevision: 0 };

    const results = await Promise.all([
      abuseEvalSetRepository.addExampleVerdict({ ...base, verdict: 'confirmed_abuse' }),
      abuseEvalSetRepository.addExampleVerdict({ ...base, verdict: 'legitimate_human' }),
    ]);

    expect([...results].sort()).toEqual(['conflict', 'updated']);
    const example = (await abuseEvalSetRepository.findById(id))?.examples.find(e => e.userId === flaggedUser);
    expect(example?.verdicts).toHaveLength(1);
    expect(example?.revision).toBe(1);
  });

  it('reports an unknown set, unknown example and malformed ids as not_found', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());
    const base = { reviewerId: adminId, reason: 'r', expectedRevision: 0, verdict: 'confirmed_abuse' as const };

    expect(
      await abuseEvalSetRepository.addExampleVerdict({
        ...base,
        setId: new Types.ObjectId().toString(),
        userId: flaggedUser,
      })
    ).toBe('not_found');
    expect(await abuseEvalSetRepository.addExampleVerdict({ ...base, setId: id, userId: otherUser })).toBe('not_found');
    expect(await abuseEvalSetRepository.addExampleVerdict({ ...base, setId: 'bad', userId: flaggedUser })).toBe(
      'not_found'
    );
  });

  it('returns the last two runs after an append', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());
    await abuseEvalSetRepository.appendRun(id, run('one'));
    await abuseEvalSetRepository.appendRun(id, run('two'));
    const lastTwo = await abuseEvalSetRepository.appendRun(id, run('three'));

    expect(lastTwo?.map(r => r.note)).toEqual(['two', 'three']);
    expect(await abuseEvalSetRepository.appendRun(new Types.ObjectId().toString(), run('x'))).toBeNull();
  });

  it('keeps only the newest runs', async () => {
    const id = await abuseEvalSetRepository.create(evalSet());
    for (let i = 0; i < ABUSE_EVAL_MAX_RUNS + 3; i++) {
      await abuseEvalSetRepository.appendRun(id, run(`run-${i}`));
    }

    const found = await abuseEvalSetRepository.findById(id);
    expect(found?.runs).toHaveLength(ABUSE_EVAL_MAX_RUNS);
    expect(found?.runs[0].note).toBe('run-3');
    expect(found?.runs.at(-1)?.note).toBe(`run-${ABUSE_EVAL_MAX_RUNS + 2}`);
  });

  it('removes a deleted user from every set and leaves the other examples', async () => {
    const first = await abuseEvalSetRepository.create(evalSet());
    const second = await abuseEvalSetRepository.create(evalSet({ examples: [example(flaggedUser)] }));
    const untouched = await abuseEvalSetRepository.create(evalSet({ examples: [example(otherUser)] }));

    expect(await abuseEvalSetRepository.removeUser(flaggedUser)).toBe(2);

    expect((await abuseEvalSetRepository.findById(first))?.examples.map(e => e.userId)).toEqual([unflaggedUser]);
    expect((await abuseEvalSetRepository.findById(second))?.examples).toEqual([]);
    expect((await abuseEvalSetRepository.findById(untouched))?.examples).toHaveLength(1);
    expect(await abuseEvalSetRepository.removeUser(flaggedUser)).toBe(0);
  });
});
