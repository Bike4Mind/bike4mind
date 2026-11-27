/**
 * Request-line exposure policy for the admin WAF views, the counterpart of wafHeaderRedaction.ts.
 *
 * A WAF log record holds the request line as the client sent it. These views serve it under the
 * same policy as the application's own request logs (middlewares/requestLogUrl.ts), so the list of
 * token-bearing routes lives in one place and a route added there is covered here too.
 */
import { requestLogUrl } from '../middlewares/requestLogUrl';

/** WAF logs the path (`uri`) and the query string (`args`, no leading `?`) as separate fields. */
export function maskWafRequestLine(uri: string, args: string): { uri: string; args: string } {
  const masked = requestLogUrl(args ? `${uri}?${args}` : uri);
  const cut = masked.indexOf('?');
  return cut === -1 ? { uri: masked, args: '' } : { uri: masked.slice(0, cut), args: masked.slice(cut + 1) };
}

export function maskWafRequestUri(uri: string): string {
  return maskWafRequestLine(uri, '').uri;
}
