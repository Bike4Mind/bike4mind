import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IQuestNodeDocument } from '@bike4mind/common';

const findByQuestIds = vi.fn();
const linkArtifacts = vi.fn();

vi.mock('@bike4mind/database', () => ({
  artifactRepository: { findByQuestIds: (...a: unknown[]) => findByQuestIds(...a) },
  questNodeRepository: { linkArtifacts: (...a: unknown[]) => linkArtifacts(...a) },
}));

const { linkNodeArtifacts } = await import('./linkNodeArtifacts');

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const node = (over: Partial<IQuestNodeDocument> & { id: string }): IQuestNodeDocument =>
  ({
    graphId: 'g1',
    dependsOn: [],
    order: 0,
    depth: 0,
    kind: 'task',
    title: 't',
    task: 'do it',
    status: 'completed',
    enabledTools: [],
    artifactIds: [],
    execution: { agentExecutionId: 'exec-1' },
    ...over,
  }) as IQuestNodeDocument;

type Runs = Parameters<typeof linkNodeArtifacts>[1];
const runs = (entries: Array<[string, string | null]>): Runs =>
  new Map(
    entries.map(([execId, questId]) => [
      execId,
      {
        id: execId,
        questId,
        status: 'completed',
        answer: 'a',
        totalIterations: 1,
        totalCreditsUsed: 1,
        errorMessage: null,
        completedAt: null,
      },
    ])
  ) as Runs;

const artifact = (id: string, sourceQuestId: string) => ({ id, type: 'react', title: id, sourceQuestId });

describe('linkNodeArtifacts', () => {
  beforeEach(() => {
    findByQuestIds.mockReset().mockResolvedValue([]);
    linkArtifacts.mockReset().mockResolvedValue(undefined);
  });

  it('does not query when no node has a run', async () => {
    await linkNodeArtifacts([node({ id: 'n1', execution: undefined })], runs([]), logger);
    expect(findByQuestIds).not.toHaveBeenCalled();
  });

  it('attaches a run artifact to its node and returns it for display', async () => {
    findByQuestIds.mockResolvedValue([artifact('art-1', 'quest-1')]);

    const result = await linkNodeArtifacts([node({ id: 'n1' })], runs([['exec-1', 'quest-1']]), logger);

    expect(linkArtifacts).toHaveBeenCalledWith('n1', ['art-1']);
    expect(result.get('n1')).toEqual([{ id: 'art-1', type: 'react', title: 'art-1' }]);
  });

  // One batched query for the whole graph: this runs on a polled endpoint, so a
  // per-node lookup would be an N+1.
  it('queries once for the whole graph, de-duplicating quest ids', async () => {
    await linkNodeArtifacts(
      [
        node({ id: 'n1', execution: { agentExecutionId: 'exec-1' } }),
        node({ id: 'n2', execution: { agentExecutionId: 'exec-2' } }),
      ],
      runs([
        ['exec-1', 'quest-1'],
        ['exec-2', 'quest-1'],
      ]),
      logger
    );

    expect(findByQuestIds).toHaveBeenCalledTimes(1);
    expect(findByQuestIds).toHaveBeenCalledWith(['quest-1']);
  });

  it('writes nothing when the node already carries the artifact', async () => {
    findByQuestIds.mockResolvedValue([artifact('art-1', 'quest-1')]);

    const result = await linkNodeArtifacts(
      [node({ id: 'n1', artifactIds: ['art-1'] })],
      runs([['exec-1', 'quest-1']]),
      logger
    );

    expect(linkArtifacts).not.toHaveBeenCalled();
    expect(result.get('n1')).toHaveLength(1); // still rendered
  });

  it('adds only the artifacts the node is missing', async () => {
    findByQuestIds.mockResolvedValue([artifact('art-1', 'quest-1'), artifact('art-2', 'quest-1')]);

    await linkNodeArtifacts([node({ id: 'n1', artifactIds: ['art-1'] })], runs([['exec-1', 'quest-1']]), logger);

    expect(linkArtifacts).toHaveBeenCalledWith('n1', ['art-2']);
  });

  // Artifacts are an enrichment; the graph must stay readable without them.
  it('returns empty and does not throw when the lookup fails', async () => {
    findByQuestIds.mockRejectedValue(new Error('mongo down'));

    const result = await linkNodeArtifacts([node({ id: 'n1' })], runs([['exec-1', 'quest-1']]), logger);

    expect(result.size).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('still renders the artifact when only the node write fails', async () => {
    findByQuestIds.mockResolvedValue([artifact('art-1', 'quest-1')]);
    linkArtifacts.mockRejectedValue(new Error('write failed'));

    const result = await linkNodeArtifacts([node({ id: 'n1' })], runs([['exec-1', 'quest-1']]), logger);

    expect(result.get('n1')).toHaveLength(1);
  });

  // The run reached a terminal state before persistRunAsQuest wrote anything.
  it('is a no-op when the run has no quest id yet', async () => {
    await linkNodeArtifacts([node({ id: 'n1' })], runs([['exec-1', null]]), logger);
    expect(findByQuestIds).not.toHaveBeenCalled();
  });
});
