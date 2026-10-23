import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAudit } = vi.hoisted(() => ({ createAudit: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ toolExecutionLogRepository: { create: createAudit } }));

import { runAuditedTool } from './runAuditedTool';

const logger = { error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  createAudit.mockResolvedValue(undefined);
});

describe('runAuditedTool', () => {
  it('finishes the audit before returning the tool result', async () => {
    const gate: { release?: () => void } = {};
    createAudit.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          gate.release = resolve;
        })
    );
    const finished = vi.fn();
    const result = runAuditedTool('web_search', 'user-1', logger, async () => 'answer');
    void result.then(finished);

    await vi.waitFor(() => expect(createAudit).toHaveBeenCalledOnce());
    expect(finished).not.toHaveBeenCalled();
    gate.release!();

    await expect(result).resolves.toBe('answer');
    expect(createAudit).toHaveBeenCalledWith(expect.objectContaining({ success: true, toolName: 'web_search' }));
  });

  it('preserves the tool result when the audit fails', async () => {
    const error = new Error('audit database unavailable');
    createAudit.mockRejectedValue(error);

    await expect(runAuditedTool('weather_info', 'user-1', logger, async () => 'sunny')).resolves.toBe('sunny');
    expect(logger.error).toHaveBeenCalledWith('Failed to write tool audit log:', error);
  });

  it('preserves the original tool failure when its audit also fails', async () => {
    const providerError = new Error('provider unavailable');
    createAudit.mockRejectedValue(new Error('audit database unavailable'));

    await expect(
      runAuditedTool('web_fetch', 'user-1', logger, async () => {
        throw providerError;
      })
    ).rejects.toBe(providerError);
    expect(createAudit).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: providerError.message }));
  });
});
