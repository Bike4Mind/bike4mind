import { describe, expect, it, vi } from 'vitest';
import {
  buildModerationEscalationMessage,
  handleModerationEscalation,
  type ModerationEscalation,
  type ModerationEscalationDeps,
} from './moderationEscalationAlert';

vi.mock('sst', () => ({ Resource: { App: { stage: 'production' } } }));
vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));

const USER_ID = '0123456789abcdef01234567';
const DAY_MS = 24 * 60 * 60 * 1000;

const severeAlert: ModerationEscalation = {
  userId: USER_ID,
  reasons: ['severe_category'],
  categories: ['sexual', 'sexual/minors'],
  source: 'openai',
  hitsInWindow: 2,
};

const makeLogger = () => ({ warn: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() });

const makeDeps = (overrides: Partial<ModerationEscalationDeps> = {}): ModerationEscalationDeps => ({
  resolveAccount: vi.fn().mockResolvedValue({ ageMs: 3 * DAY_MS, funding: 'granted' }),
  post: vi.fn().mockResolvedValue(undefined),
  readMention: vi.fn().mockResolvedValue(undefined),
  stage: 'production',
  appUrl: 'https://app.example.com',
  ...overrides,
});

const textOf = (message: ReturnType<typeof buildModerationEscalationMessage>) => JSON.stringify(message);

describe('buildModerationEscalationMessage', () => {
  it('pages for a severe hit with categories, 24h count, account facts and admin links', () => {
    const message = buildModerationEscalationMessage({
      alert: severeAlert,
      account: { ageMs: 3 * DAY_MS, funding: 'granted' },
      stage: 'production',
      appUrl: 'https://app.example.com',
    });
    const text = textOf(message);

    expect(message.text).toContain('Severe moderation hit');
    expect(text).toContain('sexual, sexual/minors');
    expect(text).toContain('*Hits in 24h*\\n2');
    expect(text).toContain('3 d old, free (granted credits only)');
    expect(text).toContain(`https://app.example.com/admin/users/${USER_ID}`);
    expect(text).toContain('tab=text-moderation-review');
  });

  it('warns, not pages, for a suspend_pending transition', () => {
    const pending = buildModerationEscalationMessage({
      alert: { ...severeAlert, reasons: ['suspend_pending'], categories: ['hate'], hitsInWindow: 5 },
      account: { ageMs: 400 * DAY_MS, funding: 'subscription' },
      stage: 'production',
      appUrl: 'https://app.example.com',
    });
    const severe = buildModerationEscalationMessage({
      alert: severeAlert,
      account: null,
      stage: 'production',
      appUrl: 'https://app.example.com',
    });

    expect(pending.text).toContain('User pending suspension');
    expect(textOf(pending)).toContain('paid (subscription)');
    expect(pending.attachments?.[0].color).not.toEqual(severe.attachments?.[0].color);
  });

  it('titles an alert that is both severe and pending suspension for both', () => {
    const message = buildModerationEscalationMessage({
      alert: { ...severeAlert, reasons: ['suspend_pending', 'severe_category'] },
      account: null,
      stage: 'production',
      appUrl: 'https://app.example.com',
    });

    expect(message.text).toContain('Severe moderation hit; user pending suspension');
  });

  it('names the flagging source and omits the buttons without an app url', () => {
    const message = buildModerationEscalationMessage({
      alert: { ...severeAlert, source: 'provider' },
      account: null,
      stage: 'production',
      appUrl: undefined,
    });
    const text = textOf(message);

    expect(text).toContain('Provider refusal');
    expect(text).not.toContain('Open user');
    expect(text).not.toContain('Review list');
  });

  it('says the account is unavailable when the lookup failed', () => {
    const message = buildModerationEscalationMessage({
      alert: severeAlert,
      account: null,
      stage: 'production',
      appUrl: undefined,
    });

    expect(textOf(message)).toContain('*Account*\\nunavailable');
  });
});

describe('handleModerationEscalation', () => {
  it('posts one message per event', async () => {
    const deps = makeDeps();

    await handleModerationEscalation(severeAlert, deps, makeLogger());

    expect(deps.resolveAccount).toHaveBeenCalledWith(USER_ID, expect.any(Date));
    expect(deps.post).toHaveBeenCalledTimes(1);
  });

  it('still posts when the account lookup fails', async () => {
    const logger = makeLogger();
    const deps = makeDeps({ resolveAccount: vi.fn().mockRejectedValue(new Error('mongo down')) });

    await handleModerationEscalation(severeAlert, deps, logger);

    expect(deps.post).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('moderation-escalation-account-context-failed', { error: 'mongo down' });
  });

  it('posts without the account line when the lookup hangs past the timeout', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ resolveAccount: vi.fn().mockReturnValue(new Promise(() => undefined)) });
      const logger = makeLogger();

      const handled = handleModerationEscalation(severeAlert, deps, logger);
      await vi.advanceTimersByTimeAsync(5_000);
      await handled;

      expect(deps.post).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith('moderation-escalation-account-context-failed', {
        error: 'timed out after 5000 ms',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when the mention lookup fails, so the event bus retries it', async () => {
    const deps = makeDeps({ readMention: vi.fn().mockRejectedValue(new Error('ssm down')) });

    await expect(handleModerationEscalation(severeAlert, deps, makeLogger())).rejects.toThrow('ssm down');
    expect(deps.post).not.toHaveBeenCalled();
  });

  it('drops a malformed event without posting', async () => {
    const logger = makeLogger();
    const deps = makeDeps();

    await handleModerationEscalation({ userId: USER_ID, reasons: [] }, deps, logger);

    expect(deps.post).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('moderation.escalation event malformed; dropping', expect.any(Object));
  });

  it('throws when the post fails, so the event bus retries it', async () => {
    const deps = makeDeps({ post: vi.fn().mockRejectedValue(new Error('Slack webhook failed: 500')) });

    await expect(handleModerationEscalation(severeAlert, deps, makeLogger())).rejects.toThrow('Slack webhook failed');
  });
});
