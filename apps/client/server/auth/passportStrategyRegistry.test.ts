import { describe, it, expect } from 'vitest';
import passport from 'passport';
import { isPassportStrategyRegistered } from './passportStrategyRegistry';

describe('isPassportStrategyRegistered', () => {
  it('reports only the strategies registered with the authenticator', () => {
    const authenticator = new passport.Authenticator();
    authenticator.use('google', { name: 'google', authenticate: () => undefined } as unknown as passport.Strategy);

    expect(isPassportStrategyRegistered(authenticator, 'google')).toBe(true);
    expect(isPassportStrategyRegistered(authenticator, 'apple')).toBe(false);
  });

  it('does not report names inherited from Object.prototype', () => {
    const authenticator = new passport.Authenticator();

    expect(isPassportStrategyRegistered(authenticator, 'constructor')).toBe(false);
    expect(isPassportStrategyRegistered(authenticator, 'toString')).toBe(false);
  });

  it('throws when the authenticator exposes no strategy lookup', () => {
    const bare = {};

    expect(() => isPassportStrategyRegistered(bare, 'google')).toThrow('no strategy lookup');
  });
});
