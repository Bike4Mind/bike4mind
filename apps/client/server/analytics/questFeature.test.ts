// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OVERWATCH_UNKNOWN_SESSION_ID } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ANALYTICS_EVENTS } from '@bike4mind/server-utils/types/analytics/index';

const { mockEmitProductEvent } = vi.hoisted(() => ({ mockEmitProductEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/analytics/emitActiveEvent')>()),
  emitProductEvent: mockEmitProductEvent,
}));

import {
  QUEST_FEATURE_METADATA_FIELDS,
  QUEST_FEATURE_THROTTLE_MAX,
  __resetQuestFeatureThrottle,
  forwardQuestFeature,
  hasRoundsAccess,
  questFeatureName,
} from './questFeature';
import { VISIT_COOKIE, mintVisitId } from './visitSession';

type QuestRequest = Parameters<typeof forwardQuestFeature>[0];

function request(user: object | undefined, extra: { cookie?: string; apiKeyInfo?: unknown } = {}): QuestRequest {
  return {
    user,
    apiKeyInfo: extra.apiKeyInfo,
    headers: extra.cookie === undefined ? {} : { cookie: extra.cookie },
  } as unknown as QuestRequest;
}

const player = { id: 'user-1', isAdmin: false, tags: ['rounds'] };
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const TEN_MINUTES = 10 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  mockEmitProductEvent.mockResolvedValue(undefined);
  __resetQuestFeatureThrottle();
});
afterEach(() => vi.restoreAllMocks());

describe('questFeatureName', () => {
  it.each([
    ['AI Image Generated', 'ai_image_generated'],
    ['Auto-Named Session Started', 'auto_named_session_started'],
    ['User API Key Rate Limit Reset', 'user_api_key_rate_limit_reset'],
    ['EMAIL_CHANGE_FAILED', 'email_change_failed'],
    ['billing_opened', 'billing_opened'],
    ['  Spaced -- out!  ', 'spaced_out'],
  ])('maps %j to %j', (type, feature) => {
    expect(questFeatureName(type)).toBe(feature);
  });

  it('gives every type the log-event route can accept its own feature, one a card can name', () => {
    const types = [...new Set<string>(Object.values(ANALYTICS_EVENTS))];
    const features = types.map(questFeatureName);
    for (const feature of features) {
      expect(QUEST_FEATURE_METADATA_FIELDS.feature.safeParse(feature).success, feature).toBe(true);
    }
    expect(new Set(features).size).toBe(types.length);
  });
});

describe('QUEST_FEATURE_METADATA_FIELDS', () => {
  it('declares feature as a card feature key: lowercase letters, digits and underscores, 64 at most', () => {
    const { feature } = QUEST_FEATURE_METADATA_FIELDS;
    expect(feature.safeParse('ai_image_generated').success).toBe(true);
    expect(feature.safeParse('a'.repeat(64)).success).toBe(true);
    expect(feature.safeParse('a'.repeat(65)).success).toBe(false);
    expect(feature.safeParse('').success).toBe(false);
    expect(feature.safeParse('AI Image Generated').success).toBe(false);
    expect(feature.safeParse('auto-named').success).toBe(false);
    expect(feature.safeParse('someone@example.com').success).toBe(false);
  });
});

describe('hasRoundsAccess', () => {
  it('refuses a request with no user', () => {
    expect(hasRoundsAccess(request(undefined))).toBe(false);
  });

  it('refuses an API key, even one whose owner carries the tag or is an admin', () => {
    expect(hasRoundsAccess(request(player, { apiKeyInfo: { id: 'key-1' } }))).toBe(false);
    expect(hasRoundsAccess(request({ id: 'a1', isAdmin: true, tags: [] }, { apiKeyInfo: { id: 'key-2' } }))).toBe(
      false
    );
  });

  it('refuses a user with neither the tag, a developer tag nor admin', () => {
    expect(hasRoundsAccess(request({ id: 'u2', isAdmin: false, tags: ['overwatch'] }))).toBe(false);
    expect(hasRoundsAccess(request({ id: 'u3' }))).toBe(false);
  });

  it('lets in the rounds tag, an admin and a developer', () => {
    expect(hasRoundsAccess(request(player))).toBe(true);
    expect(hasRoundsAccess(request({ id: 'a1', isAdmin: true, tags: [] }))).toBe(true);
    expect(hasRoundsAccess(request({ id: 'd1', isAdmin: false, tags: ['Developer'] }))).toBe(true);
    expect(hasRoundsAccess(request({ id: 'd2', isAdmin: false, tags: ['dev'] }))).toBe(true);
  });

  it('matches the rounds tag in any case, never trimmed, and developer tags case-sensitively', () => {
    expect(hasRoundsAccess(request({ id: 'u4', tags: ['Rounds'] }))).toBe(true);
    expect(hasRoundsAccess(request({ id: 'u5', tags: ['ROUNDS'] }))).toBe(true);
    expect(hasRoundsAccess(request({ id: 'u6', tags: [' rounds'] }))).toBe(false);
    expect(hasRoundsAccess(request({ id: 'u7', tags: ['rounds-beta'] }))).toBe(false);
    expect(hasRoundsAccess(request({ id: 'u8', tags: null }))).toBe(false);
    expect(hasRoundsAccess(request({ id: 'u9', tags: ['DEV'] }))).toBe(false);
  });
});

describe('forwardQuestFeature', () => {
  it("sends a Rounds player's action as quest_feature_used under the host product, the user and the visit", async () => {
    const visitId = mintVisitId();

    await forwardQuestFeature(request(player, { cookie: `${VISIT_COOKIE}=${visitId}` }), 'AI Image Generated', T0);

    expect(mockEmitProductEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitProductEvent).toHaveBeenCalledWith({
      productId: 'bike4mind',
      event: 'quest_feature_used',
      userId: 'user-1',
      sessionId: visitId,
      metadata: { feature: 'ai_image_generated', internal: true },
      metadataFields: QUEST_FEATURE_METADATA_FIELDS,
    });
  });

  it('names no visit when the request carries none of ours', async () => {
    await forwardQuestFeature(request(player), 'AI Image Generated', T0);
    await forwardQuestFeature(request(player, { cookie: `${VISIT_COOKIE}=forged` }), 'Session Created', T0);

    expect(mockEmitProductEvent.mock.calls.map(([opts]) => opts.sessionId)).toEqual([
      OVERWATCH_UNKNOWN_SESSION_ID,
      OVERWATCH_UNKNOWN_SESSION_ID,
    ]);
  });

  it('marks every event internal, and keeps the synthetic lane of a test persona', async () => {
    await forwardQuestFeature(request({ id: 'admin-1', isAdmin: true }), 'AI Image Generated', T0);
    await forwardQuestFeature(request({ ...player, id: 'persona-1', isSynthetic: true }), 'AI Image Generated', T0);

    expect(mockEmitProductEvent.mock.calls.map(([opts]) => opts.metadata)).toEqual([
      { feature: 'ai_image_generated', internal: true },
      { feature: 'ai_image_generated', lane: 'synthetic', internal: true },
    ]);
  });

  it('forwards nothing for a user without Rounds access, an anonymous request or an API key', async () => {
    await forwardQuestFeature(
      request({ id: 'customer-1', isAdmin: false, tags: ['overwatch'] }),
      'Notebook Cloned',
      T0
    );
    await forwardQuestFeature(request(undefined), 'Notebook Cloned', T0);
    await forwardQuestFeature(request(player, { apiKeyInfo: { id: 'key-1' } }), 'Notebook Cloned', T0);

    expect(mockEmitProductEvent).not.toHaveBeenCalled();
  });

  it('forwards nothing for a type that gives no feature a card can name', async () => {
    await forwardQuestFeature(request(player), ' -- ', T0);
    await forwardQuestFeature(request(player), 'x'.repeat(65), T0);

    expect(mockEmitProductEvent).not.toHaveBeenCalled();
  });

  it('sends a feature once per user per ten minutes', async () => {
    const other = { ...player, id: 'user-2' };

    await forwardQuestFeature(request(player), 'AI Image Generated', T0);
    await forwardQuestFeature(request(player), 'AI Image Generated', T0 + 1);
    await forwardQuestFeature(request(player), 'AI Image Generated', T0 + TEN_MINUTES - 1);
    expect(mockEmitProductEvent).toHaveBeenCalledTimes(1);

    await forwardQuestFeature(request(player), 'Session Created', T0 + 1);
    await forwardQuestFeature(request(other), 'AI Image Generated', T0 + 1);
    expect(mockEmitProductEvent).toHaveBeenCalledTimes(3);

    await forwardQuestFeature(request(player), 'AI Image Generated', T0 + TEN_MINUTES);
    expect(mockEmitProductEvent).toHaveBeenCalledTimes(4);
    await forwardQuestFeature(request(player), 'AI Image Generated', T0 + TEN_MINUTES + 1);
    expect(mockEmitProductEvent).toHaveBeenCalledTimes(4);
  });

  it('keeps the throttle bounded: a full map drops its oldest entry', async () => {
    for (let i = 0; i < QUEST_FEATURE_THROTTLE_MAX; i++) {
      await forwardQuestFeature(request(player), `feature ${i}`, T0);
    }
    await forwardQuestFeature(request(player), 'one more', T0);
    expect(mockEmitProductEvent).toHaveBeenCalledTimes(QUEST_FEATURE_THROTTLE_MAX + 1);

    await forwardQuestFeature(request(player), 'feature 500', T0 + 1);
    expect(mockEmitProductEvent).toHaveBeenCalledTimes(QUEST_FEATURE_THROTTLE_MAX + 1);
    await forwardQuestFeature(request(player), 'feature 0', T0 + 1);
    expect(mockEmitProductEvent).toHaveBeenCalledTimes(QUEST_FEATURE_THROTTLE_MAX + 2);
  });

  it('counts a feature sent again as the newest entry, so a full map drops an older one first', async () => {
    const later = T0 + TEN_MINUTES;
    await forwardQuestFeature(request(player), 'AI Image Generated', T0);
    await forwardQuestFeature(request(player), 'Session Created', T0);
    await forwardQuestFeature(request(player), 'AI Image Generated', later);
    // Two entries are held; fill the map, then one more drops the oldest.
    for (let i = 0; i < QUEST_FEATURE_THROTTLE_MAX - 1; i++) {
      await forwardQuestFeature(request(player), `feature ${i}`, later);
    }
    expect(mockEmitProductEvent).toHaveBeenCalledTimes(QUEST_FEATURE_THROTTLE_MAX + 2);

    await forwardQuestFeature(request(player), 'AI Image Generated', later + 1);
    expect(mockEmitProductEvent).toHaveBeenCalledTimes(QUEST_FEATURE_THROTTLE_MAX + 2);
  });

  it('logs and swallows a failed emit', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    mockEmitProductEvent.mockRejectedValueOnce(new Error('ingest down'));

    await expect(forwardQuestFeature(request(player), 'AI Image Generated', T0)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[b4m-analytics] quest feature not forwarded', { error: 'ingest down' });
  });

  it('logs and swallows a malformed user rather than throwing', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(
      forwardQuestFeature(request({ id: 'user-3', tags: 'rounds' }), 'AI Image Generated', T0)
    ).resolves.toBeUndefined();
    expect(mockEmitProductEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
