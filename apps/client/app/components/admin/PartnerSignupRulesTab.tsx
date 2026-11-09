import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dropdown,
  IconButton,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import { MoreHorizontal } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import type { IPartnerSignupRuleDocument } from '@bike4mind/common';
import {
  fetchPartnerSignupRules,
  updatePartnerSignupRule,
  deletePartnerSignupRule,
  previewPartnerRuleBackfill,
  runPartnerRuleBackfill,
} from '@client/app/utils/partnerSignupRuleAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import type { GrantPackageRow } from '@client/app/utils/grantPackageAPICalls';
import { grantPackageUsage, useGrantPackageOptions } from './InviteCenter/shared/GrantPackageSelect';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminPageHeader,
  AdminSearchInput,
  DataTable,
  EmptyState,
  StatusChip,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import PartnerSignupRuleFormDialog, { planLabelForPriceId } from './PartnerSignupRuleFormDialog';

const QUERY_KEY = 'partner-signup-rules';

const dash = (
  <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
    -
  </Typography>
);
const none = (
  <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
    none
  </Typography>
);

const plural = (count: number) => (count === 1 ? '' : 's');

export default function PartnerSignupRulesTab() {
  const queryClient = useQueryClient();
  // useDebounceValue owns the input state; `value` mirrors keystrokes, `debouncedValue` drives the query.
  const { value: searchInput, debouncedValue: search, setValue: setSearchInput } = useDebounceValue('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // `formOpen` with `editing` null => create; with a rule => edit that rule.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<IPartnerSignupRuleDocument | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IPartnerSignupRuleDocument | null>(null);
  const [backfillTarget, setBackfillTarget] = useState<IPartnerSignupRuleDocument | null>(null);
  const { data: packageList } = useGrantPackageOptions();

  const { data, isPending, error, refetch } = useQuery({
    queryKey: [QUERY_KEY, { page, pageSize, search }],
    queryFn: () => fetchPartnerSignupRules({ page, limit: pageSize, search: search || undefined }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });

  const toggleMutation = useMutation({
    mutationFn: (rule: IPartnerSignupRuleDocument) => updatePartnerSignupRule(rule.id, { enabled: !rule.enabled }),
    onSuccess: rule => {
      invalidate();
      toast.success(`${rule.domain} ${rule.enabled ? 'enabled' : 'disabled'}`);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (rule: IPartnerSignupRuleDocument) => deletePartnerSignupRule(rule.id),
    onSuccess: (_result, rule) => {
      invalidate();
      setDeleteTarget(null);
      toast.success(`Deleted signup rule for ${rule.domain}`);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });

  const { data: backfillPreview, isPending: backfillPreviewLoading } = useQuery({
    queryKey: ['partner-rule-backfill-preview', backfillTarget?.id],
    queryFn: () => previewPartnerRuleBackfill(backfillTarget!.id),
    enabled: !!backfillTarget,
  });
  const backfillMutation = useMutation({
    mutationFn: (rule: IPartnerSignupRuleDocument) => runPartnerRuleBackfill(rule.id),
    onSuccess: result => {
      setBackfillTarget(null);
      toast.success(
        `Backfill complete: ${result.added} added` +
          (result.seatRaised ? `, ${result.seatRaised} seat${result.seatRaised === 1 ? '' : 's'} added` : '') +
          (result.alreadyMember ? `, ${result.alreadyMember} already members` : '') +
          (result.atCapacity ? `, ${result.atCapacity} at capacity (Stripe org - add seats)` : '') +
          (result.failed ? `, ${result.failed} failed` : '')
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });

  const openForm = (rule: IPartnerSignupRuleDocument | null) => {
    setEditing(rule);
    setFormOpen(true);
  };

  const toggling = (rule: IPartnerSignupRuleDocument) =>
    toggleMutation.isPending && toggleMutation.variables?.id === rule.id;

  const columns: DataColumn<IPartnerSignupRuleDocument>[] = [
    { id: 'domain', label: 'Domain', width: '12rem', render: rule => <b>{rule.domain}</b> },
    { id: 'label', label: 'Label', width: '10rem', render: rule => rule.label || dash },
    {
      id: 'entitlements',
      label: 'Entitlements',
      width: '14rem',
      render: rule =>
        rule.entitlements.length ? (
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {rule.entitlements.map(key => (
              <Chip key={key} size="sm" variant="soft" color="neutral">
                {key}
              </Chip>
            ))}
          </Stack>
        ) : (
          none
        ),
    },
    {
      id: 'tags',
      label: 'Tags',
      width: '10rem',
      render: rule =>
        rule.tags?.length ? (
          <Stack
            direction="row"
            spacing={0.5}
            flexWrap="wrap"
            useFlexGap
            data-testid={`partner-rule-tags-${rule.domain}`}
          >
            {rule.tags.map(tag => (
              <Chip key={tag} size="sm" variant="soft" color="neutral">
                {tag}
              </Chip>
            ))}
          </Stack>
        ) : (
          none
        ),
    },
    {
      id: 'subscription',
      label: 'Subscription',
      width: '12rem',
      render: rule => (
        <span data-testid={`partner-rule-subscription-${rule.domain}`}>
          {rule.subscription
            ? `${planLabelForPriceId(rule.subscription.priceId)}, ${rule.subscription.durationMonths} mo`
            : '-'}
        </span>
      ),
    },
    {
      id: 'credits',
      label: 'Signup credits',
      numeric: true,
      width: '9rem',
      render: rule =>
        rule.grantPackageId ? (
          <PackageCell ruleId={rule.id} pkg={packageList?.data.find(pkg => pkg.id === rule.grantPackageId)} />
        ) : rule.signupCredits > 0 ? (
          rule.signupCredits.toLocaleString()
        ) : (
          none
        ),
    },
    {
      id: 'org',
      label: 'Org',
      width: '5rem',
      render: rule =>
        rule.organizationId ? (
          <Tooltip title="Verified signups on this domain are auto-added to an organization">
            <span>
              <StatusChip tone="good" label="linked" data-testid={`partner-rule-org-${rule.domain}`} />
            </span>
          </Tooltip>
        ) : (
          dash
        ),
    },
    {
      id: 'enabled',
      label: 'Enabled',
      width: '9rem',
      render: rule => (
        // A disabled Switch ignores pointer events, so the click would reach the row and open a stale edit form.
        <Stack direction="row" alignItems="center" gap={1} onClick={e => e.stopPropagation()}>
          <Tooltip title={rule.enabled ? 'Enabled - click to disable' : 'Disabled - click to enable'}>
            <Switch
              size="sm"
              color={rule.enabled ? 'success' : 'neutral'}
              checked={rule.enabled}
              disabled={toggling(rule)}
              onChange={() => toggleMutation.mutate(rule)}
              slotProps={{ input: { 'aria-label': `Enable rule for ${rule.domain}` } }}
              data-testid={`partner-rule-toggle-${rule.domain}`}
            />
          </Tooltip>
          {!rule.enabled && <StatusChip tone="neutral" label="Disabled" />}
        </Stack>
      ),
    },
  ];

  const rowActions = (rule: IPartnerSignupRuleDocument) => (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{ root: { variant: 'plain', size: 'sm', 'aria-label': `Actions for ${rule.domain}` } }}
        data-testid={`partner-rule-actions-${rule.domain}`}
      >
        <MoreHorizontal size={16} />
      </MenuButton>
      <Menu placement="bottom-end">
        <MenuItem onClick={() => openForm(rule)} data-testid={`partner-rule-edit-${rule.domain}`}>
          Edit rule
        </MenuItem>
        {rule.organizationId && (
          <MenuItem onClick={() => setBackfillTarget(rule)} data-testid={`partner-rule-backfill-${rule.domain}`}>
            Backfill into organization
          </MenuItem>
        )}
        <MenuItem
          color="danger"
          onClick={() => setDeleteTarget(rule)}
          data-testid={`partner-rule-delete-${rule.domain}`}
        >
          Delete rule
        </MenuItem>
      </Menu>
    </Dropdown>
  );

  const addButton = (testId: string, label = 'Add rule', variant: 'solid' | 'outlined' = 'solid') => (
    <Button variant={variant} startDecorator={<AddIcon />} onClick={() => openForm(null)} data-testid={testId}>
      {label}
    </Button>
  );

  const matched = backfillPreview?.matched ?? 0;

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="partner-signup-rules-tab">
      <AdminPageHeader
        title="Partner signups"
        count={data?.meta.total}
        description="Grant entitlements, credits, a plan or an org to verified signups on a partner domain."
        actions={addButton('partner-rule-add-btn')}
      />
      <AdminSearchInput
        label="Search by domain or label"
        value={searchInput}
        onChange={value => {
          setSearchInput(value);
          setPage(1);
        }}
        data-testid="partner-rule-search-input"
      />
      <DataTable
        rows={data?.data ?? []}
        columns={columns}
        getRowId={rule => rule.id}
        label="Partner signup rules"
        minWidth="80rem"
        loading={isPending}
        error={error ? getErrorMessage(error) : undefined}
        onRetry={() => void refetch()}
        testId="partner-rules-table"
        rowTestId={rule => `partner-rule-row-${rule.domain}`}
        onRowActivate={rule => openForm(rule)}
        rowActions={rowActions}
        empty={
          search ? (
            <EmptyState
              title="No rules match this search"
              description="Try a different domain or label."
              action={
                <Button
                  variant="outlined"
                  color="neutral"
                  onClick={() => {
                    setSearchInput('');
                    setPage(1);
                  }}
                  data-testid="partner-rule-clear-search-btn"
                >
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No partner signup rules yet"
              description="Create a rule to auto-grant entitlements and bonus credits to a partner's verified signups."
              action={addButton('partner-rule-empty-add-btn', 'Add your first rule', 'outlined')}
            />
          )
        }
        pagination={{
          page,
          pageSize,
          total: data?.meta.total ?? 0,
          onPageChange: setPage,
          onPageSizeChange: size => {
            setPageSize(size);
            setPage(1);
          },
        }}
      />

      {formOpen && (
        <PartnerSignupRuleFormDialog
          editing={editing}
          onClose={() => setFormOpen(false)}
          onSaved={() => {
            void invalidate();
            setFormOpen(false);
          }}
        />
      )}

      <ActionDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete signup rule"
        tone="danger"
        description={
          <>
            Delete the rule for <b>{deleteTarget?.domain}</b>? New signups on this domain will stop receiving its
            entitlements and bonus credits. Existing users keep what they already have.
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.partnerSignupRule}
        reasonAudited={false}
        confirmLabel="Delete rule"
        pending={deleteMutation.isPending}
        onConfirm={async () => {
          if (deleteTarget) await deleteMutation.mutateAsync(deleteTarget);
        }}
        typedConfirm={deleteTarget ? { expected: deleteTarget.domain, noun: 'domain' } : undefined}
        data-testid="partner-rule-delete-modal"
        testIds={{ confirm: 'partner-rule-delete-confirm-btn' }}
      />

      <ActionDialog
        open={!!backfillTarget}
        onClose={() => setBackfillTarget(null)}
        title="Backfill into organization"
        description={
          <>
            Add existing <b>verified</b> users on <b>{backfillTarget?.domain}</b> to this rule&apos;s organization.
            Users already in the org are skipped, and no one is ever removed.
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.partnerBackfill}
        reasonAudited={false}
        confirmLabel={`Add ${matched} user${plural(matched)}`}
        blockedReason={
          backfillPreviewLoading
            ? 'Checking who would be added...'
            : !matched
              ? 'No existing users match this rule.'
              : null
        }
        pending={backfillMutation.isPending}
        onConfirm={async () => {
          if (backfillTarget) await backfillMutation.mutateAsync(backfillTarget);
        }}
        data-testid="partner-rule-backfill-modal"
        testIds={{ confirm: 'partner-rule-backfill-confirm-btn' }}
      >
        {!backfillPreviewLoading && (
          <Box
            data-testid="partner-rule-backfill-preview"
            sx={{ borderTop: '1px solid', borderBottom: '1px solid', borderColor: 'admin.border', py: 1.5 }}
          >
            <Typography level="title-md">
              {matched} user{plural(matched)} will be added
            </Typography>
            {backfillPreview && (
              <Typography level="body-sm" sx={{ mt: 0.5 }} data-testid="partner-rule-backfill-seat-impact">
                {backfillPreview.stripeBilled
                  ? `Stripe-billed org: seat ceiling stays at ${backfillPreview.seats}; candidates past it are rejected (add seats to admit them).`
                  : backfillPreview.projectedSeats > backfillPreview.seats
                    ? `Seat ceiling: ${backfillPreview.seats} -> ${backfillPreview.projectedSeats} (raised to fit)`
                    : `Seat ceiling: ${backfillPreview.seats} (unchanged; everyone fits under it)`}
              </Typography>
            )}
            {!!backfillPreview?.sample.length && (
              <Stack spacing={0.25} sx={{ mt: 1, maxHeight: 180, overflow: 'auto' }}>
                {backfillPreview.sample.map(user => (
                  <Typography key={user.id} level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                    {user.email || user.name}
                  </Typography>
                ))}
                {backfillPreview.matched > backfillPreview.sample.length && (
                  <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                    + {backfillPreview.matched - backfillPreview.sample.length} more
                  </Typography>
                )}
              </Stack>
            )}
          </Box>
        )}
      </ActionDialog>
    </Stack>
  );
}

function PackageCell({ ruleId, pkg }: { ruleId: string; pkg: GrantPackageRow | undefined }) {
  if (!pkg) return <Typography level="body-xs">package</Typography>;
  return (
    <Tooltip title={grantPackageUsage(pkg)}>
      <Typography level="body-sm" data-testid={`partner-rule-package-${ruleId}`}>
        {pkg.credits.toLocaleString()} ({pkg.name})
        {pkg.capHits > 0 && (
          <Box component="span" sx={{ ml: 0.5 }}>
            <StatusChip
              tone="warn"
              label={`${pkg.capHits.toLocaleString()} cap hits`}
              data-testid={`partner-rule-cap-hits-${ruleId}`}
            />
          </Box>
        )}
      </Typography>
    </Tooltip>
  );
}
