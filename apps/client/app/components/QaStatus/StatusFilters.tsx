import { FC, useRef, useState } from 'react';
import { Button, FormLabel, Input, Option, Select, Stack, useTheme } from '@mui/joy';
import type { QaFacets, QaStatusSearch } from '@client/app/hooks/data/qaStatus';
import {
  MAX_RANGE_DAYS,
  RANGE_PRESETS,
  activePreset,
  addDays,
  parseIsoDay,
  presetRange,
  resolveRange,
  spanDays,
  toIsoDay,
  type DayRange,
} from './dateRange';

/**
 * Joy's Select clears a value that is not among its options when the options change, so a
 * URL filter would be dropped while facets load. Keeping the current value listed prevents it.
 */
function withCurrent(options: readonly string[] | undefined, current: string | undefined): string[] {
  const list = [...(options ?? [])];
  if (current && !list.includes(current)) list.push(current);
  return list;
}

interface DateFieldProps {
  testId: string;
  inputId: string;
  value: string;
  min?: string;
  max: string;
  onCommit: (day: string) => void;
}

/**
 * A date input that holds typed digits until blur or Enter. Committing per keystroke re-renders the
 * field, which drops the browser's half-typed segment (so "11" became January then a new month).
 * A calendar pick, with no keystroke since the last commit, applies at once.
 */
const DateField: FC<DateFieldProps> = ({ testId, inputId, value, min, max, onCommit }) => {
  const theme = useTheme();
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setDraft(value);
  }
  const typing = useRef(false);
  const commit = () => {
    typing.current = false;
    if (draft !== value && parseIsoDay(draft)) onCommit(draft);
    // A clamped or invalid entry may leave `value` unchanged, so put the field back on it.
    setDraft(value);
  };
  return (
    <Input
      size="sm"
      type="date"
      sx={{ colorScheme: theme.palette.mode }}
      data-testid={testId}
      value={draft}
      onChange={e => {
        setDraft(e.target.value);
        if (!typing.current && parseIsoDay(e.target.value)) onCommit(e.target.value);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') commit();
        else if (e.key !== 'Tab' && e.key !== 'Escape') typing.current = true;
      }}
      onMouseDown={() => {
        typing.current = false;
      }}
      onBlur={commit}
      slotProps={{ input: { id: inputId, min, max } }}
    />
  );
};

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

  const range = resolveRange(search);
  const today = toIsoDay(new Date());
  const preset = activePreset(range);
  const setRange = (next: DayRange) => onChange({ from: next.from, to: next.to, range: undefined });
  // A picked day past the other end moves that end with it; an over-wide range keeps the picked day.
  // Typed dates bypass the inputs' max, so both ends clamp to today here too.
  const pickFrom = (picked: string) => {
    if (!parseIsoDay(picked)) return;
    const from = picked > today ? today : picked;
    let to = range.to < from ? from : range.to;
    if (spanDays({ from, to }) > MAX_RANGE_DAYS) to = addDays(from, MAX_RANGE_DAYS - 1);
    setRange({ from, to: to > today ? today : to });
  };
  const pickTo = (picked: string) => {
    if (!parseIsoDay(picked)) return;
    const to = picked > today ? today : picked;
    let from = range.from > to ? to : range.from;
    if (spanDays({ from, to }) > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1));
    setRange({ from, to });
  };

  return (
    <Stack spacing={1.5} data-testid="qa-filters">
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
        <Select
          size="sm"
          data-testid="qa-filter-product"
          aria-label="Product"
          placeholder="Product"
          value={search.product ?? null}
          onChange={(_, v) => v && v !== search.product && onChange({ product: v, tenant: undefined, env: undefined })}
          sx={{ minWidth: 160 }}
        >
          {withCurrent(facets?.products, search.product).map(p => (
            <Option key={p} value={p}>
              {p}
            </Option>
          ))}
        </Select>
        <Select
          size="sm"
          data-testid="qa-filter-tenant"
          value={search.tenant ?? ''}
          onChange={(_, v) => onChange({ tenant: v || undefined })}
          sx={{ minWidth: 140 }}
        >
          <Option value="">All tenants</Option>
          {withCurrent(facets?.tenants, search.tenant).map(t => (
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
          {withCurrent(facets?.envs, search.env).map(e => (
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
      </Stack>
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center" data-testid="qa-filter-dates">
        <Stack direction="row" spacing={1} alignItems="center">
          <FormLabel htmlFor="qa-filter-from-input" sx={{ m: 0, whiteSpace: 'nowrap' }}>
            Start date
          </FormLabel>
          <DateField
            testId="qa-filter-from"
            inputId="qa-filter-from-input"
            value={range.from}
            max={today}
            onCommit={pickFrom}
          />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <FormLabel htmlFor="qa-filter-to-input" sx={{ m: 0, whiteSpace: 'nowrap' }}>
            End date
          </FormLabel>
          <DateField
            testId="qa-filter-to"
            inputId="qa-filter-to-input"
            value={range.to}
            min={range.from}
            max={today}
            onCommit={pickTo}
          />
        </Stack>
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
          {RANGE_PRESETS.map(p => (
            <Button
              key={p.id}
              size="sm"
              data-testid={`qa-filter-preset-${p.id}`}
              aria-pressed={preset?.id === p.id}
              variant={preset?.id === p.id ? 'solid' : 'outlined'}
              onClick={() => setRange(presetRange(p.days))}
            >
              {p.label}
            </Button>
          ))}
        </Stack>
      </Stack>
    </Stack>
  );
};

export default StatusFilters;
