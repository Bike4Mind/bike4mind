import * as common from '@bike4mind/common';
import { AuthEvents, FirstRunEvents, LLMEvents, UserApiKeyEvents } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { categorizeEvent, EVENT_ENUM_CATEGORIES, OTHER_CATEGORY } from './categorizeEvent';

// *Events enums that are not analytics counters, so they never reach the dashboard.
const NON_ANALYTICS_EVENT_ENUMS = new Set(['SecretAuditEvents']);

describe('categorizeEvent', () => {
  it('categorizes every analytics event enum value as something other than Other', () => {
    const uncategorized = EVENT_ENUM_CATEGORIES.flatMap(([events]) => Object.values(events)).filter(
      eventName => categorizeEvent(eventName) === OTHER_CATEGORY
    );

    expect(uncategorized).toEqual([]);
  });

  it('covers every *Events enum exported by @bike4mind/common', () => {
    const mappedEnums = new Set<unknown>(EVENT_ENUM_CATEGORIES.map(([events]) => events));
    const unmapped = Object.entries(common)
      .filter(([name, value]) => name.endsWith('Events') && typeof value === 'object' && value !== null)
      .filter(([name, value]) => !NON_ANALYTICS_EVENT_ENUMS.has(name) && !mappedEnums.has(value))
      .map(([name]) => name);

    expect(unmapped).toEqual([]);
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
  });

  it('falls back to Other for an unknown event name', () => {
    expect(categorizeEvent('Not A Real Event')).toBe(OTHER_CATEGORY);
  });
});
