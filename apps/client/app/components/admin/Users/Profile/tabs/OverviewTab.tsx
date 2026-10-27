import React, { useState } from 'react';
import { Box, Button, Chip, Input, Stack, Typography } from '@mui/joy';
import { USER_TIMELINE_TYPES, resolveUserStorageLimit, storageLimitToBytes, type AuditEntry } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetUserProductAccess } from '@client/app/hooks/data/entitlements';
import { useUserTimeline } from '@client/app/hooks/data/adminUserTimeline';
import { AuditEntryDrawer } from '@client/app/components/admin/AuditLog/shared';
import UserSubscriptionStatus from '../../Details/UserSubscriptionStatus';
import { Fact, RelativeTime, SectionCard, StatusChip, formatUtc, useUndoToast } from '../../../shared';
import type { ProfileAction } from '../actions/profileActions';
import { useAdminUserUpdate } from '../actions/useAdminUserUpdate';
import { TimelineList, TimelineSkeleton } from './TimelineList';
import { timelineItem } from './timelineItems';
import {
  USER_ROLE_LABELS,
  displayName,
  isManagedTag,
  organizationName,
  userRole,
  type AdminUserProfile,
} from '../userProfileModel';

const RECENT_ACTIVITY_COUNT = 6;
const NOTE_MAX_LENGTH = 2000;

const formatBytes = (bytes: number): string => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
};

/** A small text button for a row-level action inside a fact. */
const RowAction: React.FC<{ onClick: () => void; children: React.ReactNode; 'data-testid': string }> = ({
  onClick,
  children,
  'data-testid': testId,
}) => (
  <Button
    size="sm"
    variant="plain"
    color="neutral"
    onClick={onClick}
    sx={{ minHeight: 24, px: 0.75 }}
    data-testid={testId}
  >
    {children}
  </Button>
);

const HeaderAction: React.FC<{ onClick: () => void; children: React.ReactNode; 'data-testid': string }> = ({
  onClick,
  children,
  'data-testid': testId,
}) => (
  <Button size="sm" variant="plain" color="neutral" onClick={onClick} sx={{ minHeight: 30 }} data-testid={testId}>
    {children}
  </Button>
);

const AccountCard: React.FC<{ user: AdminUserProfile; onAction: (action: ProfileAction) => void }> = ({
  user,
  onAction,
}) => {
  const org = organizationName(user);
  const storage = resolveUserStorageLimit(user);
  const network = user.signupMeta;
  const signupParts = [
    user.acquisition?.signupMethod,
    user.createdAt && formatUtc(new Date(user.createdAt)).split(',')[0],
    network?.country,
  ].filter(Boolean);

  return (
    <SectionCard title="Account" data-testid="user-profile-account-card">
      <Fact label="Username">{user.username && `@${user.username}`}</Fact>
      <Fact label="Email" data-testid="user-profile-fact-email">
        <Stack direction="row" alignItems="center" gap={0.75} flexWrap="wrap">
          <Box component="span" sx={{ overflowWrap: 'anywhere' }}>
            {user.email}
          </Box>
          <StatusChip
            tone={user.emailVerified ? 'good' : 'warn'}
            label={user.emailVerified ? 'Verified' : 'Unverified'}
          />
          <RowAction onClick={() => onAction('emailVerification')} data-testid="user-profile-email-verification-btn">
            {user.emailVerified ? 'Mark unverified' : 'Mark verified'}
          </RowAction>
        </Stack>
      </Fact>
      <Fact label="Organization">{org}</Fact>
      <Fact label="Signup">{signupParts.length > 0 ? signupParts.join(' \u00b7 ') : null}</Fact>
      <Fact label="Two-factor" data-testid="user-profile-fact-mfa">
        {user.mfa?.totpEnabled ? (
          <Stack direction="row" alignItems="center" gap={0.75} flexWrap="wrap">
            Authenticator app
            <RowAction onClick={() => onAction('mfaReset')} data-testid="user-profile-mfa-reset-btn">
              Reset
            </RowAction>
          </Stack>
        ) : (
          'Not set up'
        )}
      </Fact>
      <Fact label="Personal API keys" data-testid="user-profile-fact-key-trust">
        <Stack direction="row" alignItems="center" gap={0.75} flexWrap="wrap">
          {user.apiKeyTrustApproved ? 'Trusted' : 'Usual checks'}
          <RowAction onClick={() => onAction('apiKeyTrust')} data-testid="user-profile-key-trust-btn">
            Change
          </RowAction>
        </Stack>
      </Fact>
      <Fact label="Storage">
        {`${formatBytes(user.currentStorageSize ?? 0)} of ${formatBytes(storageLimitToBytes(storage.limitMb))}`}
      </Fact>
    </SectionCard>
  );
};

const AccessCard: React.FC<{ user: AdminUserProfile; onAction: (action: ProfileAction) => void }> = ({
  user,
  onAction,
}) => {
  const access = useGetUserProductAccess(user.id);
  const held = access.data?.entitlements.filter(row => row.held) ?? [];
  const customTags = (user.tags ?? []).filter(tag => !isManagedTag(tag));

  return (
    <SectionCard
      title="Access"
      action={
        <HeaderAction onClick={() => onAction('role')} data-testid="user-profile-change-role-btn">
          Change role
        </HeaderAction>
      }
      data-testid="user-profile-access-card"
    >
      <Fact label="Role" data-testid="user-profile-fact-role">
        {USER_ROLE_LABELS[userRole(user)]}
      </Fact>
      <Fact label="Product access" data-testid="user-profile-fact-products">
        <Stack direction="row" alignItems="center" gap={0.75} flexWrap="wrap">
          {access.isLoading
            ? '...'
            : held.length === 0
              ? 'None'
              : held.map(row => <StatusChip key={row.key} tone="neutral" label={row.key} />)}
          <RowAction onClick={() => onAction('productAccess')} data-testid="user-profile-product-access-btn">
            Manage
          </RowAction>
        </Stack>
      </Fact>
      <Fact label="Tags" data-testid="user-profile-fact-tags">
        <Stack direction="row" alignItems="center" gap={0.75} flexWrap="wrap">
          {customTags.length === 0
            ? 'None'
            : customTags.map(tag => (
                <Chip key={tag} size="sm" variant="outlined">
                  {tag}
                </Chip>
              ))}
          <RowAction onClick={() => onAction('tags')} data-testid="user-profile-tags-btn">
            Edit
          </RowAction>
        </Stack>
      </Fact>
    </SectionCard>
  );
};

const RecentActivityCard: React.FC<{ userId: string; onViewAll: () => void }> = ({ userId, onViewAll }) => {
  const timeline = useUserTimeline(userId, { types: USER_TIMELINE_TYPES }, { pageSize: RECENT_ACTIVITY_COUNT });
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const items = (timeline.data?.pages[0]?.entries ?? []).map(entry =>
    timelineItem(entry, { onOpenAudit: setSelected, onOpenCredits: onViewAll })
  );

  const body = () => {
    if (timeline.isLoading) return <TimelineSkeleton rows={3} />;
    if (timeline.isError) {
      return (
        <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }}>
          Activity could not be loaded.
        </Typography>
      );
    }
    if (items.length === 0) {
      return (
        <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }}>
          Nothing recorded for this account yet.
        </Typography>
      );
    }
    return (
      <TimelineList
        items={items}
        rowTestId="user-profile-recent-activity-row"
        data-testid="user-profile-recent-activity"
      />
    );
  };

  return (
    <>
      <SectionCard
        title="Recent activity"
        body="custom"
        action={
          <HeaderAction onClick={onViewAll} data-testid="user-profile-view-activity-btn">
            View all
          </HeaderAction>
        }
        data-testid="user-profile-activity-card"
      >
        {body()}
      </SectionCard>
      <AuditEntryDrawer entry={selected} onClose={() => setSelected(null)} />
    </>
  );
};

const NotesCard: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const { currentUser } = useUser();
  const update = useAdminUserUpdate(user.id);
  const showUndo = useUndoToast();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const notes = user.userNotes ?? [];

  const addNote = async () => {
    const note = draft.trim();
    if (!note || saving) return;
    const author = currentUser ? displayName(currentUser) : 'Admin';
    setSaving(true);
    try {
      await update({ userNotes: [...notes, { timestamp: new Date().toISOString(), note, userName: author }] });
      setDraft('');
      showUndo({ message: 'Note added', onUndo: () => update({ userNotes: notes }) });
    } catch {
      // useAdminUserUpdate already toasted; the draft stays so nothing typed is lost.
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Internal notes"
      body="custom"
      action={
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Visible to admins only
        </Typography>
      }
      data-testid="user-profile-notes-card"
    >
      <Stack gap={1.5} sx={{ p: 2 }}>
        {[...notes].reverse().map(note => (
          <Box
            key={`${note.timestamp}-${note.note.slice(0, 16)}`}
            sx={{ p: 1.5, borderRadius: 8, border: '1px solid', borderColor: 'admin.border', bgcolor: 'admin.hover' }}
            data-testid="user-profile-note"
          >
            <Typography level="body-sm" sx={{ color: 'admin.ink', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {note.note}
            </Typography>
            <Stack direction="row" gap={0.5} sx={{ mt: 0.5 }}>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                {note.userName} {'\u00b7'}
              </Typography>
              <RelativeTime at={note.timestamp} />
            </Stack>
          </Box>
        ))}
        <Input
          placeholder="Add a note..."
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void addNote();
            }
          }}
          endDecorator={
            draft.trim() ? (
              <Button
                size="sm"
                loading={saving}
                onClick={() => void addNote()}
                data-testid="user-profile-note-save-btn"
              >
                Add
              </Button>
            ) : undefined
          }
          slotProps={{
            input: { maxLength: NOTE_MAX_LENGTH, 'aria-label': 'Add a note', 'data-testid': 'user-profile-note-input' },
          }}
          sx={{ minHeight: 40 }}
        />
      </Stack>
    </SectionCard>
  );
};

type OverviewTabProps = {
  user: AdminUserProfile;
  onAction: (action: ProfileAction) => void;
  onViewActivity: () => void;
};

/** Two columns of cards that collapse to one below ~700 px (DESIGN_GUIDE.md section 5). */
export const OverviewTab: React.FC<OverviewTabProps> = ({ user, onAction, onViewActivity }) => (
  <Box
    sx={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))',
      gap: 2,
      alignItems: 'start',
    }}
    data-testid="user-profile-overview"
  >
    <Stack gap={2}>
      <AccountCard user={user} onAction={onAction} />
      <AccessCard user={user} onAction={onAction} />
      <SectionCard
        title="Subscription"
        body="custom"
        action={
          <HeaderAction onClick={() => onAction('subscription')} data-testid="user-profile-grant-subscription-btn">
            Grant
          </HeaderAction>
        }
        data-testid="user-profile-subscription-card"
      >
        <Box sx={{ p: 2 }}>
          <UserSubscriptionStatus user={user} />
        </Box>
      </SectionCard>
    </Stack>
    <Stack gap={2}>
      <RecentActivityCard userId={user.id} onViewAll={onViewActivity} />
      <NotesCard user={user} />
    </Stack>
  </Box>
);
