import { useState } from 'react';
import type { ISubscriberSignupNetwork, SubscriberSuspiciousReason } from '@bike4mind/common';
import { Box, Chip, Link, Stack, Tooltip, Typography } from '@mui/joy';

const REASON_LABELS: Record<SubscriberSuspiciousReason, string> = {
  markup: 'HTML or script markup',
  formula_prefix: 'Starts like a spreadsheet formula',
  control_characters: 'Control characters',
};

/** Badge for a waitlist name that looks like an injection probe; the reasons are in the tooltip. */
export const SuspiciousNameChip = ({ reasons }: { reasons: SubscriberSuspiciousReason[] }) => (
  <Tooltip title={reasons.map(reason => REASON_LABELS[reason]).join(', ')} variant="soft" size="sm">
    <Chip size="sm" color="danger" variant="soft" data-testid="waitlist-suspicious-chip">
      Payload-like name
    </Chip>
  </Tooltip>
);

const yesNo = (value: boolean | null) => (value === null ? 'not checked' : value ? 'yes' : 'no');

const networkLabel = (network: ISubscriberSignupNetwork): string | null => {
  if (network.asnOrg) return network.asnOrg;
  if (network.asn !== null) return `AS${network.asn}`;
  return null;
};

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <Typography level="body-xs" sx={{ wordBreak: 'break-all' }}>
    <Typography fontWeight="md">{label}:</Typography> {value}
  </Typography>
);

/**
 * Compact view of where a waitlist signup came from (country, network, datacenter and anonymous-IP
 * flags), with the rest of the capture behind an expand link. Rows from before capture existed, or
 * past the retention window, show a dash.
 */
export const SubscriberNetworkCell = ({ network }: { network?: ISubscriberSignupNetwork | null }) => {
  const [expanded, setExpanded] = useState(false);
  if (!network) {
    return (
      <Typography level="body-xs" color="neutral" data-testid="waitlist-network-none">
        -
      </Typography>
    );
  }

  const label = networkLabel(network);
  return (
    <Stack spacing={0.5} data-testid="waitlist-network-cell">
      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography level="body-sm" fontWeight="md">
          {network.country ?? 'Country unknown'}
        </Typography>
        {label && <Typography level="body-xs">{label}</Typography>}
        {network.isDatacenter && (
          <Chip size="sm" variant="soft" color="warning">
            Datacenter
          </Chip>
        )}
        {network.wafAnonIp && (
          <Chip size="sm" variant="soft" color="danger" data-testid="waitlist-anon-ip-chip">
            Anonymous IP
          </Chip>
        )}
        {network.wafBotSignal && (
          <Chip size="sm" variant="soft" color="danger">
            Bot
          </Chip>
        )}
      </Stack>
      <Link
        component="button"
        level="body-xs"
        onClick={() => setExpanded(value => !value)}
        data-testid="waitlist-network-toggle"
      >
        {expanded ? 'Hide details' : 'Details'}
      </Link>
      {expanded && (
        <Box data-testid="waitlist-network-details">
          <DetailRow label="IP prefix" value={network.ipPrefix ?? 'unknown'} />
          <DetailRow label="ASN" value={network.asn === null ? 'unknown' : `AS${network.asn}`} />
          <DetailRow label="Datacenter" value={yesNo(network.isDatacenter)} />
          <DetailRow label="Anonymous IP (WAF)" value={yesNo(network.wafAnonIp)} />
          <DetailRow label="Bot signal (WAF)" value={yesNo(network.wafBotSignal)} />
          <DetailRow label="Turnstile" value={network.challengeVerified ? 'passed' : 'not checked'} />
          <DetailRow label="JA4" value={network.ja4 ?? 'unknown'} />
          <DetailRow label="User agent" value={network.userAgent ?? 'unknown'} />
          <DetailRow label="Captured" value={new Date(network.capturedAt).toLocaleString()} />
        </Box>
      )}
    </Stack>
  );
};
