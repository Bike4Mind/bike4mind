import { Box, Chip, Sheet, Stack, Typography } from '@mui/joy';
import type { WafRangeInput, WafTopBlockedRulesSeries } from '@/server/security/wafTraffic';
import { formatRangeLabel } from './wafRangeLabel';

interface WafTopRulesChartProps {
  data: WafTopBlockedRulesSeries;
  range: WafRangeInput;
  isLoading?: boolean;
}

/** All WAF rules that can produce BLOCK actions, in priority order from the policy JSON. */
const WAF_POLICY_RULES: Array<{ name: string; label: string; type: 'managed' | 'custom' }> = [
  { name: 'emergency-ip-block', label: 'Emergency IP Block', type: 'custom' },
  { name: 'api-rate-limit', label: 'API Rate Limit', type: 'custom' },
  { name: 'AWS-AWSManagedRulesCommonRuleSet', label: 'AWSManagedRulesCommonRuleSet', type: 'managed' },
  { name: 'AWS-AWSManagedRulesSQLiRuleSet', label: 'AWSManagedRulesSQLiRuleSet', type: 'managed' },
  { name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet', label: 'AWSManagedRulesKnownBadInputsRuleSet', type: 'managed' },
  {
    name: 'AWS-AWSManagedRulesAdminProtectionRuleSet',
    label: 'AWSManagedRulesAdminProtectionRuleSet',
    type: 'managed',
  },
  {
    name: 'AWS-AWSManagedRulesAmazonIpReputationList',
    label: 'AWSManagedRulesAmazonIpReputationList',
    type: 'managed',
  },
];

/**
 * Displays all configured WAF rules with their total block counts for the selected range.
 * Rules with no blocks show 0. Sorted by block count descending.
 */
export const WafTopRulesChart = ({ data, range, isLoading }: WafTopRulesChartProps) => {
  // Total blocks per rule from the time-series data
  const blocksByRule = new Map<string, number>();
  for (const s of data.series ?? []) {
    const total = (s.blocked ?? []).reduce((sum, v) => sum + v, 0);
    blocksByRule.set(s.ruleName, total);
  }

  // Merge static rule list with live block counts, sort descending
  const rows = WAF_POLICY_RULES.map(r => ({
    ...r,
    blocks: blocksByRule.get(r.name) ?? 0,
  })).sort((a, b) => b.blocks - a.blocks);

  return (
    <Sheet
      variant="soft"
      sx={{ p: 2, borderRadius: 'lg', backgroundColor: 'background.level1' }}
      data-testid="waf-traffic-toprules-card"
    >
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1.5 }}>
        <Typography level="title-sm" sx={{ fontWeight: 700 }}>
          Managed rules • Block counts
        </Typography>
        <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
          {formatRangeLabel(range)}
        </Typography>
      </Stack>

      {isLoading ? (
        <Typography level="body-sm" sx={{ color: 'neutral.600' }} data-testid="waf-traffic-toprules-loading">
          Loading rule data…
        </Typography>
      ) : (
        <Stack spacing={0.5} data-testid="waf-traffic-toprules-list">
          {rows.map(r => (
            <Stack
              key={r.name}
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{
                px: 1,
                py: 0.75,
                borderRadius: 'sm',
                '&:hover': { bgcolor: 'background.level2' },
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                <Chip
                  size="sm"
                  variant="soft"
                  color={r.type === 'managed' ? 'primary' : 'neutral'}
                  sx={{ flexShrink: 0, fontSize: '0.6rem' }}
                >
                  {r.type === 'managed' ? 'AWS' : 'Custom'}
                </Chip>
                <Typography
                  level="body-xs"
                  sx={{ color: 'text.primary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {r.label}
                </Typography>
              </Stack>
              <Box sx={{ flexShrink: 0, ml: 1 }}>
                <Typography
                  level="body-xs"
                  sx={{
                    fontWeight: 700,
                    color: r.blocks > 0 ? 'danger.500' : 'neutral.400',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                  data-testid={`waf-rule-count-${r.name}`}
                >
                  {r.blocks.toLocaleString()}
                </Typography>
              </Box>
            </Stack>
          ))}
        </Stack>
      )}
    </Sheet>
  );
};
