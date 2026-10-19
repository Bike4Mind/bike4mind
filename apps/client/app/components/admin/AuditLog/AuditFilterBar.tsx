import { useMemo, useState } from 'react';
import { Autocomplete, Button, FormControl, FormLabel, Input, Option, Select, Stack } from '@mui/joy';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import {
  ADMIN_AUDIT_CATALOGUE,
  AdminAuditCategorySchema,
  AdminAuditSeveritySchema,
  AuditContextSchema,
  AuditTargetSchema,
  AUDIT_EXPORT_MAX_ROWS,
  type AuditLogFilters,
} from '@bike4mind/common';
import { downloadAuditLogCsv } from '@client/app/hooks/data/adminAuditLog';
import { useSearchOrganizations } from '@client/app/hooks/data/organizations';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { useSnackbar } from '@client/app/contexts/SnackbarContext';
import UserSelector from '@client/app/components/admin/Users/Details/UserSelector';

const ANY = 'any';
const ACTION_OPTIONS = Object.keys(ADMIN_AUDIT_CATALOGUE);
const CATEGORY_OPTIONS = AdminAuditCategorySchema.options;
const SEVERITY_OPTIONS = AdminAuditSeveritySchema.options;
const SOURCE_OPTIONS = AuditContextSchema.shape.source.options;
const TARGET_KIND_OPTIONS = AuditTargetSchema.shape.kind.options;

/** The date inputs are local calendar days; `to` is inclusive, so it means end of day. */
export const dateInputToIso = (date: string, boundary: 'start' | 'end'): string | undefined => {
  if (!date) return undefined;
  const time = boundary === 'start' ? '00:00:00.000' : '23:59:59.999';
  const parsed = new Date(`${date}T${time}`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

export const isoToDateInput = (iso: string | undefined): string => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

type OrgOption = { id: string; name: string };

type EnumSelectProps<T extends string> = {
  label: string;
  testId: string;
  value: T | undefined;
  options: readonly T[];
  onChange(value: T | undefined): void;
};

const EnumSelect = <T extends string>({ label, testId, value, options, onChange }: EnumSelectProps<T>) => (
  <FormControl size="sm" sx={{ minWidth: 140 }}>
    <FormLabel>{label}</FormLabel>
    <Select<string>
      value={value ?? ANY}
      onChange={(_, next) => onChange(!next || next === ANY ? undefined : (next as T))}
      data-testid={testId}
    >
      <Option value={ANY}>Any</Option>
      {options.map(option => (
        <Option key={option} value={option}>
          {option}
        </Option>
      ))}
    </Select>
  </FormControl>
);

type TargetIdInputProps = { filters: AuditLogFilters; onChange(patch: Partial<AuditLogFilters>): void };

const OrganizationTargetPicker: React.FC<TargetIdInputProps> = ({ filters, onChange }) => {
  const [selected, setSelected] = useState<OrgOption | null>(null);
  const { debouncedValue: search, setValue: setSearch } = useDebounceValue('', 500);
  const { data, isLoading } = useSearchOrganizations({
    page: 1,
    limit: 20,
    search,
    filters: { personal: false },
    orderBy: { by: 'name', direction: 'asc' },
  });
  const options: OrgOption[] = useMemo(
    () => (data?.data ?? []).map(org => ({ id: String(org.id), name: org.name })),
    [data]
  );
  const value = filters.targetId
    ? selected?.id === filters.targetId
      ? selected
      : { id: filters.targetId, name: filters.targetId }
    : null;

  return (
    <FormControl size="sm" sx={{ minWidth: 220 }}>
      <FormLabel>Organization</FormLabel>
      <Autocomplete<OrgOption>
        options={options}
        value={value}
        loading={isLoading}
        getOptionLabel={option => option.name}
        isOptionEqualToValue={(option, current) => option.id === current.id}
        filterOptions={items => items}
        onInputChange={(_, input) => setSearch(input)}
        onChange={(_, next) => {
          setSelected(next);
          onChange({ targetId: next?.id });
        }}
        placeholder="Search organizations..."
        data-testid="audit-filter-target-org"
      />
    </FormControl>
  );
};

const RawTargetIdInput: React.FC<TargetIdInputProps> = ({ filters, onChange }) => {
  const [draft, setDraft] = useState(filters.targetId ?? '');
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed !== (filters.targetId ?? '')) onChange({ targetId: trimmed || undefined });
  };
  return (
    <FormControl size="sm" sx={{ minWidth: 200 }}>
      <FormLabel>Target id</FormLabel>
      <Input
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => event.key === 'Enter' && commit()}
        slotProps={{ input: { 'data-testid': 'audit-filter-target-id' } }}
      />
    </FormControl>
  );
};

const TargetPicker: React.FC<TargetIdInputProps> = ({ filters, onChange }) => {
  if (filters.targetKind === 'user') {
    return (
      <div data-testid="audit-filter-target-user">
        <UserSelector
          label="Target user"
          value={filters.targetId ?? null}
          onChange={userId => onChange({ targetId: userId ?? undefined })}
        />
      </div>
    );
  }
  if (filters.targetKind === 'organization') return <OrganizationTargetPicker filters={filters} onChange={onChange} />;
  if (filters.targetKind) return <RawTargetIdInput key={filters.targetKind} filters={filters} onChange={onChange} />;
  return null;
};

type AuditFilterBarProps = {
  filters: AuditLogFilters;
  onChange(patch: Partial<AuditLogFilters>): void;
  onClear(): void;
};

export const AuditFilterBar: React.FC<AuditFilterBarProps> = ({ filters, onChange, onClear }) => {
  const { showSnackbar } = useSnackbar();
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const { truncated } = await downloadAuditLogCsv(filters);
      if (truncated) {
        showSnackbar(
          `Export truncated to the first ${AUDIT_EXPORT_MAX_ROWS.toLocaleString()} rows. Narrow the filters to export the rest.`,
          { variant: 'soft', color: 'warning' }
        );
      }
    } catch {
      showSnackbar('Failed to export the audit log', { variant: 'soft', color: 'danger' });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Stack
      direction="row"
      spacing={1.5}
      useFlexGap
      flexWrap="wrap"
      alignItems="flex-end"
      data-testid="audit-filter-bar"
    >
      <div data-testid="audit-filter-actor">
        <UserSelector
          label="Actor"
          value={filters.actorUserId ?? null}
          onChange={userId => onChange({ actorUserId: userId ?? undefined })}
        />
      </div>
      <EnumSelect
        label="Target kind"
        testId="audit-filter-target-kind"
        value={filters.targetKind}
        options={TARGET_KIND_OPTIONS}
        onChange={targetKind => onChange({ targetKind, targetId: undefined })}
      />
      <TargetPicker filters={filters} onChange={onChange} />
      <EnumSelect
        label="Category"
        testId="audit-filter-category"
        value={filters.category}
        options={CATEGORY_OPTIONS}
        onChange={category => onChange({ category })}
      />
      <EnumSelect
        label="Severity"
        testId="audit-filter-severity"
        value={filters.severity}
        options={SEVERITY_OPTIONS}
        onChange={severity => onChange({ severity })}
      />
      <EnumSelect
        label="Source"
        testId="audit-filter-source"
        value={filters.source}
        options={SOURCE_OPTIONS}
        onChange={source => onChange({ source })}
      />
      <FormControl size="sm" sx={{ minWidth: 240 }}>
        <FormLabel>Action</FormLabel>
        <Autocomplete
          freeSolo
          options={ACTION_OPTIONS}
          value={filters.action ?? null}
          onChange={(_, next) => onChange({ action: next?.trim() || undefined })}
          placeholder="e.g. credits.granted"
          data-testid="audit-filter-action"
        />
      </FormControl>
      <FormControl size="sm">
        <FormLabel>From</FormLabel>
        <Input
          type="date"
          value={isoToDateInput(filters.from)}
          onChange={event => onChange({ from: dateInputToIso(event.target.value, 'start') })}
          slotProps={{ input: { 'data-testid': 'audit-filter-from' } }}
        />
      </FormControl>
      <FormControl size="sm">
        <FormLabel>To</FormLabel>
        <Input
          type="date"
          value={isoToDateInput(filters.to)}
          onChange={event => onChange({ to: dateInputToIso(event.target.value, 'end') })}
          slotProps={{ input: { 'data-testid': 'audit-filter-to' } }}
        />
      </FormControl>
      <Button size="sm" variant="plain" color="neutral" onClick={onClear} data-testid="audit-filter-clear-btn">
        Clear
      </Button>
      <Button
        size="sm"
        variant="outlined"
        startDecorator={<FileDownloadIcon />}
        loading={isExporting}
        onClick={handleExport}
        data-testid="audit-export-btn"
      >
        Export CSV
      </Button>
    </Stack>
  );
};
