import { describe, it, expect, vi } from 'vitest';
import { AutoNameSessionFeature } from './ChatCompletionFeatures';

const makeFeature = () => {
  const autoNameSession = vi.fn().mockResolvedValue(null);
  const context = {
    logger: { info: vi.fn(), error: vi.fn() },
    user: { id: 'user-A' },
    userAbility: {},
    autoNameSession,
    logEvent: vi.fn().mockResolvedValue(undefined),
  };
  const feature = new AutoNameSessionFeature(context as never, 1);
  return { feature, autoNameSession };
};

const complete = (feature: AutoNameSessionFeature, prompt: string, session: Record<string, unknown> = {}) =>
  feature.onComplete({
    quest: { id: 'quest-1', prompt, fabFileIds: [] } as never,
    session: { id: 'session-1', ...session } as never,
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: 'Hi! How can I help?' },
    ] as never,
  });

describe('AutoNameSessionFeature after-reply fallback', () => {
  it('publishes for an unnamed notebook whose turn has substance', async () => {
    const { feature, autoNameSession } = makeFeature();

    await complete(feature, 'Plan a three-day trip to Kyoto');

    expect(autoNameSession).toHaveBeenCalledWith('session-1', expect.anything());
  });

  it('skips a low-signal turn so the notebook is not titled from a greeting', async () => {
    const { feature, autoNameSession } = makeFeature();

    await complete(feature, 'Hello');

    expect(autoNameSession).not.toHaveBeenCalled();
  });
});
