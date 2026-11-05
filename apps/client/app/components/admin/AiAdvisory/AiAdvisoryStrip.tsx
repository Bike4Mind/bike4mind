import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button, Stack, Typography } from '@mui/joy';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import type { ShadowDetector } from '@bike4mind/common';
import { useAiAdvisory, type AiAbuseAdvisoryRow } from '@client/app/hooks/data/aiAdvisory';
import { AI_ADVISORY_WINDOW_HOURS, type AiAdvisoryNetwork } from '@client/app/utils/aiAdvisory';
import { BlockIpDialog } from '../BlockedIPs/IpBlockDialogs';
import { AI_ADVISORY_MARK } from '../Users/List/AiAdvisoryBadge';
import { usersTabLinkSearch } from '../Users/usersTabSearch';
import { DETECTOR_LABELS } from '../shadowDetectorLabels';
import { SectionCard } from '../shared/SectionCard';

// Enough to point at the worst offenders without turning the strip into a table.
const MAX_SHOWN_CANDIDATES = 3;

function topDetector(advisories: AiAbuseAdvisoryRow[]): ShadowDetector | undefined {
  const counts = new Map<ShadowDetector, number>();
  for (const { detector } of advisories) counts.set(detector, (counts.get(detector) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const networkLabel = (network: AiAdvisoryNetwork) =>
  [network.ip, network.country, network.hosting ? 'hosting' : null, `${network.accountCount} acct`]
    .filter(Boolean)
    .join(' \u00b7 ');

/**
 * The dashboard's "needs attention" line for the AI advisory: renders nothing until the AI has
 * judged an unreviewed detection as abuse. Review opens the Users list on those accounts, where bulk
 * Contain acts; IP and domain suggestions open the existing block flows. Nothing here acts on its own.
 */
export function AiAdvisoryStrip() {
  const navigate = useNavigate();
  const { data } = useAiAdvisory();
  const [blockingIp, setBlockingIp] = useState<string | null>(null);
  const advisories = useMemo(() => data?.advisories ?? [], [data]);
  const detector = useMemo(() => topDetector(advisories), [advisories]);
  if (advisories.length === 0) return null;

  const networks = data?.networks.slice(0, MAX_SHOWN_CANDIDATES) ?? [];
  const mailDomains = data?.mailDomains.slice(0, MAX_SHOWN_CANDIDATES) ?? [];
  const count = `${advisories.length}${data?.truncated ? '+' : ''}`;
  const openUsers = (filters: Parameters<typeof usersTabLinkSearch>[0]) =>
    navigate({ to: '/admin', search: usersTabLinkSearch(filters) });

  return (
    <SectionCard
      title={`${AI_ADVISORY_MARK} AI advisory`}
      body="custom"
      data-testid="admin-dashboard-ai-advisory"
      action={
        <Button
          size="sm"
          variant="plain"
          endDecorator={<ArrowForwardIcon />}
          onClick={() => openUsers({ aiVerdict: 'abuse' })}
          data-testid="admin-dashboard-ai-advisory-review-btn"
        >
          Review
        </Button>
      }
    >
      <Stack spacing={1} sx={{ px: 2, py: 1.5 }}>
        <Typography level="body-sm" sx={{ color: 'admin.ink' }} data-testid="admin-dashboard-ai-advisory-summary">
          {`${count} ${advisories.length === 1 ? 'account' : 'accounts'} likely abuse (last ${AI_ADVISORY_WINDOW_HOURS}h, unreviewed)`}
          {detector && ` \u00b7 top signal: ${DETECTOR_LABELS[detector]}`}
        </Typography>
        {(networks.length > 0 || mailDomains.length > 0) && (
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              Shared by flagged accounts:
            </Typography>
            {networks.map(network => (
              <Button
                key={network.ip}
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => setBlockingIp(network.ip)}
                title={[network.asnOrg, network.detectorWouldBlock ? 'a detector would block this IP' : null]
                  .filter(Boolean)
                  .join('; ')}
                data-testid={`admin-dashboard-ai-advisory-ip-${network.ip}`}
              >
                {`Block IP ${networkLabel(network)}`}
              </Button>
            ))}
            {mailDomains.map(({ domain, accountCount }) => (
              <Button
                key={domain}
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => openUsers({ emailDomain: domain })}
                data-testid={`admin-dashboard-ai-advisory-domain-${domain}`}
              >
                {`Domain ${domain} \u00b7 ${accountCount} acct`}
              </Button>
            ))}
          </Stack>
        )}
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Advisory only: nothing is suspended or blocked until an admin acts. Contain the accounts from Review; a domain
          opens its accounts, where Contain can also block it.
        </Typography>
      </Stack>
      {blockingIp && <BlockIpDialog initialIp={blockingIp} onClose={() => setBlockingIp(null)} />}
    </SectionCard>
  );
}
