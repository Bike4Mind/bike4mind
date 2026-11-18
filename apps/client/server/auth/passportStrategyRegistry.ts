type StrategyLookup = { _strategy(name: string): unknown };

function hasStrategyLookup(authenticator: unknown): authenticator is StrategyLookup {
  return (
    typeof authenticator === 'object' &&
    authenticator !== null &&
    typeof (authenticator as { _strategy?: unknown })._strategy === 'function'
  );
}

/**
 * Whether `name` is registered with passport, i.e. whether passport.authenticate(name) can run
 * rather than throw "Unknown authentication strategy". Providers are registered only when their
 * credentials are configured (server/auth/auth.ts), so this is the one availability check the
 * /api/auth/[strategy] start and callback routes share.
 *
 * Reads passport's `_strategy` lookup, which its own authenticate middleware uses but its typings
 * omit. Throws if that lookup is ever missing, so a passport upgrade fails loudly here.
 */
// `unknown` rather than passport's Authenticator: the PassportStatic default export does not
// satisfy Authenticator's generic parameters, and the guard below narrows it anyway.
export function isPassportStrategyRegistered(authenticator: unknown, name: string): boolean {
  if (!hasStrategyLookup(authenticator)) {
    throw new Error('passport authenticator exposes no strategy lookup');
  }
  // passport keeps strategies in a plain object, so an inherited key like 'constructor' is not a strategy.
  const strategy = authenticator._strategy(name) as { authenticate?: unknown } | undefined;
  return typeof strategy?.authenticate === 'function';
}
