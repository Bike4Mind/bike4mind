import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { RapidReplyResultModel, rapidReplyResultRepository } from './RapidReplyResultModel';

describe('RapidReplyResultRepository failure logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the quest id and error on create failure, not the document body', async () => {
    const failure = new Error('write failed');
    vi.spyOn(RapidReplyResultModel, 'create').mockRejectedValueOnce(failure as never);
    const errorLog = vi.spyOn(Logger, 'error').mockImplementation(() => {});

    const result = await rapidReplyResultRepository.createResult({
      questId: 'quest-1',
      replyText: 'a secret user prompt',
    } as never);

    expect(result).toBeNull();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(expect.any(String), { questId: 'quest-1', error: failure });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret user prompt');
  });

  it('logs the quest id and error on update failure, not the document body', async () => {
    const failure = new Error('write failed');
    vi.spyOn(RapidReplyResultModel, 'findOneAndUpdate').mockRejectedValueOnce(failure as never);
    const errorLog = vi.spyOn(Logger, 'error').mockImplementation(() => {});

    const result = await rapidReplyResultRepository.updateResultByQuestId('quest-1', {
      replyText: 'a secret user prompt',
    } as never);

    expect(result).toBeNull();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(expect.any(String), { questId: 'quest-1', error: failure });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret user prompt');
  });
});
