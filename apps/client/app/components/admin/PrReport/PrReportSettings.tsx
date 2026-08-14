import { useState } from 'react';
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
import CheckIcon from '@mui/icons-material/Check';
import AddIcon from '@mui/icons-material/Add';
import RestartAltIcon from '@mui/icons-material/RestartAlt';

import { useGetSettingsValue, useUpdateSettings } from '@client/app/hooks/data/settings';
import type { SettingKey } from '@bike4mind/common';

/**
 * Inline editors for the four `prReport*` admin settings, so an admin configures the
 * digest from the same tab that runs it rather than hunting through the generic Admin
 * Settings screen. Each field is its own save unit (one PUT per key), mirroring how the
 * generic editor writes settings. The identity map is optional (blank posts with no
 * mentions) and the egress allowlist fails closed (empty blocks every send).
 */

/** Slack's public API origin - the out-of-the-box egress target. */
const DEFAULT_EGRESS_HOSTS = ['slack.com', 'www.slack.com'];

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

/** Local draft over a stored string setting: dirty when edited, "Saved" until the next edit. */
function useStringSetting(key: SettingKey) {
  const stored = useGetSettingsValue(key);
  const saved = typeof stored === 'string' ? stored : '';
  const update = useUpdateSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const value = draft ?? saved;
  const isDirty = draft !== null && draft !== saved;

  return {
    value,
    isDirty,
    justSaved: justSaved && !isDirty,
    saving: update.isPending,
    onChange: (next: string) => {
      setDraft(next);
      setJustSaved(false);
    },
    save: () => {
      if (draft === null) return;
      update.mutate(
        { key, value: draft },
        {
          onSuccess: () => {
            setDraft(null);
            setJustSaved(true);
          },
        }
      );
    },
  };
}

/** Save button that flips to a "Saved" chip once a clean write lands. */
function SaveAffordance({
  isDirty,
  saving,
  justSaved,
  onSave,
  testId,
}: {
  isDirty: boolean;
  saving: boolean;
  justSaved: boolean;
  onSave: () => void;
  testId: string;
}) {
  if (justSaved) {
    return (
      <Chip size="sm" variant="soft" color="success" startDecorator={<CheckIcon fontSize="small" />}>
        Saved
      </Chip>
    );
  }
  return (
    <Button size="sm" variant="soft" onClick={onSave} disabled={!isDirty} loading={saving} data-testid={testId}>
      Save
    </Button>
  );
}

/** Shared frame: label row with an optional badge and a right-aligned action, then the control and helper. */
function FieldFrame({
  label,
  badge,
  badgeColor = 'neutral',
  helper,
  action,
  children,
}: {
  label: string;
  badge?: string;
  badgeColor?: 'neutral' | 'primary' | 'warning' | 'success';
  helper?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <FormControl sx={{ gap: 1 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <FormLabel sx={{ m: 0 }}>{label}</FormLabel>
        {badge && (
          <Chip size="sm" variant="soft" color={badgeColor}>
            {badge}
          </Chip>
        )}
        <Box sx={{ flex: 1 }} />
        {action}
      </Stack>
      {children}
      {helper && <FormHelperText sx={{ mt: 0 }}>{helper}</FormHelperText>}
    </FormControl>
  );
}

function StringSettingField({
  settingKey,
  label,
  badge,
  badgeColor,
  helper,
  placeholder,
  multiline,
  testId,
}: {
  settingKey: SettingKey;
  label: string;
  badge?: string;
  badgeColor?: 'neutral' | 'primary' | 'warning' | 'success';
  helper?: React.ReactNode;
  placeholder?: string;
  multiline?: boolean;
  testId: string;
}) {
  const field = useStringSetting(settingKey);

  return (
    <FieldFrame
      label={label}
      badge={badge}
      badgeColor={badgeColor}
      helper={helper}
      action={
        <SaveAffordance
          isDirty={field.isDirty}
          saving={field.saving}
          justSaved={field.justSaved}
          onSave={field.save}
          testId={`${testId}-save-btn`}
        />
      }
    >
      {multiline ? (
        <Textarea
          minRows={3}
          maxRows={8}
          value={field.value}
          placeholder={placeholder}
          onChange={event => field.onChange(event.target.value)}
          slotProps={{
            textarea: {
              'data-testid': `${testId}-input`,
              style: { fontFamily: 'monospace', fontSize: '0.8rem' },
            },
          }}
        />
      ) : (
        <Input
          value={field.value}
          placeholder={placeholder}
          onChange={event => field.onChange(event.target.value)}
          slotProps={{ input: { 'data-testid': `${testId}-input` } }}
        />
      )}
    </FieldFrame>
  );
}

/** Chip-list editor for the egress allowlist object setting. */
function EgressAllowlistField() {
  const stored = useGetSettingsValue('prReportEgressAllowlist');
  const saved = readHosts(stored);
  const update = useUpdateSettings();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [entry, setEntry] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  const hosts = draft ?? saved;
  const isDirty = draft !== null && !sameHosts(draft, saved);
  const isEmpty = hosts.length === 0;
  const isDefault = sameHosts(hosts, DEFAULT_EGRESS_HOSTS);

  const setHosts = (next: string[]) => {
    setDraft(next);
    setJustSaved(false);
  };

  const addEntry = () => {
    const host = normalizeHost(entry);
    if (!host || hosts.includes(host)) {
      setEntry('');
      return;
    }
    setHosts([...hosts, host]);
    setEntry('');
  };

  const save = () => {
    if (draft === null) return;
    update.mutate(
      { key: 'prReportEgressAllowlist', value: { hosts: draft } },
      {
        onSuccess: () => {
          setDraft(null);
          setJustSaved(true);
        },
      }
    );
  };

  return (
    <FieldFrame
      label="Egress allowlist"
      helper={
        <>
          Hostnames the digest is allowed to POST to. Slack&apos;s API lives at <code>slack.com</code>, so keep the
          defaults unless you route sends through a proxy. Fails closed: an empty list blocks every send by design.
        </>
      }
      action={
        <SaveAffordance
          isDirty={isDirty}
          saving={update.isPending}
          justSaved={justSaved && !isDirty}
          onSave={save}
          testId="pr-report-egress-save-btn"
        />
      }
    >
      <Box
        data-testid="pr-report-egress-hosts"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 0.75,
          minHeight: 40,
          alignItems: 'center',
          p: 1,
          borderRadius: 'sm',
          border: '1px solid',
          borderColor: isEmpty ? 'danger.outlinedBorder' : 'neutral.outlinedBorder',
          bgcolor: 'background.level1',
        }}
      >
        {isEmpty ? (
          <Typography level="body-xs" color="danger" sx={{ px: 0.5 }}>
            No hosts - every send is blocked.
          </Typography>
        ) : (
          hosts.map(host => (
            <Chip
              key={host}
              variant="soft"
              color="primary"
              endDecorator={<ChipDelete onDelete={() => setHosts(hosts.filter(h => h !== host))} />}
            >
              {host}
            </Chip>
          ))
        )}
      </Box>

      <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
        <Input
          size="sm"
          value={entry}
          placeholder="add a host (e.g. slack.com)"
          onChange={event => setEntry(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addEntry();
            }
          }}
          sx={{ flex: 1 }}
          slotProps={{ input: { 'data-testid': 'pr-report-egress-add-input' } }}
        />
        <Button
          size="sm"
          variant="outlined"
          startDecorator={<AddIcon fontSize="small" />}
          onClick={addEntry}
          disabled={!normalizeHost(entry)}
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
            onClick={() => setHosts(DEFAULT_EGRESS_HOSTS)}
            data-testid="pr-report-egress-reset-btn"
          >
            Slack defaults
          </Button>
        )}
      </Stack>
    </FieldFrame>
  );
}

/** The editable configuration block for the PR Status Digest. */
export function PrReportSettings() {
  return (
    <Stack spacing={2.5}>
      <StringSettingField
        settingKey="prReportRepo"
        label="Repository"
        badge="Required"
        badgeColor="primary"
        placeholder="owner/repo"
        helper={
          <>
            The <code>owner/repo</code> whose open pull requests the digest reports on.
          </>
        }
        testId="pr-report-repo"
      />

      <StringSettingField
        settingKey="prReportSlackChannel"
        label="Slack channel"
        badge="Required to send"
        badgeColor="primary"
        placeholder="C0123456789"
        helper="Slack channel ID the digest posts to. The bot token is resolved separately from the credential store."
        testId="pr-report-channel"
      />

      <StringSettingField
        settingKey="prReportIdentityMap"
        label="Identity map"
        badge="Optional"
        badgeColor="neutral"
        multiline
        placeholder={'octocat            U01ABCD2EF\nreviewer_backend   U03GHIJ4KL\ndevops_primary     U05MNOP6QR'}
        helper={
          <>
            Maps GitHub logins and role keys (<code>reviewer_</code>, <code>devops_</code>, <code>qa_</code>) to Slack
            member IDs, one per line. Leave blank to post the digest with no @-mentions.
          </>
        }
        testId="pr-report-identity-map"
      />

      <EgressAllowlistField />
    </Stack>
  );
}

export default PrReportSettings;
