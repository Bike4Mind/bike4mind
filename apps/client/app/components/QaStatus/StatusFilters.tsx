import { FC, useState } from 'react';
import { Button, ButtonGroup, Input, Option, Select, Stack } from '@mui/joy';
import type { QaFacets, QaStatusSearch } from '@client/app/hooks/data/qaStatus';

interface Props {
  search: QaStatusSearch;
  facets?: QaFacets;
  onChange: (patch: Partial<QaStatusSearch>) => void;
}

const StatusFilters: FC<Props> = ({ search, facets, onChange }) => {
  const [branch, setBranch] = useState(search.branch ?? 'main');
  // Resync the draft when the URL changes (back/forward, deep link), without an effect.
  const [syncedBranch, setSyncedBranch] = useState(search.branch);
  if (search.branch !== syncedBranch) {
    setSyncedBranch(search.branch);
    setBranch(search.branch ?? 'main');
  }
  // Committed on blur/Enter so typing does not refetch per keystroke.
  const commitBranch = () => {
    const next = branch.trim() || 'main';
    if (next !== (search.branch ?? 'main')) onChange({ branch: next });
  };

  return (
    <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center" data-testid="qa-filters">
      <ButtonGroup size="sm">
        {(facets?.products ?? []).map(p => (
          <Button
            key={p}
            data-testid={`qa-filter-product-${p}`}
            variant={p === search.product ? 'solid' : 'outlined'}
            onClick={() => onChange({ product: p, tenant: undefined, env: undefined })}
          >
            {p}
          </Button>
        ))}
      </ButtonGroup>
      <Select
        size="sm"
        data-testid="qa-filter-tenant"
        value={search.tenant ?? ''}
        onChange={(_, v) => onChange({ tenant: v || undefined })}
        sx={{ minWidth: 140 }}
      >
        <Option value="">All tenants</Option>
        {(facets?.tenants ?? []).map(t => (
          <Option key={t} value={t}>
            {t}
          </Option>
        ))}
      </Select>
      <Select
        size="sm"
        data-testid="qa-filter-env"
        value={search.env ?? ''}
        onChange={(_, v) => onChange({ env: v || undefined })}
        sx={{ minWidth: 140 }}
      >
        <Option value="">All envs</Option>
        {(facets?.envs ?? []).map(e => (
          <Option key={e} value={e}>
            {e}
          </Option>
        ))}
      </Select>
      <Input
        size="sm"
        data-testid="qa-filter-branch"
        startDecorator="branch:"
        value={branch}
        onChange={e => setBranch(e.target.value)}
        onBlur={commitBranch}
        onKeyDown={e => e.key === 'Enter' && commitBranch()}
        sx={{ width: 200 }}
      />
      <ButtonGroup size="sm" spacing={0.5}>
        {(['7d', '30d'] as const).map(r => (
          <Button
            key={r}
            data-testid={`qa-filter-range-${r}`}
            variant={(search.range ?? '7d') === r ? 'solid' : 'outlined'}
            onClick={() => onChange({ range: r })}
          >
            {r}
          </Button>
        ))}
      </ButtonGroup>
    </Stack>
  );
};

export default StatusFilters;
