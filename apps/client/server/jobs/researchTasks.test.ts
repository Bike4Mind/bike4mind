import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendToQueueMock, sendToClientMock } = vi.hoisted(() => ({
  sendToQueueMock: vi.fn(),
  sendToClientMock: vi.fn(),
}));

vi.mock('@server/utils/sqs', () => ({ sendToQueue: sendToQueueMock }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: sendToClientMock }));
// Local sst mock: the enqueue must resolve the queue via Resource.researchEngineQueue.url
// (self-host shim resolvable), NOT getSourceQueueUrl (which throws under the shim).
vi.mock('sst', () => ({
  Resource: {
    researchEngineQueue: { url: 'http://sqs:9324/000000000000/researchEngineQueue' },
    websocket: { managementEndpoint: 'http://ws:3001' },
  },
}));

const { researchTaskJobs } = await import('./researchTasks');

const QUEUE = 'http://sqs:9324/000000000000/researchEngineQueue';

describe('researchTaskJobs enqueue (self-host resolvable queue URL)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendToQueueMock.mockResolvedValue('msg-1');
  });

  it('process() enqueues to the research queue URL without throwing', async () => {
    await expect(researchTaskJobs.process('r1', 'u1')).resolves.toBeUndefined();
    expect(sendToQueueMock).toHaveBeenCalledWith(QUEUE, { action: 'process', payload: { id: 'r1', userId: 'u1' } });
  });

  it('processDiscoveredLinks() enqueues to the research queue URL', async () => {
    await researchTaskJobs.processDiscoveredLinks('r1', 'u1');
    expect(sendToQueueMock).toHaveBeenCalledWith(QUEUE, {
      action: 'processDiscoveredLinks',
      payload: { id: 'r1', userId: 'u1' },
    });
  });

  it('downloadRelevantLinks() enqueues to the research queue URL', async () => {
    await researchTaskJobs.downloadRelevantLinks('r1', 'u1');
    expect(sendToQueueMock).toHaveBeenCalledWith(QUEUE, {
      action: 'downloadRelevantLinks',
      payload: { id: 'r1', userId: 'u1' },
    });
  });
});
