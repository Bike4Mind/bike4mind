import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendToQueueMock, sendToClientMock, getSourceQueueUrlMock } = vi.hoisted(() => ({
  sendToQueueMock: vi.fn(),
  sendToClientMock: vi.fn(),
  getSourceQueueUrlMock: vi.fn(),
}));

vi.mock('@server/utils/sqs', () => ({ sendToQueue: sendToQueueMock }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: sendToClientMock }));
// Enqueue resolves the queue via getSourceQueueUrl - one mechanism, hosted + self-host
// (the self-host Resource shim now backs sourceQueueUrls from env, see @bike4mind/resource).
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: getSourceQueueUrlMock }));

const { researchTaskJobs } = await import('./researchTasks');

const QUEUE = 'http://sqs:9324/000000000000/researchEngineQueue';

describe('researchTaskJobs enqueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSourceQueueUrlMock.mockReturnValue(QUEUE);
    sendToQueueMock.mockResolvedValue('msg-1');
  });

  it('process() resolves the research queue via getSourceQueueUrl and enqueues', async () => {
    await expect(researchTaskJobs.process('r1', 'u1')).resolves.toBeUndefined();
    expect(getSourceQueueUrlMock).toHaveBeenCalledWith('researchEngineQueue');
    expect(sendToQueueMock).toHaveBeenCalledWith(QUEUE, { action: 'process', payload: { id: 'r1', userId: 'u1' } });
  });

  it('processDiscoveredLinks() enqueues to the research queue', async () => {
    await researchTaskJobs.processDiscoveredLinks('r1', 'u1');
    expect(sendToQueueMock).toHaveBeenCalledWith(QUEUE, {
      action: 'processDiscoveredLinks',
      payload: { id: 'r1', userId: 'u1' },
    });
  });

  it('downloadRelevantLinks() enqueues to the research queue', async () => {
    await researchTaskJobs.downloadRelevantLinks('r1', 'u1');
    expect(sendToQueueMock).toHaveBeenCalledWith(QUEUE, {
      action: 'downloadRelevantLinks',
      payload: { id: 'r1', userId: 'u1' },
    });
  });
});
