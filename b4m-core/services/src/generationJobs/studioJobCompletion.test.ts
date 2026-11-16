import { describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  StudioJobCompletedEventSchema,
  type GenerationJobState,
  type IGenerationJob,
  type IGenerationJobDocument,
  type StudioJobCompletedEvent,
} from '@bike4mind/common';
import { createInMemoryGenerationJobRepository } from './__test__/inMemoryGenerationJobRepository';
import { announceGroupCompletion } from './groupCompletion';
import { studioCompletionSubscriber, studioCompletionTitle } from './studioJobCompletion';

const NOW = new Date('2026-11-12T10:00:00Z');
const GROUP_ID = '6733a0000000000000000000';
const PROMPT = 'Cold brew launch';

const imagePayload = (groupSize?: number) =>
  ({
    request: { model: 'gpt-image-1', mode: 'generate', prompt: PROMPT, inputs: [] },
    providerId: 'openai',
    groupId: GROUP_ID,
    ...(groupSize !== undefined && { groupSize }),
  }) as unknown as IGenerationJob['payload'];

const videoPayload = {
  request: { model: 'test-video', mode: 'text_to_video', prompt: 'A lighthouse at dusk', durationSeconds: 4 },
  providerId: 'test',
} as unknown as IGenerationJob['payload'];

const setup = () => {
  const repository = createInMemoryGenerationJobRepository({ now: () => NOW });
  const published: StudioJobCompletedEvent[] = [];
  const publish = vi.fn(async (event: StudioJobCompletedEvent) => {
    published.push(event);
  });
  const deps = {
    repository,
    subscribers: [studioCompletionSubscriber(publish)],
    now: () => NOW,
    logger: { error: vi.fn() },
  };
  const announce = (job: IGenerationJobDocument) => announceGroupCompletion(job, deps);
  let nextId = 0;
  const create = (overrides: Partial<IGenerationJob> = {}) =>
    repository.createJob({
      id: `6733a00000000000000000${String(++nextId).padStart(2, '0')}`,
      kind: 'image',
      ownerType: CreditHolderType.User,
      ownerId: 'u1',
      requestedBy: 'u1',
      source: 'studio',
      state: 'succeeded',
      payload: imagePayload(4),
      pollCount: 0,
      attempts: 0,
      cancelRequested: false,
      deadlineAt: NOW,
      creditHold: null,
      ...overrides,
    } as Parameters<typeof repository.createJob>[0]);
  const createGroup = async (states: GenerationJobState[], overrides: Partial<IGenerationJob> = {}) => {
    const jobs: IGenerationJobDocument[] = [];
    for (const state of states) jobs.push(await create({ state, payload: imagePayload(states.length), ...overrides }));
    return jobs;
  };
  return { repository, announce, publish, published, create, createGroup };
};

describe('studioCompletionSubscriber', () => {
  it('emits one event for a group whose takes all succeeded', async () => {
    const t = setup();
    const jobs = await t.createGroup(['succeeded', 'succeeded', 'succeeded', 'succeeded']);

    const outcomes = [];
    for (const job of jobs) outcomes.push(await t.announce(job));

    expect(outcomes).toEqual(['announced', 'already_announced', 'already_announced', 'already_announced']);
    expect(t.published).toEqual([
      {
        version: 1,
        userId: 'u1',
        groupId: GROUP_ID,
        medium: 'image',
        totalCount: 4,
        readyCount: 4,
        failedCount: 0,
        cancelledCount: 0,
        title: PROMPT,
        link: `/studio/image?group=${GROUP_ID}`,
        completedAt: NOW.toISOString(),
      },
    ]);
    expect(StudioJobCompletedEventSchema.parse(t.published[0])).toEqual(t.published[0]);
  });

  it('counts failed and blocked takes on a partial failure', async () => {
    const t = setup();
    const [last] = await t.createGroup(['failed', 'succeeded', 'blocked', 'succeeded']);

    expect(await t.announce(last)).toBe('announced');
    expect(t.published).toHaveLength(1);
    expect(t.published[0]).toMatchObject({ totalCount: 4, readyCount: 2, failedCount: 2, cancelledCount: 0 });
  });

  it('still announces a group whose takes all failed', async () => {
    const t = setup();
    const [last] = await t.createGroup(['failed', 'failed', 'blocked']);

    expect(await t.announce(last)).toBe('announced');
    expect(t.published[0]).toMatchObject({ totalCount: 3, readyCount: 0, failedCount: 3 });
  });

  it('waits while any take is still in flight', async () => {
    const t = setup();
    const [done, , running] = await t.createGroup(['succeeded', 'succeeded', 'running']);

    expect(await t.announce(done)).toBe('group_pending');
    expect(t.publish).not.toHaveBeenCalled();

    t.repository.jobs.get(running.id)!.state = 'succeeded';
    expect(await t.announce(running)).toBe('announced');
    expect(t.published[0]).toMatchObject({ readyCount: 3 });
  });

  it('waits for takes not yet stored when an early take finishes first', async () => {
    const t = setup();
    const first = await t.create({ state: 'failed', payload: imagePayload(4) });

    expect(await t.announce(first)).toBe('group_pending');
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('publishes once when two takes finish together and both see the group done', async () => {
    const t = setup();
    const [a, b] = await t.createGroup(['succeeded', 'failed']);

    const outcomes = await Promise.all([t.announce(a), t.announce(b)]);

    expect(outcomes.sort()).toEqual(['already_announced', 'announced']);
    expect(t.publish).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the user cancelled every take', async () => {
    const t = setup();
    const [last] = await t.createGroup(['cancelled', 'cancelled']);

    expect(await t.announce(last)).toBe('all_cancelled');
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('reports cancelled takes apart from failures', async () => {
    const t = setup();
    const [last] = await t.createGroup(['succeeded', 'cancelled', 'failed']);

    await t.announce(last);
    expect(t.published[0]).toMatchObject({ readyCount: 1, failedCount: 1, cancelledCount: 1 });
  });

  it('ignores jobs that did not come from Studio', async () => {
    const t = setup();
    const [last] = await t.createGroup(['succeeded'], { source: 'api' });

    expect(await t.announce(last)).toBe('no_audience');
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('treats a video job as a group of one', async () => {
    const t = setup();
    const job = await t.create({ kind: 'video', state: 'succeeded', payload: videoPayload });

    expect(await t.announce(job)).toBe('announced');
    expect(t.published[0]).toMatchObject({
      groupId: job.id,
      medium: 'video',
      totalCount: 1,
      readyCount: 1,
      title: 'A lighthouse at dusk',
      link: `/studio/video?group=${job.id}`,
    });
  });

  it('falls back to the stored members for an image group made before groupSize existed', async () => {
    const t = setup();
    await t.create({ state: 'succeeded', payload: imagePayload() });
    const last = await t.create({ state: 'failed', payload: imagePayload() });

    expect(await t.announce(last)).toBe('announced');
    expect(t.published[0]).toMatchObject({ totalCount: 2, readyCount: 1, failedCount: 1 });
  });
});

describe('studioCompletionTitle', () => {
  it('collapses whitespace', () => {
    expect(studioCompletionTitle('  Cold   brew\n launch ')).toBe('Cold brew launch');
  });

  it('cuts a long prompt on a word and stays within the schema limit', () => {
    const title = studioCompletionTitle(
      'A cinematic close-up of a cold brew bottle sweating on a sunlit marble counter, morning light'
    );
    expect(title.endsWith('...')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).toBe('A cinematic close-up of a cold brew bottle sweating on a...');
  });

  it('labels an empty prompt', () => {
    expect(studioCompletionTitle('   ')).toBe('Untitled');
    expect(studioCompletionTitle(undefined)).toBe('Untitled');
  });
});
