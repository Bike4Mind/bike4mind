import { FC, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Option,
  Select,
  Stack,
  Switch,
  Table,
  Textarea,
  Typography,
} from '@mui/joy';
import {
  CUSTOM_MCP_MAX_CONNECTIONS_PER_USER,
  CustomMcpPolicySchema,
  type CustomMcpPolicy,
  type CustomMcpPolicyMode,
  type IOrganizationDocument,
  type OrgCustomMcpPolicyView,
} from '@bike4mind/common';
import {
  useOrgCustomMcpConnections,
  useOrgCustomMcpPolicy,
  useResetOrgCustomMcpPolicy,
  useSaveOrgCustomMcpPolicy,
} from '@client/app/hooks/data/useOrgCustomMcpPolicy';
import { useGetOrganizationUsers } from '@client/app/hooks/data/user';
import PaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';

type OpenMode = Exclude<CustomMcpPolicyMode, 'off'>;

const MODE_LABELS: Record<OpenMode, string> = {
  presets_only: 'Catalog connectors only',
  allowlist: 'Allowed hosts only',
  any: 'Any host',
};

// The kill switch and the mode are one stored field; the form keeps the open mode so turning the
// switch back on restores what was there.
interface PolicyForm {
  enabled: boolean;
  mode: OpenMode;
  allowedHosts: string;
  blockedHosts: string;
  allowUnauthenticated: boolean;
  allowWriteTools: boolean;
  requireApprovalForAll: boolean;
  maxConnectionsPerUser: string;
}

const toForm = (policy: CustomMcpPolicy): PolicyForm => ({
  enabled: policy.mode !== 'off',
  mode: policy.mode === 'off' ? 'presets_only' : policy.mode,
  allowedHosts: policy.allowedHostPatterns.join('\n'),
  blockedHosts: policy.blockedHostPatterns.join('\n'),
  allowUnauthenticated: policy.allowUnauthenticated,
  allowWriteTools: policy.allowWriteTools,
  requireApprovalForAll: policy.requireApprovalForAll,
  maxConnectionsPerUser: String(policy.maxConnectionsPerUser),
});

const splitHosts = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map(host => host.trim())
    .filter(Boolean);

/** Undefined when the form does not parse; the server re-validates either way. */
const fromForm = (form: PolicyForm): CustomMcpPolicy | undefined => {
  const parsed = CustomMcpPolicySchema.safeParse({
    mode: form.enabled ? form.mode : 'off',
    allowedHostPatterns: splitHosts(form.allowedHosts),
    blockedHostPatterns: splitHosts(form.blockedHosts),
    allowUnauthenticated: form.allowUnauthenticated,
    allowWriteTools: form.allowWriteTools,
    requireApprovalForAll: form.requireApprovalForAll,
    maxConnectionsPerUser: Number(form.maxConnectionsPerUser),
  });
  return parsed.success ? parsed.data : undefined;
};

const OrgCustomMcpPolicySection: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const { data: view, isLoading, isError, refetch } = useOrgCustomMcpPolicy(organization.id);
  const {
    data: connections,
    isPending: connectionsPending,
    isError: connectionsError,
    refetch: refetchConnections,
  } = useOrgCustomMcpConnections(organization.id);
  const { data: members } = useGetOrganizationUsers(organization.id);
  const save = useSaveOrgCustomMcpPolicy(organization.id);
  const reset = useResetOrgCustomMcpPolicy(organization.id);
  const [connectionsPage, setConnectionsPage] = useState(1);
  const [connectionsPerPage, setConnectionsPerPage] = useState(20);
  const connectionCount = connections?.length ?? 0;
  const connectionPages = Math.max(1, Math.ceil(connectionCount / connectionsPerPage));
  const currentConnectionsPage = Math.min(connectionsPage, connectionPages);
  if (connectionsPage !== currentConnectionsPage) setConnectionsPage(currentConnectionsPage);
  const visibleConnections = connections?.slice(
    (currentConnectionsPage - 1) * connectionsPerPage,
    currentConnectionsPage * connectionsPerPage
  );
  const [form, setForm] = useState<PolicyForm | null>(null);
  // The policy the form was last loaded from, so a newer one saved elsewhere does not silently
  // replace edits in progress.
  const [loadedFrom, setLoadedFrom] = useState<CustomMcpPolicy | null>(null);

  const [seenView, setSeenView] = useState<OrgCustomMcpPolicyView | undefined>(undefined);

  const load = (next: CustomMcpPolicy) => {
    setForm(toForm(next));
    setLoadedFrom(next);
  };

  // Adjusted during render rather than in an effect (react.dev "adjusting state when a prop
  // changes"), so the first paint after a refetch already shows the right form.
  if (view && view !== seenView) {
    setSeenView(view);
    const unedited = !form || !loadedFrom || JSON.stringify(form) === JSON.stringify(toForm(loadedFrom));
    // Our own save lands here too, with the form already matching what was stored.
    const matchesForm = !!form && JSON.stringify(fromForm(form)) === JSON.stringify(view.policy);
    if (unedited || matchesForm) load(view.policy);
  }

  const memberNames = useMemo(
    () => new Map((members ?? []).map(member => [member.id, member.name || member.email || member.id])),
    [members]
  );

  const policy = useMemo(() => (form ? fromForm(form) : undefined), [form]);
  const changedElsewhere = !!view && !!loadedFrom && JSON.stringify(view.policy) !== JSON.stringify(loadedFrom);
  const dirty = useMemo(
    () => !!view && !!policy && JSON.stringify(policy) !== JSON.stringify(view.policy),
    [policy, view]
  );

  if (isError && !view) {
    return (
      <Alert
        color="danger"
        endDecorator={<Button onClick={() => void refetch()}>Retry</Button>}
        data-testid="org-custom-mcp-policy-error"
      >
        Could not load the connector policy.
      </Alert>
    );
  }

  if (isLoading || !view || !form) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  const update = (patch: Partial<PolicyForm>) => setForm(current => (current ? { ...current, ...patch } : current));
  const busy = save.isPending || reset.isPending;

  return (
    <Stack gap={3} data-testid="org-custom-mcp-policy">
      {!view.platformEnabled && (
        <Alert color="neutral" data-testid="org-custom-mcp-platform-off">
          Custom connectors are turned off on this deployment. This policy applies once they are turned on.
        </Alert>
      )}
      {view.invalidOverride && (
        <Alert color="danger" data-testid="org-custom-mcp-invalid">
          The saved policy is no longer valid, so custom connectors are off for every member. Save or reset it.
        </Alert>
      )}

      {changedElsewhere && (
        <Alert
          color="warning"
          data-testid="org-custom-mcp-changed-elsewhere"
          endDecorator={
            <Button size="sm" variant="soft" color="warning" onClick={() => load(view.policy)}>
              Load latest
            </Button>
          }
        >
          Someone else changed this policy while you were editing. Saving will replace their change.
        </Alert>
      )}

      <Card>
        <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
          <Box>
            <Typography level="title-md">Custom connectors</Typography>
            <Typography level="body-sm">
              Off blocks every member&apos;s custom connector tools. Changes can take up to five minutes to apply across
              the deployment. Members can still remove their connections.
            </Typography>
          </Box>
          <Switch
            checked={form.enabled}
            onChange={event => update({ enabled: event.target.checked })}
            slotProps={{ input: { 'aria-label': 'Custom connectors enabled' } }}
            data-testid="org-custom-mcp-enabled-switch"
          />
        </Stack>
      </Card>

      <Card>
        <Stack gap={2}>
          <FormControl disabled={!form.enabled}>
            <FormLabel>Which servers members may connect</FormLabel>
            <Select
              value={form.mode}
              onChange={(_, value) => value && update({ mode: value as OpenMode })}
              data-testid="org-custom-mcp-mode-select"
            >
              {(Object.keys(MODE_LABELS) as OpenMode[]).map(mode => (
                <Option key={mode} value={mode}>
                  {MODE_LABELS[mode]}
                </Option>
              ))}
            </Select>
          </FormControl>
          {form.mode === 'allowlist' && (
            <FormControl disabled={!form.enabled}>
              <FormLabel>Allowed hosts</FormLabel>
              <Textarea
                minRows={2}
                value={form.allowedHosts}
                onChange={event => update({ allowedHosts: event.target.value })}
                placeholder="mcp.example.com&#10;*.example.com"
                data-testid="org-custom-mcp-allowed-hosts"
              />
              <FormHelperText>One per line. *.example.com covers subdomains but not example.com itself.</FormHelperText>
            </FormControl>
          )}
          <FormControl disabled={!form.enabled}>
            <FormLabel>Blocked hosts</FormLabel>
            <Textarea
              minRows={2}
              value={form.blockedHosts}
              onChange={event => update({ blockedHosts: event.target.value })}
              data-testid="org-custom-mcp-blocked-hosts"
            />
            <FormHelperText>Blocked in every mode.</FormHelperText>
          </FormControl>
          <Switch
            disabled={!form.enabled}
            checked={form.requireApprovalForAll}
            onChange={event => update({ requireApprovalForAll: event.target.checked })}
            endDecorator="Require approval before every tool call"
            data-testid="org-custom-mcp-require-approval-switch"
          />
          <Switch
            disabled={!form.enabled}
            checked={form.allowWriteTools}
            onChange={event => update({ allowWriteTools: event.target.checked })}
            endDecorator="Allow tools that are not marked read-only"
            data-testid="org-custom-mcp-write-tools-switch"
          />
          <Switch
            disabled={!form.enabled}
            checked={form.allowUnauthenticated}
            onChange={event => update({ allowUnauthenticated: event.target.checked })}
            endDecorator="Allow servers that need no sign-in"
            data-testid="org-custom-mcp-unauthenticated-switch"
          />
          <FormControl disabled={!form.enabled} sx={{ maxWidth: 240 }}>
            <FormLabel>Connections per member</FormLabel>
            <Input
              type="number"
              value={form.maxConnectionsPerUser}
              onChange={event => update({ maxConnectionsPerUser: event.target.value })}
              slotProps={{ input: { min: 0, max: CUSTOM_MCP_MAX_CONNECTIONS_PER_USER } }}
              data-testid="org-custom-mcp-max-connections"
            />
            <FormHelperText>Up to {CUSTOM_MCP_MAX_CONNECTIONS_PER_USER}.</FormHelperText>
          </FormControl>
        </Stack>
      </Card>

      <Stack direction="row" gap={1} alignItems="center">
        <Button
          disabled={!policy || !dirty || busy}
          loading={save.isPending}
          onClick={() => policy && save.mutate(policy)}
          data-testid="org-custom-mcp-save-btn"
        >
          Save policy
        </Button>
        <Button
          variant="outlined"
          color="neutral"
          disabled={!view.overridden || busy}
          loading={reset.isPending}
          onClick={() => reset.mutate(undefined, { onSuccess: next => load(next.policy) })}
          data-testid="org-custom-mcp-reset-btn"
        >
          Use platform default
        </Button>
        {!policy && (
          <Typography level="body-sm" color="danger">
            Check the host lists and the connection limit.
          </Typography>
        )}
        {view.overridden ? null : (
          <Typography level="body-sm" color="neutral">
            Using the platform default.
          </Typography>
        )}
      </Stack>

      <Box>
        <Typography level="title-md" sx={{ mb: 1 }}>
          Member connections
        </Typography>
        {connectionsPending ? (
          <Typography level="body-sm" data-testid="org-custom-mcp-connections-loading">
            Loading member connections…
          </Typography>
        ) : connectionsError ? (
          <Alert
            color="danger"
            endDecorator={<Button onClick={() => void refetchConnections()}>Retry</Button>}
            data-testid="org-custom-mcp-connections-error"
          >
            Could not load member connections.
          </Alert>
        ) : connections && connections.length > 0 ? (
          <Stack gap={1}>
            <Table size="sm" data-testid="org-custom-mcp-connections-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Host</th>
                  <th>Member</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleConnections?.map(connection => (
                  <tr key={connection.id}>
                    <td>{connection.displayName}</td>
                    <td>{connection.urlHost}</td>
                    <td>{memberNames.get(connection.userId) ?? connection.userId}</td>
                    <td>
                      <Chip size="sm" color={connection.status === 'blocked_by_policy' ? 'danger' : 'neutral'}>
                        {connection.status}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <PaginationControls
              currentPage={currentConnectionsPage}
              totalPages={connectionPages}
              itemsPerPage={connectionsPerPage}
              totalItems={connectionCount}
              onPageChange={setConnectionsPage}
              onItemsPerPageChange={count => {
                setConnectionsPerPage(count);
                setConnectionsPage(1);
              }}
            />
          </Stack>
        ) : (
          <Typography level="body-sm" data-testid="org-custom-mcp-connections-empty">
            No member has a custom connector in this organization.
          </Typography>
        )}
      </Box>
    </Stack>
  );
};

export default OrgCustomMcpPolicySection;
