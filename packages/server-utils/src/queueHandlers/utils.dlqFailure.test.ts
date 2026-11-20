import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ record: vi.fn(), error: vi.fn(), warn: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ connectDB: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    withMetadata() {
      return this;
    }
    error = h.error;
    warn = h.warn;
  },
}));
vi.mock('../utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://localhost', STAGE: 'test' } }));
vi.mock('../utils/logger', () => ({ contextToLogs: () => ({}) }));
vi.mock('../services/gears/toolGearObserver', () => ({ registerToolGearObserver: vi.fn() }));
vi.mock('./dlqFailure', () => ({ recordFinalDlqFailures: h.record }));

import { dispatchWithLogger } from './utils';

describe('shared queue wrapper DLQ recording', () => {
  it('rethrows the original failure even when the record write fails', async () => {
    const original = new Error('handler failed');
    h.record.mockRejectedValueOnce(new Error('database unavailable'));
    const event = { Records: [{ messageId: 'm1' }] } as never;
    const context = {} as never;
    const dispatch = dispatchWithLogger(async () => {
      throw original;
    });
    await expect(dispatch(event, context)).rejects.toBe(original);
    expect(h.record).toHaveBeenCalledWith(event, original);
    expect(h.warn).toHaveBeenCalledOnce();
    expect(h.error).toHaveBeenCalledWith(original);
  });
});
