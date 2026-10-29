import { describe, it, expect } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { ArenaPair, arenaPairRepository as repo } from './ArenaPairModel';

setupMongoTest();

const answers = [
  { modelId: 'model-1', text: 'first answer' },
  { modelId: 'model-2', text: 'second answer' },
];

const seed = (over: Record<string, unknown> = {}) =>
  ArenaPair.create({
    prompt: 'p',
    taskType: 'qa',
    source: 'synthetic',
    answers,
    active: true,
    createdBy: 'admin',
    ...over,
  });

describe('arenaPairRepository', () => {
  it('samples only active pairs of the requested pool', async () => {
    const gold = await seed({ goldChoice: 'a' });
    const regular = await seed();
    await seed({ active: false });
    expect((await repo.sampleUnseen('gold', []))?.id).toBe(gold.id);
    expect((await repo.sampleUnseen('regular', []))?.id).toBe(regular.id);
  });

  it('excludes seen ids given as hex strings', async () => {
    const seen = await seed();
    const unseen = await seed();
    for (let i = 0; i < 5; i++) {
      expect((await repo.sampleUnseen('regular', [seen.id]))?.id).toBe(unseen.id);
    }
    expect(await repo.sampleUnseen('regular', [seen.id, unseen.id])).toBeNull();
  });

  it('lists newest first with the mapped fields and no answer texts', async () => {
    await seed({ prompt: 'older', createdAt: new Date('2026-01-01') });
    await seed({ prompt: 'newer', goldChoice: 'b', createdAt: new Date('2026-02-01') });
    const { data, total } = await repo.listPage(0, 10);
    expect(total).toBe(2);
    expect(data.map(pair => pair.prompt)).toEqual(['newer', 'older']);
    expect(data[0]).toMatchObject({
      taskType: 'qa',
      source: 'synthetic',
      goldChoice: 'b',
      active: true,
      answers: [{ modelId: 'model-1' }, { modelId: 'model-2' }],
    });
    expect(data[0].id).toBeTruthy();
    expect(data[0].createdAt).toBeInstanceOf(Date);
    expect(data[0].answers[0].text).toBeUndefined();
  });

  it('counts total, gold and active pairs', async () => {
    await seed({ goldChoice: 'a' });
    await seed();
    await seed({ active: false });
    expect(await repo.countsForStats()).toEqual({ total: 3, gold: 1, active: 2 });
  });

  it('projects findByIds and ignores malformed ids', async () => {
    const pair = await seed();
    const [found] = await repo.findByIds([pair.id, 'not-an-id'], { taskType: 1, 'answers.modelId': 1 });
    expect(found.taskType).toBe('qa');
    expect(found.answers[1].modelId).toBe('model-2');
    expect(found.answers[1].text).toBeUndefined();
  });
});
