import type { EndpointDeprecation } from './types';

const utcMidnight = (isoDate: string): Date => new Date(`${isoDate}T00:00:00Z`);

/**
 * The response headers a deprecated endpoint sends: RFC 9745 `Deprecation`
 * (`@` + Unix seconds), RFC 8594 `Sunset` (an HTTP-date) and, when there is a
 * replacement, an RFC 8288 `Link` to it. The Next adapter sets these and
 * registerContract documents them, so both read from here.
 */
export function deprecationHeaders({ since, sunset, successor }: EndpointDeprecation): Record<string, string> {
  return {
    Deprecation: `@${utcMidnight(since).getTime() / 1000}`,
    Sunset: utcMidnight(sunset).toUTCString(),
    ...(successor && { Link: `<${successor}>; rel="successor-version"` }),
  };
}

/** The sentence a deprecated operation's published description leads with (CONVENTIONS.md section 7). */
export function deprecationNotice({ sunset, successor }: EndpointDeprecation): string {
  return `**Deprecated, sunset ${sunset}.**` + (successor ? ` Use \`${successor}\` instead.` : '');
}
