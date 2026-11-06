import type { ISubscriberSignupNetwork, SubscriberSuspiciousReason } from '@bike4mind/common';
// The characters a spreadsheet reads as the start of a formula; the CSV exporters guard the same set.
import { SLACK_CSV_FORMULA_PREFIX } from '@bike4mind/server-utils/integrations/slack/slackExportCsv';
import { truncateIp } from '@bike4mind/server-utils/utils/ip';
import { readNetworkMeta, type NetworkRequest } from '@server/auth/networkMeta';
import { wasTurnstileVerified } from '@server/auth/signupChallenge';

const USER_AGENT_MAX_LENGTH = 512;

// An opening tag, closing tag, comment or processing instruction: `<b>`, `</x>`, `<!--`, `<?`.
const MARKUP = /<[a-z!/?]/i;
// C0 controls and DEL. Names are trimmed before this runs, so a leading tab or CR is already gone.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The reasons a waitlist name looks like an injection probe rather than a person; empty when it
 * looks like a name. Advisory only: the caller still stores the row and answers the same way.
 */
export function suspiciousNameReasons(names: readonly string[]): SubscriberSuspiciousReason[] {
  const reasons = new Set<SubscriberSuspiciousReason>();
  for (const name of names) {
    if (MARKUP.test(name)) reasons.add('markup');
    if (SLACK_CSV_FORMULA_PREFIX.test(name)) reasons.add('formula_prefix');
    if (CONTROL_CHARACTERS.test(name)) reasons.add('control_characters');
  }
  return [...reasons];
}

/**
 * The network to store on a waitlist row: readNetworkMeta's capture, with the IP cut to its /24 or
 * /48 prefix up front. These people have no account yet, so the full address is never kept.
 */
export function readSubscriberSignupNetwork(req: NetworkRequest): ISubscriberSignupNetwork {
  const meta = readNetworkMeta(req);
  return {
    ipPrefix: meta.ip ? truncateIp(meta.ip) : null,
    // An anonymous caller picks this header, so its stored length is bounded.
    userAgent: meta.userAgent ? meta.userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
    asn: meta.asn,
    asnOrg: meta.asnOrg,
    country: meta.country,
    isDatacenter: meta.isDatacenter,
    ja4: meta.ja4 ?? null,
    wafAnonIp: meta.wafAnonIp ?? null,
    wafBotSignal: meta.wafBotSignal ?? null,
    challengeVerified: wasTurnstileVerified(req),
    capturedAt: new Date(),
  };
}
