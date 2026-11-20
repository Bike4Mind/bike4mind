import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ connect: vi.fn(), bootstrap: vi.fn(), count: vi.fn(), noise: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  mongoose: { connect: state.connect },
  connectDB: state.bootstrap,
  countNewFeedback: state.count,
}));
vi.mock('sst', () => ({
  Resource: { App: { stage: 'review' }, MONGODB_URI: { value: 'mongodb://example.test/%STAGE%' } },
}));
vi.mock('./feedbackTriageNoise', () => ({ countTriageNoise: state.noise }));
import { main } from './preview-feedback-triage-noise';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('read-only feedback triage preview', () => {
  it('connects without schema writes or catalog bootstrap and only counts', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    state.count.mockResolvedValue(12);
    state.noise.mockResolvedValue({ waitlistSignups: 2 });
    await main();
    expect(state.connect).toHaveBeenCalledExactlyOnceWith('mongodb://example.test/review', {
      autoIndex: false,
      autoCreate: false,
    });
    expect(state.bootstrap).not.toHaveBeenCalled();
    expect(state.count).toHaveBeenCalledOnce();
    expect(state.noise).toHaveBeenCalledTimes(2);
  });
});
