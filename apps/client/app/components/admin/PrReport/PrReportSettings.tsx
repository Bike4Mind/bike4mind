import { useState, type ReactNode } from 'react';
import {
  Box,
  Button,
  Chip,
  ChipDelete,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import RestartAltIcon from '@mui/icons-material/RestartAlt';

import { useGetSettingsValue, useUpdateSettings } from '@client/app/hooks/data/settings';
import type { SettingKey } from '@bike4mind/common';
import { useSettingsDraft } from '../SettingsDraftProvider';
import { SettingsSection, StatusChip } from '../shared';

/**
 * Inline editors for the four `prReport*` admin settings, so an admin configures the digest from
 * the same tab that runs it rather than hunting through the generic Admin Settings screen. Each
 * field stages its edit for the page's one SaveBar (the SettingsDraftProvider in PrReportTab), which
 * writes one PUT per changed key, as the generic editor does. The identity map is optional (blank
 * posts with no mentions) and the egress allowlist fails closed (empty blocks every send).
 */

/** Slack incoming webhooks live here - the out-of-the-box egress target. */
const DEFAULT_EGRESS_HOSTS = ['hooks.slack.com'];

const FIELD_MAX_WIDTH = '40rem';

// FormHelperText is a flex row, which squeezes each text run and <code> into a column of its own
// so they overlap at narrow widths; as a block the help wraps as one paragraph. Same trap as the
// helpers in PartnerSignupRulesTab and ApiKeyScopePreflightTab, which wrap their text in one span.
const helperSx = {
  display: 'block',
  mt: 0,
  color: 'admin.inkMuted',
  overflowWrap: 'anywhere',
  '& code': { fontFamily: 'code' },
} as const;

/** Reduce a pasted URL or bare host to a comparable hostname. */
function normalizeHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '') // strip scheme
    .replace(/\/.*$/, '') // strip path
    .replace(/:\d+$/, ''); // strip port
}

/** Read `prReportEgressAllowlist` (stored as an object, or a JSON string) into a host list. */
function readHosts(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
  }
  const hosts = (parsed as { hosts?: unknown } | undefined)?.hosts;
  return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string') : [];
}

const sameHosts = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

const SectionHeading = ({ title, description }: { title: string; description: string }) => (
  <Stack sx={{ gap: 0.5, mb: 2 }}>
    <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
      {title}
    </Typography>
    <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
      {description}
    </Typography>
  </Stack>
);

/** Label row with an optional right-aligned action, then the control and its help. */
function Field({
  label,
  required,
  helper,
  action,
  testId,
  children,
}: {
  label: string;
  required?: boolean;
  helper: ReactNode;
  action?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <FormControl required={required} sx={{ gap: 1, maxWidth: FIELD_MAX_WIDTH }}>
      <Stack direction="row" alignItems="center" gap={1}>
        <FormLabel sx={{ m: 0, mr: 'auto' }}>{label}</FormLabel>
        {action}
      </Stack>
      {children}
      <FormHelperText sx={helperSx} data-testid={`${testId}-helper`}>
        {helper}
      </FormHelperText>
    </FormControl>
  );
}

function StringSettingField({
  settingKey,
  label,
  required,
  helper,
  placeholder,
  multiline,
  testId,
}: {
  settingKey: SettingKey;
  label: string;
  required?: boolean;
  helper: ReactNode;
  placeholder?: string;
  multiline?: boolean;
  testId: string;
}) {
  const stored = useGetSettingsValue(settingKey);
  const update = useUpdateSettings();
  const { value, setValue, pending } = useSettingsDraft(settingKey, typeof stored === 'string' ? stored : '', {
    name: label,
    save: next => update.mutateAsync({ key: settingKey, value: next }),
  });

  return (
    <Field label={label} required={required} helper={helper} testId={testId}>
      {multiline ? (
        <Textarea
          minRows={3}
          maxRows={8}
          value={value}
          placeholder={placeholder}
          disabled={pending}
          onChange={event => setValue(event.target.value)}
          sx={{ fontFamily: 'code' }}
          slotProps={{ textarea: { 'data-testid': `${testId}-input` } }}
        />
      ) : (
        <Input
          value={value}
          placeholder={placeholder}
          disabled={pending}
          onChange={event => setValue(event.target.value)}
          slotProps={{ input: { 'data-testid': `${testId}-input` } }}
        />
      )}
    </Field>
  );
}

/**
 * The webhook URL is a secret: the server only ever returns it masked, so the field never shows the
 * stored value and an untouched field can never re-submit the mask. The draft is a freshly typed
 * replacement, or null to clear the stored URL. Clearing sends `confirmClear`, because an empty write
 * to a sensitive key destroys a live credential and the server requires deliberate intent.
 */
function WebhookUrlField() {
  const stored = useGetSettingsValue('prReportWebhookUrl');
  const hasStoredSecret = typeof stored === 'string' && stored.length > 0;
  const update = useUpdateSettings();
  const { value, setValue, pending, dirty } = useSettingsDraft<string | null>('prReportWebhookUrl', '', {
    name: 'Slack webhook URL',
    // Whitespace alone is not a replacement.
    equals: (left, right) => (left === null || right === null ? left === right : left.trim() === right.trim()),
    save: next =>
      update.mutateAsync(
        next === null
          ? { key: 'prReportWebhookUrl', value: '', confirmClear: true }
          : { key: 'prReportWebhookUrl', value: next }
      ),
  });
  const clearing = value === null;
  const placeholder = clearing
    ? 'The saved URL is removed when you save.'
    : hasStoredSecret
      ? 'A value is saved. Paste a new one to replace it.'
      : 'https://hooks.slack.com/services/T00000000/B00000000/your-webhook-token';

  return (
    <Field
      label="Slack webhook URL"
      required
      testId="pr-report-webhook"
      helper={
        <>
          Required to send. The Slack Incoming Webhook URL the digest posts to; it encodes its own channel and
          workspace, so no bot token or channel ID is needed. Stored encrypted and never shown again - paste a new one
          to replace it.
        </>
      }
      action={
        hasStoredSecret &&
        !dirty && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            disabled={pending}
            onClick={() => setValue(null)}
            data-testid="pr-report-webhook-clear-btn"
          >
            Clear
          </Button>
        )
      }
    >
      <Input
        type="password"
        value={value ?? ''}
        placeholder={placeholder}
        disabled={pending}
        onChange={event => setValue(event.target.value)}
        slotProps={{ input: { 'data-testid': 'pr-report-webhook-input', autoComplete: 'off' } }}
      />
    </Field>
  );
}

/** Chip-list editor for the egress allowlist object setting. */
function EgressAllowlistField() {
  const stored = useGetSettingsValue('prReportEgressAllowlist');
  const update = useUpdateSettings();
  const {
    value: hosts,
    setValue: setHosts,
    pending,
  } = useSettingsDraft('prReportEgressAllowlist', readHosts(stored), {
    name: 'Egress allowlist',
    equals: sameHosts,
    save: next => update.mutateAsync({ key: 'prReportEgressAllowlist', value: { hosts: next } }),
  });
  const [entry, setEntry] = useState('');

  const isEmpty = hosts.length === 0;
  const isDefault = sameHosts(hosts, DEFAULT_EGRESS_HOSTS);

  const addEntry = () => {
    const host = normalizeHost(entry);
    if (!host || hosts.includes(host)) {
      setEntry('');
      return;
    }
    setHosts([...hosts, host]);
    setEntry('');
  };

  return (
    <Field
      label="Egress allowlist"
      testId="pr-report-egress"
      helper={
        <>
          Hostnames the digest is allowed to POST to, checked against the webhook URL&apos;s own host. Slack incoming
          webhooks live at <code>hooks.slack.com</code>, so keep the default unless you route sends through a proxy.
          Fails closed: an empty list blocks every send by design.
        </>
      }
    >
      <Box
        data-testid="pr-report-egress-hosts"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 0.75,
          minHeight: '2.5rem',
          alignItems: 'center',
          p: 1,
          borderRadius: 'md',
          border: '1px solid',
          borderColor: 'admin.borderStrong',
          bgcolor: 'admin.surface',
        }}
      >
        {isEmpty ? (
          <StatusChip tone="bad" label="No hosts - every send is blocked" data-testid="pr-report-egress-empty" />
        ) : (
          hosts.map(host => (
            <Chip
              key={host}
              variant="soft"
              color="neutral"
              disabled={pending}
              endDecorator={<ChipDelete onDelete={() => setHosts(hosts.filter(h => h !== host))} />}
            >
              {host}
            </Chip>
          ))
        )}
      </Box>

      <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 0.5 }}>
        <Input
          size="sm"
          value={entry}
          placeholder="add a host (e.g. slack.com)"
          disabled={pending}
          onChange={event => setEntry(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addEntry();
            }
          }}
          sx={{ flex: 1, minWidth: '12rem' }}
          slotProps={{ input: { 'data-testid': 'pr-report-egress-add-input' } }}
        />
        <Button
          size="sm"
          variant="outlined"
          startDecorator={<AddIcon fontSize="small" />}
          onClick={addEntry}
          disabled={pending || !normalizeHost(entry)}
          data-testid="pr-report-egress-add-btn"
        >
          Add
        </Button>
        {!isDefault && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            startDecorator={<RestartAltIcon fontSize="small" />}
            disabled={pending}
            onClick={() => setHosts(DEFAULT_EGRESS_HOSTS)}
            data-testid="pr-report-egress-reset-btn"
          >
            Slack defaults
          </Button>
        )}
      </Stack>
    </Field>
  );
}

/** The PR digest settings, grouped into sections. Render inside a SettingsDraftProvider. */
export function PrReportSettings() {
  return (
    <Stack sx={{ gap: 2 }}>
      <SettingsSection component="section" sx={{ mb: 0 }} data-testid="pr-report-section-repository">
        <SectionHeading
          title="Source"
          description="Every digest reports on this repository. Settings on this page apply to the whole deployment."
        />
        <StringSettingField
          settingKey="prReportRepo"
          label="Repository"
          required
          placeholder="owner/repo"
          helper={
            <>
              The <code>owner/repo</code> whose open pull requests the digest reports on.
            </>
          }
          testId="pr-report-repo"
        />
      </SettingsSection>

      <SettingsSection component="section" sx={{ mb: 0 }} data-testid="pr-report-section-slack">
        <SectionHeading
          title="Slack delivery"
          description="Where the digest posts, who it mentions and which hosts it may reach."
        />
        <Stack sx={{ gap: 2.5 }}>
          <WebhookUrlField />
          <StringSettingField
            settingKey="prReportIdentityMap"
            label="Identity map"
            multiline
            placeholder={'octocat            U01ABCD2EF\nreviewer_backend   U03GHIJ4KL\ndevops_primary     U05MNOP6QR'}
            helper={
              <>
                Optional. Maps GitHub logins and role keys (<code>reviewer_</code>, <code>devops_</code>,{' '}
                <code>qa_</code>) to Slack member IDs, one per line. Leave blank to post the digest with no @-mentions.
              </>
            }
            testId="pr-report-identity-map"
          />
          <EgressAllowlistField />
        </Stack>
      </SettingsSection>
    </Stack>
  );
}

export default PrReportSettings;
