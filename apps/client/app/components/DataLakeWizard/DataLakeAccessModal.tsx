import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import type {
  DataLakeAccessRole,
  DataLakePrincipalType,
  LakeAccessChannel,
  LakeAccessGrantView,
  LakeAccessHistoryEntry,
  LakeAccessView,
  LakeOwnershipCandidateList,
} from '@bike4mind/common';
import { describeLakeAccessChannel, lakeAccessChannelsComposeConjunctively } from '@bike4mind/common';
import type { ColorPaletteProp } from '@mui/joy';
import {
  useGrantLakeAccess,
  useLakeAccessView,
  useLakeOwnershipCandidates,
  useRevokeLakeAccess,
  useTransferLakeOwnership,
  downloadLakeAccessCsv,
} from '@client/app/hooks/data/dataLakes';
import { toast } from 'sonner';

/** A lake this modal can show access for - just what the entry point already holds. */
export interface AccessViewLake {
  id: string;
  name: string;
}

const fmtDate = (d: Date | string | null | undefined): string =>
  d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

const fmtDateTime = (d: Date | string | null | undefined): string =>
  d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

/**
 * The candidate-cap line for the access-history section, over the same event window as the history
 * below it. A missing pressure object collapses into the SAME "not reported" sentence as a zero
 * signal count: an older server, or a response cached from before the field, must not render as a
 * blank line, which would read as "measured, nothing to report".
 */
const describeCapPressure = (view: LakeAccessView): string => {
  const pressure = view.candidateCapPressure;
  if (!pressure || pressure.turnsWithSignal === 0) return 'Candidate-cap pressure: not reported for this window.';
  const windowScope = view.historyTruncated ? ' in this window' : '';
  const lastRead = pressure.lastAtCapAt ? `, most recently ${fmtDateTime(pressure.lastAtCapAt)}` : '';
  return (
    `Candidate-cap pressure: ${pressure.turnsAtCap} of ${pressure.turnsWithSignal} reported read(s)${windowScope} ` +
    `hit the forced-retrieval candidate cap${lastRead} - a capped read considers only part of the readable library. ` +
    'The cap applies to the whole candidate listing for a turn, so this counts reads of this lake that hit it, not ' +
    'caps this lake caused.'
  );
};

// Keyed by the role enum so a new role fails the build here rather than silently rendering blank.
const ROLE_COLOR: Record<DataLakeAccessRole, ColorPaletteProp> = {
  owner: 'primary',
  curator: 'success',
  reader: 'neutral',
};

function GrantRow({
  grant,
  onRevoke,
  revoking,
}: {
  grant: LakeAccessGrantView;
  onRevoke?: () => void;
  revoking?: boolean;
}) {
  return (
    <tr data-testid="datalake-access-grant-row">
      <td>
        <Typography level="body-sm">{grant.principalName ?? grant.principalId}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {grant.principalType}
        </Typography>
      </td>
      <td>
        <Chip size="sm" color={ROLE_COLOR[grant.role]} variant="soft">
          {grant.role}
        </Chip>
      </td>
      <td>
        <Chip
          size="sm"
          variant="soft"
          color={grant.status === 'active' ? 'success' : 'warning'}
          data-testid={`datalake-access-grant-status-${grant.status}`}
        >
          {grant.status}
        </Chip>
      </td>
      <td>
        <Typography level="body-sm">{grant.grantedByName ?? grant.grantedByUserId}</Typography>
      </td>
      <td>
        <Typography level="body-sm">{fmtDate(grant.grantedAt)}</Typography>
      </td>
      <td>
        <Typography level="body-sm">{grant.expiresAt ? fmtDate(grant.expiresAt) : 'Never'}</Typography>
      </td>
      <td>
        {/* Absent on an ownership row: the server refuses to revoke one (it would silently
            un-transfer the lake), and the UI must not offer what the door rejects. */}
        {onRevoke && (
          <Button
            size="sm"
            variant="plain"
            color="danger"
            onClick={onRevoke}
            // Disabled for the whole table while a revoke is in flight: a second click sends a
            // second DELETE, and the row it names is already gone by then, so the reply reports
            // "no longer had access" for an action that in fact worked.
            disabled={revoking}
            data-testid={`datalake-access-revoke-${grant.principalType}-${grant.principalId}`}
          >
            Revoke
          </Button>
        )}
      </td>
    </tr>
  );
}

function ChannelChip({ channel }: { channel: LakeAccessChannel }) {
  // Rendered text comes from the shared describer so this chip and the CSV export can never drift.
  return (
    <Chip size="md" variant="outlined" color="neutral" data-testid={`datalake-access-channel-${channel.kind}`}>
      {describeLakeAccessChannel(channel)}
    </Chip>
  );
}

function HistoryRow({ entry }: { entry: LakeAccessHistoryEntry }) {
  return (
    <tr data-testid="datalake-access-history-row">
      <td>
        <Typography level="body-sm">{entry.principalName ?? entry.principalId}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {entry.principalKind}
          {entry.onBehalfOfUserId ? ` (for ${entry.onBehalfOfName ?? entry.onBehalfOfUserId})` : ''}
        </Typography>
      </td>
      <td>
        <Typography level="body-sm">{entry.readCount}</Typography>
      </td>
      <td>
        <Typography level="body-sm">{fmtDateTime(entry.lastAccessedAt)}</Typography>
      </td>
      <td>
        <Typography level="body-xs" textColor="text.tertiary">
          {entry.surfaces.join(', ')}
        </Typography>
      </td>
    </tr>
  );
}

/**
 * What the lake's content gate demands, in prose, for the transfer confirmation. Returns null for an
 * ungated lake. Deliberately quotes the raw tag/entitlement key: it is what an owner sees on the
 * lake's own settings, so an invented friendly name would be a second vocabulary for one thing.
 */
function describeLakeGate(gate: LakeOwnershipCandidateList['gate']): string | null {
  if (!gate) return null;
  const parts: string[] = [];
  if (gate.requiredUserTag) parts.push(`the access tag "${gate.requiredUserTag}"`);
  if (gate.requiredEntitlement) parts.push(`the entitlement "${gate.requiredEntitlement}"`);
  return parts.length > 0 ? parts.join(' and ') : null;
}

/**
 * Hand this lake to another member of its organization.
 *
 * Confirm-gated because the actor demotes THEMSELVES: the outgoing owner stays on as a curator, so
 * they keep routine management, but the owner-only powers (transferring again, and the visibility
 * expose gate) move to the recipient. That is reversible only by the new owner, which is exactly why
 * it is worth one deliberate click.
 *
 * The options come from the server, resolved from the owning org's membership by the same rule the
 * transfer itself validates, so this can never offer a teammate the action would then reject. A
 * personal lake has no membership to enumerate, so it explains the path rather than showing an empty
 * picker (see `listLakeOwnershipCandidates`).
 */
function TransferOwnershipDialog({ lakeId, onClose }: { lakeId: string; onClose: () => void }) {
  const { data: candidateList, isLoading, isError } = useLakeOwnershipCandidates(lakeId);
  const transfer = useTransferLakeOwnership();
  const [newOwnerUserId, setNewOwnerUserId] = useState<string | null>(null);

  const candidates = candidateList?.candidates ?? [];
  const orgName = candidateList?.organizationName;
  const gateDescription = describeLakeGate(candidateList?.gate);

  const handleConfirm = async () => {
    if (!newOwnerUserId) return;
    try {
      await transfer.mutateAsync({ id: lakeId, newOwnerUserId });
      onClose();
    } catch {
      // The mutation's onError already surfaced the server's refusal; keep the dialog open so the
      // manager can pick someone else rather than losing their place.
    }
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog data-testid="datalake-transfer-modal" sx={{ width: { xs: '95%', sm: '28rem' } }}>
        <ModalClose data-testid="datalake-transfer-close" />
        <DialogTitle>Transfer ownership</DialogTitle>
        <DialogContent>
          <Stack gap={2} sx={{ pt: 1 }}>
            {isLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }} data-testid="datalake-transfer-loading">
                <CircularProgress size="sm" />
              </Box>
            ) : isError ? (
              // A failed fetch must NOT fall through to the empty-candidates branch below: "no other
              // member can receive this lake" is a claim about the organization's membership, and a
              // request that never arrived cannot support it. The query is retry: false, so one
              // failure is the final answer until the dialog is reopened.
              <Alert color="danger" variant="soft" data-testid="datalake-transfer-error">
                Couldn&apos;t load the member list, so there is no one to choose from here. Close this and try again.
              </Alert>
            ) : candidateList?.scope === 'personal' ? (
              <Alert color="neutral" variant="soft" data-testid="datalake-transfer-personal">
                This lake is personal, so there is no team to transfer it within. Move it into an organization first
                (Settings -&gt; Visibility -&gt; Organization), then transfer it to a member.
              </Alert>
            ) : candidates.length === 0 ? (
              <Alert color="neutral" variant="soft" data-testid="datalake-transfer-no-candidates">
                {orgName
                  ? `No other member of ${orgName} can receive this lake yet. Add them to the organization first.`
                  : 'No other member can receive this lake yet.'}
              </Alert>
            ) : (
              <>
                <Typography level="body-sm">
                  The new owner takes over this lake. You stay on as a curator - you keep managing it, but only the
                  owner can transfer it again or change how it is shared.
                </Typography>
                {/* Ownership bypasses the lake's own content gate (the owner arm of the read decision
                    returns before the tag/entitlement arm runs), and the picker deliberately offers
                    every org member rather than only gate-holders. Saying so is what keeps handing
                    gated content to someone who does not qualify a deliberate choice - contrast
                    publishing a gated lake, which is refused outright. */}
                {gateDescription && (
                  <Alert color="warning" variant="soft" data-testid="datalake-transfer-gate-warning">
                    This lake is gated on {gateDescription}. Ownership overrides that gate: whoever you choose can read
                    everything in the lake, whether or not they satisfy it today.
                  </Alert>
                )}
                <Select
                  placeholder="Choose a new owner"
                  value={newOwnerUserId}
                  onChange={(_event, value) => setNewOwnerUserId(value)}
                  slotProps={{ button: { 'data-testid': 'datalake-transfer-owner-select' } }}
                >
                  {candidates.map(candidate => (
                    <Option
                      key={candidate.userId}
                      value={candidate.userId}
                      data-testid={`datalake-transfer-option-${candidate.userId}`}
                    >
                      {candidate.name ?? candidate.email ?? candidate.userId}
                      {candidate.name && candidate.email ? ` (${candidate.email})` : ''}
                    </Option>
                  ))}
                </Select>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            color="primary"
            disabled={!newOwnerUserId}
            loading={transfer.isPending}
            onClick={handleConfirm}
            data-testid="datalake-transfer-confirm-btn"
          >
            Transfer
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="datalake-transfer-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

/** Tomorrow, as the `min` for an expiry picker: an already-lapsed grant is refused by the server
 *  (it would be filtered out of every active read the moment it landed). */
const tomorrowInputDate = (): string => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** The `YYYY-MM-DD` a date input wants, from a grant row's stored expiry. */
const inputDate = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);

/**
 * The three expiry intents `grantLakeAccess` distinguishes, made explicit in the form because the
 * server cannot infer them: `keep` OMITS `expiresAt` (any existing expiry survives), `never` sends
 * `null` (which CLEARS one), and `on` sends the chosen date. Collapsing `keep` and `never` into one
 * empty field is what made an expiry unremovable - and defaulting to `never` instead would make
 * every routine re-role silently clear one, so the default has to stay `keep`.
 */
type ExpiryMode = 'keep' | 'never' | 'on';

/**
 * Grant one principal access to this lake.
 *
 * `owner` is deliberately absent from the role choices: ownership moves only through
 * transfer-ownership, and the server refuses it here. `curator` is absent for an ORGANIZATION
 * principal for a different reason - there is no principal it could confer management on, since the
 * only grantable org is the lake's own and its admins already manage the lake - so `refuseGrantWrite`
 * refuses it and this form does not offer it.
 *
 * The organization option appears only when the lake HAS an owning org - read off the view's own
 * organization channel rather than fetched, since a grant may name no other org (membership never
 * crosses organizations).
 *
 * A user is named by EMAIL, which is the only identifier a manager sharing outside their own org
 * has, and the only one the server can resolve to a real account before writing a row.
 *
 * Expiry is a three-way choice rather than one optional date - see `ExpiryMode`.
 */
function GrantAccessForm({ view, onClose }: { view: LakeAccessView; onClose: () => void }) {
  const grant = useGrantLakeAccess();
  const ownOrg = view.channels.find(c => c.kind === 'organization');
  const [principalType, setPrincipalType] = useState<DataLakePrincipalType>('user');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<DataLakeAccessRole, 'owner'>>('reader');
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>('keep');
  const [expiresOn, setExpiresOn] = useState('');

  const hasPrincipal = principalType === 'organization' ? !!ownOrg?.value : email.trim().length > 0;
  // An `on` mode with no date would fall through to omitting the key - i.e. silently act as `keep`.
  const canSubmit = hasPrincipal && (expiryMode !== 'on' || !!expiresOn);

  // The row this submit would overwrite, where the form can identify it. An ORGANIZATION principal
  // is addressed by the id the view already carries, so its grant is knowable and its current
  // expiry can be shown and seeded. A `user` principal is addressed by EMAIL and the view resolves
  // names through `userDisplayName`, which deliberately never falls back to an address - so there
  // is nothing here to match a typed email against, and the form cannot know whether one already
  // holds a grant. Hence the standing note below rather than a guess.
  const existingGrant =
    principalType === 'organization' && ownOrg?.value
      ? view.grants.find(g => g.principalType === 'organization' && g.principalId === ownOrg.value)
      : undefined;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    try {
      await grant.mutateAsync({
        id: view.lakeId,
        principalType,
        ...(principalType === 'organization' ? { principalId: ownOrg!.value } : { principalEmail: email.trim() }),
        role,
        // End of the chosen day, so a grant dated today does not lapse the instant it is written.
        // `keep` omits the key entirely; the other two are explicit, null included.
        ...(expiryMode === 'on' && expiresOn
          ? { expiresAt: `${expiresOn}T23:59:59.999Z` }
          : expiryMode === 'never'
            ? { expiresAt: null }
            : {}),
      });
      onClose();
    } catch {
      // The mutation's onError already surfaced the server's refusal - which is the actionable text
      // here ("use transfer ownership instead", "no account was found") - so keep the form open with
      // the manager's input intact rather than making them retype it.
    }
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog data-testid="datalake-grant-modal" sx={{ width: { xs: '95%', sm: '26rem' } }}>
        <ModalClose data-testid="datalake-grant-close" />
        <DialogTitle>Grant access</DialogTitle>
        <DialogContent>
          <Stack gap={2} sx={{ pt: 1 }}>
            <FormControl>
              <FormLabel>Grant to</FormLabel>
              <Select
                value={principalType}
                onChange={(_e, value) => {
                  if (!value) return;
                  setPrincipalType(value);
                  // An org grant can only be a reader, so a curator selection cannot survive the
                  // switch - leaving it would submit a role the server refuses.
                  if (value === 'organization') setRole('reader');
                }}
                slotProps={{ button: { 'data-testid': 'datalake-grant-principal-select' } }}
              >
                <Option value="user" data-testid="datalake-grant-principal-user">
                  A person
                </Option>
                {/* Only the lake OWN organization can be granted - membership never crosses orgs -
                    so a personal lake offers no organization option at all. */}
                {ownOrg && (
                  <Option value="organization" data-testid="datalake-grant-principal-org">
                    Everyone in {ownOrg.label ?? 'the owning organization'}
                  </Option>
                )}
              </Select>
            </FormControl>

            {principalType === 'user' && (
              <FormControl>
                <FormLabel>Email address</FormLabel>
                <Input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  slotProps={{ input: { 'data-testid': 'datalake-grant-email-input' } }}
                />
              </FormControl>
            )}

            <FormControl>
              <FormLabel>Role</FormLabel>
              <Select
                value={role}
                onChange={(_e, value) => value && setRole(value)}
                slotProps={{ button: { 'data-testid': 'datalake-grant-role-select' } }}
              >
                <Option value="reader">Reader - can read this lake</Option>
                {principalType === 'user' && (
                  <Option value="curator">Curator - can also manage its files and settings</Option>
                )}
              </Select>
            </FormControl>

            <FormControl>
              <FormLabel>Expiry</FormLabel>
              <Select
                value={expiryMode}
                onChange={(_e, value) => {
                  if (!value) return;
                  setExpiryMode(value);
                  // Seed the picker from the row being overwritten where one is knowable, so
                  // choosing a date starts from the expiry in force rather than blank.
                  if (value === 'on' && !expiresOn && existingGrant?.expiresAt) {
                    setExpiresOn(inputDate(existingGrant.expiresAt));
                  }
                }}
                slotProps={{ button: { 'data-testid': 'datalake-grant-expiry-mode-select' } }}
              >
                <Option value="keep" data-testid="datalake-grant-expiry-keep">
                  Keep any existing expiry
                </Option>
                <Option value="never" data-testid="datalake-grant-expiry-never">
                  Never expires
                </Option>
                <Option value="on" data-testid="datalake-grant-expiry-on">
                  Expires on a date
                </Option>
              </Select>
              <FormHelperText data-testid="datalake-grant-expiry-help">
                {expiryMode === 'keep'
                  ? existingGrant
                    ? existingGrant.expiresAt
                      ? `Leaves the current expiry of ${fmtDate(existingGrant.expiresAt)} in place.`
                      : 'This grant does not expire today, and will keep not expiring.'
                    : 'A new grant never expires. Re-granting someone who already has access leaves their current expiry untouched - choose one of the other options to change it.'
                  : expiryMode === 'never'
                    ? 'Removes any expiry this principal currently has, making the grant permanent.'
                    : 'Access ends at the end of the chosen day.'}
              </FormHelperText>
            </FormControl>

            {expiryMode === 'on' && (
              <FormControl>
                <FormLabel>Expires on</FormLabel>
                <Input
                  type="date"
                  value={expiresOn}
                  onChange={e => setExpiresOn(e.target.value)}
                  slotProps={{ input: { min: tomorrowInputDate(), 'data-testid': 'datalake-grant-expiry-input' } }}
                />
              </FormControl>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            color="primary"
            disabled={!canSubmit}
            loading={grant.isPending}
            onClick={handleSubmit}
            data-testid="datalake-grant-confirm-btn"
          >
            Grant
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="datalake-grant-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

function AccessViewBody({
  view,
  canTransferOwnership,
  readerGrantsEnforced,
}: {
  view: LakeAccessView;
  canTransferOwnership: boolean;
  readerGrantsEnforced: boolean;
}) {
  const [transferring, setTransferring] = useState(false);
  const [granting, setGranting] = useState(false);
  const revoke = useRevokeLakeAccess();
  return (
    <Stack gap={3} data-testid="datalake-access-body">
      {/* Who can see this: explicit grants */}
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 1 }}>
          <Typography level="title-sm">Members and grants</Typography>
          {/* Shown on the server's say-so, never re-derived here: transferring is NARROWER than the
              manage gate that opened this modal, so a curator sees the table without this control. */}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={() => setGranting(true)}
              data-testid="datalake-access-grant-btn"
            >
              Grant access
            </Button>
            {canTransferOwnership && (
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => setTransferring(true)}
                data-testid="datalake-access-transfer-btn"
              >
                Transfer ownership
              </Button>
            )}
          </Box>
        </Box>
        {granting && <GrantAccessForm view={view} onClose={() => setGranting(false)} />}
        {transferring && <TransferOwnershipDialog lakeId={view.lakeId} onClose={() => setTransferring(false)} />}
        {view.grants.length === 0 ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="datalake-access-grants-empty">
            No explicit grants. Access follows the channels below.
          </Typography>
        ) : (
          <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
            <Table size="sm" stickyHeader data-testid="datalake-access-grants-table">
              <thead>
                <tr>
                  <th>Principal</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Granted by</th>
                  <th>Granted</th>
                  <th>Expires</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {view.grants.map(g => (
                  <GrantRow
                    key={`${g.principalType}:${g.principalId}`}
                    grant={g}
                    onRevoke={
                      g.role === 'owner'
                        ? undefined
                        : () =>
                            revoke.mutate({
                              id: view.lakeId,
                              principalType: g.principalType,
                              principalId: g.principalId,
                            })
                    }
                    revoking={revoke.isPending}
                  />
                ))}
              </tbody>
            </Table>
          </Sheet>
        )}
        {/* The honest disclosure while the read arm is still code-gated off: a reader grant is
            RECORDED and admits nobody, which without this note would look identical to a live one. */}
        {!readerGrantsEnforced && (
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            sx={{ mt: 1 }}
            data-testid="datalake-access-readers-not-enforced"
          >
            Reader grants are recorded but not yet in force - a reader cannot open this lake until grant-based reading
            is enabled for the platform. Owner and curator grants take effect immediately.
          </Typography>
        )}
      </Box>

      {/* Who can see this: gate-based channels */}
      <Box>
        <Typography level="title-sm" sx={{ mb: 1 }}>
          Access channels
        </Typography>
        {view.channels.length === 0 ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="datalake-access-channels-empty">
            Private - reachable only by the owner, managers, and the grants above.
          </Typography>
        ) : (
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }} data-testid="datalake-access-channels">
              {view.channels.map(c => (
                <ChannelChip key={`${c.kind}:${c.value ?? ''}`} channel={c} />
              ))}
            </Box>
            {lakeAccessChannelsComposeConjunctively(view.channels) && (
              <Typography
                level="body-xs"
                textColor="text.tertiary"
                sx={{ mt: 1 }}
                data-testid="datalake-access-channels-compose-note"
              >
                A reader must satisfy all conditions: organization membership is required, and a tag or entitlement
                narrows it further. Effective access is the intersection of these channels, so a member count is an
                upper bound on that channel alone.
              </Typography>
            )}
          </>
        )}
      </Box>

      {/* Who actually read it: audit history */}
      <Box>
        <Typography level="title-sm" sx={{ mb: 0.5 }}>
          Access history
        </Typography>
        {/* Always shown, populated or not: history is a lower bound (only instrumented surfaces emit
            events, and events age out), so neither a row count nor an empty list may be read as the
            complete picture. Stating this only on the empty state would let a populated view read as
            exhaustive. */}
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          sx={{ mb: 1 }}
          data-testid="datalake-access-history-caveat"
        >
          Covers reads through instrumented retrieval surfaces, within the audit retention window. Treat this as a lower
          bound - an empty list is not proof that no one has read this lake.
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 1 }} data-testid="datalake-access-cap-pressure">
          {describeCapPressure(view)}
        </Typography>
        {view.historyTruncated && (
          <Alert
            size="sm"
            color="warning"
            variant="soft"
            sx={{ mb: 1 }}
            data-testid="datalake-access-history-truncated"
          >
            Showing the most recent reads only - the full trail is longer than this view, and the CSV export carries
            this same window (not the complete trail). Read counts and first-read dates below cover
            {view.windowStartsAt ? ` reads since ${fmtDateTime(view.windowStartsAt)}` : ' this window'}, not all time.
          </Alert>
        )}
        {view.history.length === 0 ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="datalake-access-history-empty">
            No reads recorded.
          </Typography>
        ) : (
          <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
            <Table size="sm" stickyHeader data-testid="datalake-access-history-table">
              <thead>
                <tr>
                  <th>Reader</th>
                  <th>Reads</th>
                  <th>Last read</th>
                  <th>Surfaces</th>
                </tr>
              </thead>
              <tbody>
                {view.history.map(h => (
                  <HistoryRow key={`${h.principalKind}:${h.principalId}`} entry={h} />
                ))}
              </tbody>
            </Table>
          </Sheet>
        )}
      </Box>
    </Stack>
  );
}

/**
 * Owner-facing access & membership view (#1672): a manager-only compliance surface answering "who can
 * see this lake" (grants + gate channels) and "who actually read it" (the audit trail), with a CSV
 * export for compliance review. Entry points gate opening this on `canManage`; the server enforces the
 * same, so a non-manager who reached it anyway sees the forbidden state.
 *
 * The VIEW is read-only. Its one write is transferring ownership, which lives here because ownership is
 * the first row of the grants table this shows - and it is gated on the server's own
 * `canTransferOwnership`, which is narrower than the manage gate that opens the modal. The CSV export
 * carries the artifact only, never that per-viewer capability.
 */
export function DataLakeAccessModal({ lake, onClose }: { lake: AccessViewLake | null; onClose: () => void }) {
  const { data, isLoading, isError, error } = useLakeAccessView(lake?.id ?? null, !!lake);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!lake) return;
    setExporting(true);
    try {
      await downloadLakeAccessCsv(lake.id);
    } catch {
      toast.error('Could not export the access view. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal open={!!lake} onClose={onClose}>
      <ModalDialog
        data-testid="datalake-access-modal"
        sx={{ width: { xs: '95%', md: '52rem' }, maxWidth: '52rem', maxHeight: '90vh', overflow: 'auto' }}
      >
        <ModalClose data-testid="datalake-access-close" />
        <DialogTitle>Access and members{lake ? ` - ${lake.name}` : ''}</DialogTitle>
        <DialogContent>
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }} data-testid="datalake-access-loading">
              <CircularProgress size="sm" />
            </Box>
          ) : isError ? (
            <Alert color="danger" variant="soft" data-testid="datalake-access-error">
              {/* A 403 here means the caller can read but not manage the lake - the server's manage gate. */}
              {(error as { response?: { status?: number } })?.response?.status === 403
                ? 'You must be able to manage this data lake to view its access.'
                : "Couldn't load the access view. Please try again."}
            </Alert>
          ) : data ? (
            <Stack gap={2}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                <Typography level="body-xs" textColor="text.tertiary">
                  Generated {fmtDateTime(data.view.generatedAt)}
                </Typography>
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  loading={exporting}
                  onClick={handleExport}
                  data-testid="datalake-access-export-btn"
                >
                  Export CSV
                </Button>
              </Box>
              <AccessViewBody
                view={data.view}
                canTransferOwnership={data.canTransferOwnership}
                readerGrantsEnforced={data.readerGrantsEnforced}
              />
            </Stack>
          ) : null}
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}
