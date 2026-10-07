import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IQuestGraphDocument } from '@bike4mind/common';

const { linkNodeArtifacts } = vi.hoisted(() => ({ linkNodeArtifacts: vi.fn() }));

vi.mock('./linkNodeArtifacts', () => ({ linkNodeArtifacts }));
vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: { findRunSummariesByIds: vi.fn().mockResolvedValue([]) },
  questNodeRepository: { getNodes: vi.fn().mockResolvedValue([]) },
  isNodeReady: vi.fn(),
  isNodeRunnable: vi.fn(),
}));
vi.mock('./reconcileQuestNodes', () => ({ reconcileQuestNodes: vi.fn().mockResolvedValue([]) }));
vi.mock('./wire', () => ({ toQuestGraphWire: vi.fn(() => ({})), toQuestNodeWire: vi.fn() }));

import { loadGraphDetail } from './loadGraphDetail';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('loadGraphDetail', () => {
  beforeEach(() => {
    linkNodeArtifacts.mockReset().mockResolvedValue(new Map());
  });

  it("scopes node artifacts to the graph owner's id", async () => {
    await loadGraphDetail({ id: 'g1', userId: 'owner-1' } as IQuestGraphDocument, logger);

    expect(linkNodeArtifacts).toHaveBeenCalledWith([], expect.any(Map), 'owner-1', logger);
  });
});
