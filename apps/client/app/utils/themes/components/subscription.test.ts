import { describe, it, expect } from 'vitest';
import { subscriptionTheme } from './subscription';

describe('subscriptionTheme', () => {
  it.each(['dark', 'light'] as const)('gives the credits modal a visible icon color in %s mode', mode => {
    const { iconFill } = subscriptionTheme[mode].creditsModal;
    expect(iconFill).toBeTruthy();
    expect(iconFill).not.toBe('transparent');
  });
});
