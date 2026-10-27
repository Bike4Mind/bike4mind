import { AuthEvents, FirstRunEvents, LLMEvents, UserApiKeyEvents } from '@bike4mind/common';
import { ANALYTICS_EVENTS } from '@bike4mind/server-utils/types/analytics/index';
import { EmailAuditEvents } from '@bike4mind/server-utils/utils/auditLogEvents';
import { describe, expect, it } from 'vitest';
import { categorizeEvent, EVENT_CATEGORIES, EVENT_ENUM_CATEGORIES, OTHER_CATEGORY } from './categorizeEvent';

describe('categorizeEvent', () => {
  // ANALYTICS_EVENTS is the logEvent allowlist, so it is every name that can reach CounterLog.
  it('categorizes every loggable analytics event as something other than Other', () => {
    const uncategorized = Object.values(ANALYTICS_EVENTS).filter(
      eventName => categorizeEvent(eventName) === OTHER_CATEGORY
    );

    expect(uncategorized).toEqual([]);
  });

  it('never gives one event name two different categories', () => {
    const categoriesByName = new Map<string, Set<string>>();
    for (const [events, category] of EVENT_ENUM_CATEGORIES) {
      for (const eventName of Object.values(events)) {
        categoriesByName.set(eventName, (categoriesByName.get(eventName) ?? new Set()).add(category));
      }
    }
    const conflicting = [...categoriesByName].filter(([, categories]) => categories.size > 1).map(([name]) => name);

    expect(conflicting).toEqual([]);
  });

  it('categorizes events the old substring matching sent to Other', () => {
    expect(categorizeEvent(LLMEvents.QUEUE_HANDLER_START_MODEL)).toBe('LLM');
    expect(categorizeEvent(AuthEvents.REGISTER)).toBe('Auth');
    expect(categorizeEvent(FirstRunEvents.WELCOME_CARD_SHOWN)).toBe('Onboarding');
    expect(categorizeEvent(UserApiKeyEvents.USED)).toBe('API Keys');
    expect(categorizeEvent(EmailAuditEvents.EMAIL_VERIFICATION_SENT)).toBe('Audit');
  });

  it('lists every category once for the filter, with Other last', () => {
    expect(new Set(EVENT_CATEGORIES).size).toBe(EVENT_CATEGORIES.length);
    expect(EVENT_CATEGORIES).toEqual(expect.arrayContaining(['Slack', 'Onboarding', 'Audit']));
    expect(EVENT_CATEGORIES.at(-1)).toBe(OTHER_CATEGORY);
  });

  it('falls back to Other for an unknown event name', () => {
    expect(categorizeEvent('Not A Real Event')).toBe(OTHER_CATEGORY);
  });
});
