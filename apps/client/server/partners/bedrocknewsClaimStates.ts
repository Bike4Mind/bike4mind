import { Logger } from '@bike4mind/observability';

// A bad partner key or missing config is ours to fix; the browser only ever sees "unavailable".
export function warnIfOperatorFault(route: string, code: string) {
  if (code === 'PARTNER_KEY_INVALID' || code === 'NOT_CONFIGURED') {
    Logger.warn(`[partners] bedrocknews claim ${route} cannot reach BedrockNews`, { code });
  }
}
