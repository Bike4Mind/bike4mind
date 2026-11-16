import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type GenerationJobState, type IGenerationJob } from '@bike4mind/common';
import { createInMemoryGenerationJobRepository } from './__test__/inMemoryGenerationJobRepository';
import { announceGroupCompletion, type GroupCompletion, type GroupCompletionSubscriber } from './groupCompletion';

const NOW = new Date('2026-11-13T10:00:00Z');
const GROUP_ID = '6734a0000000000000000000';
const SLACK = { kind: 'slack' as const, workspaceId: 'w1', channelId: 'C1', threadTs: '1700000000.000100' };

const imagePayload = (groupSize: number) =>
  ({
    request: { model: 'gpt-image-1', mode: 'generate', prompt: 'A red kite', inputs: [] },
    providerId: 'openai',
    groupId: GROUP_ID,
    groupSize,
  }) as unknown as IGenerationJob['payload'];

const subscriber = (name: string, wants: GroupCompletionSubscriber['wants'], deliver = vi.fn(async () => {})) => ({
  name,
  wants,
  deliver: deliver as GroupCompletionSubscriber['deliver'] & ReturnType<typeof vi.fn>,
});

const setup = (subscribers: GroupCompletionSubscriber[]) => {
  const repository = createInMemoryGenerationJobRepository({ now: () => NOW });
  const logger = { error: vi.fn() };
  let nextId = 0;
  const createGroup = async (states: GenerationJobState[], overrides: Partial<IGenerationJob> = {}) => {
    const jobs = [];
    for (const state of states) {
      jobs.push(
        await repository.createJob({
          id: `6734a00000000000000000${String(++nextId).padStart(2, '0')}`,
          kind: 'image',
          ownerType: CreditHolderType.User,
          ownerId: 'u1',
          requestedBy: 'u1',
          source: 'agent',
          state,
          payload: imagePayload(states.length),
          pollCount: 0,
          attempts: 0,
          cancelRequested: false,
          deadlineAt: NOW,
          creditHold: null,
          ...overrides,
        } as Parameters<typeof repository.createJob>[0])
      );
    }
    return jobs;
  };
  const announce = (job: Parameters<typeof announceGroupCompletion>[0]) =>
    announceGroupCompletion(job, { repository, subscribers, now: () => NOW, logger });
  return { repository, logger, createGroup, announce };
};

describe('announceGroupCompletion', () => {
  it('hands one completion per group to every subscriber that wants it', async () => {
    const slack = subscriber('slack', job => job.delivery?.kind === 'slack');
    const studio = subscriber('studio', job => job.source === 'studio');
    const t = setup([slack, studio]);
    const jobs = await t.createGroup(['succeeded', 'failed', 'succeeded'], { delivery: SLACK });

    const outcomes = [];
    for (const job of jobs) outcomes.push(await t.announce(job));

    expect(outcomes).toEqual(['announced', 'already_announced', 'already_announced']);
    expect(studio.deliver).not.toHaveBeenCalled();
    expect(slack.deliver).toHaveBeenCalledTimes(1);
    const completion = slack.deliver.mock.calls[0][0] as GroupCompletion;
    expect(completion).toMatchObject({ groupId: GROUP_ID, readyCount: 2, failedCount: 1, cancelledCount: 0 });
    expect(completion.members.map(member => member.id)).toEqual(jobs.map(job => job.id));
    expect(completion.anchor.id).toBe(jobs[0].id);
    expect(completion.completedAt).toEqual(NOW);
  });

  it('neither reads nor claims the group when no subscriber wants it', async () => {
    const t = setup([subscriber('studio', job => job.source === 'studio')]);
    const [job] = await t.createGroup(['succeeded']);
    const claim = vi.spyOn(t.repository, 'claimGroupCompletionNotice');

    expect(await t.announce(job)).toBe('no_audience');
    expect(claim).not.toHaveBeenCalled();
  });

  it('keeps delivering to the other channels when one fails, and logs the lost one', async () => {
    const failing = subscriber(
      'push',
      () => true,
      vi.fn(async () => Promise.reject(new Error('push down')))
    );
    const slack = subscriber('slack', () => true);
    const t = setup([failing, slack]);
    const [job] = await t.createGroup(['succeeded']);

    expect(await t.announce(job)).toBe('announced');
    expect(slack.deliver).toHaveBeenCalledTimes(1);
    expect(t.logger.error).toHaveBeenCalledWith(
      'group completion delivery failed',
      expect.objectContaining({ channel: 'push', groupId: GROUP_ID })
    );
  });

  it('waits while a group member is still running, without claiming', async () => {
    const studio = subscriber('studio', () => true);
    const t = setup([studio]);
    const [first] = await t.createGroup(['succeeded', 'running']);
    const claim = vi.spyOn(t.repository, 'claimGroupCompletionNotice');

    expect(await t.announce(first)).toBe('group_pending');
    expect(claim).not.toHaveBeenCalled();
    expect(studio.deliver).not.toHaveBeenCalled();
  });

  it('reports all_cancelled, without announcing, when every member was cancelled', async () => {
    const studio = subscriber('studio', () => true);
    const t = setup([studio]);
    const [job] = await t.createGroup(['cancelled', 'cancelled']);

    expect(await t.announce(job)).toBe('all_cancelled');
    expect(studio.deliver).not.toHaveBeenCalled();
  });

  it('delivers on no channel when another finisher already claimed the group', async () => {
    const push = subscriber('push', () => true);
    const slack = subscriber('slack', () => true);
    const t = setup([push, slack]);
    const [job] = await t.createGroup(['succeeded']);
    await t.repository.claimGroupCompletionNotice(job.id, NOW);

    expect(await t.announce(job)).toBe('already_announced');
    expect(push.deliver).not.toHaveBeenCalled();
    expect(slack.deliver).not.toHaveBeenCalled();
  });
});
