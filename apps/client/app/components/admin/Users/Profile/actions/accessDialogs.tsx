import React, { useId, useState } from 'react';
import { AdminUserTagsSchema } from '@bike4mind/common';
import { Button, Chip, ChipDelete, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetUserTags } from '@client/app/hooks/data/user';
import { useAdminUserTagsUpdate } from './useAdminUserTagsUpdate';
import ProductAccess from '../../ProductAccess';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  ChangePreview,
  SegmentedControl,
  undoAdminReason,
  useUndoToast,
} from '../../../shared';
import { useAdminUserUpdate } from './useAdminUserUpdate';
import type { ProfileDialogProps } from './profileActions';
import { USER_ROLE_LABELS, displayName, isManagedTag, tagsForRole, userRole, type UserRole } from '../userProfileModel';

const ROLE_OPTIONS = (Object.keys(USER_ROLE_LABELS) as UserRole[]).map(value => ({
  value,
  label: USER_ROLE_LABELS[value],
}));

/** Tags in `after` but not `before`, and the reverse, compared case-insensitively. */
export const diffTags = (before: readonly string[], after: readonly string[]) => {
  const has = (list: readonly string[], tag: string) => list.some(item => item.toLowerCase() === tag.toLowerCase());
  return {
    added: after.filter(tag => !has(before, tag)),
    removed: before.filter(tag => !has(after, tag)),
  };
};

const describeTagDiff = ({ added, removed }: ReturnType<typeof diffTags>): string =>
  [added.length > 0 && `+ ${added.join(', ')}`, removed.length > 0 && `\u2212 ${removed.join(', ')}`]
    .filter(Boolean)
    .join('  ') || 'No change';

/**
 * Role is derived from `isAdmin` plus the developer tag, so one change can write both. Only the
 * Super Admin axis carries a stored reason (`roleChangeReason`); the server refuses self-changes and
 * demoting the last Super Admin.
 */
export const ChangeRoleDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const { currentUser } = useUser();
  const update = useAdminUserUpdate(user.id);
  const showUndo = useUndoToast();
  const current = userRole(user);
  const [next, setNext] = useState<UserRole>(current);
  const isSelf = currentUser?.id === user.id;
  const tags = user.tags ?? [];
  const adminChanges = (next === 'super-admin') !== user.isAdmin;

  const write = (role: UserRole, reason: string) =>
    update({
      isAdmin: role === 'super-admin',
      tags: tagsForRole(tags, role),
      ...((role === 'super-admin') !== user.isAdmin && { roleChangeReason: reason }),
    });

  const handleConfirm = async (reason: string) => {
    await write(next, reason);
    onClose();
    showUndo({
      message: `Role changed to ${USER_ROLE_LABELS[next]}`,
      onUndo: () =>
        update({
          isAdmin: user.isAdmin,
          tags,
          ...(adminChanges && { roleChangeReason: undoAdminReason(reason) }),
        }),
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Change role"
      description={`${displayName(user)} is a ${USER_ROLE_LABELS[current]}. Super Admins can see and change every account.`}
      reasonPresets={ADMIN_REASON_PRESETS.roleChange}
      reasonAudited={adminChanges}
      confirmLabel={next === current ? 'Change role' : `Make ${USER_ROLE_LABELS[next]}`}
      tone={next === 'super-admin' || current === 'super-admin' ? 'danger' : 'neutral'}
      blockedReason={isSelf ? 'You cannot change your own role.' : next === current ? 'Pick a different role.' : null}
      onConfirm={handleConfirm}
      data-testid="change-role-dialog"
    >
      <SegmentedControl
        options={ROLE_OPTIONS}
        value={next}
        onChange={setNext}
        aria-label="Role"
        data-testid="change-role-dialog-role"
      />
      <ChangePreview
        before={USER_ROLE_LABELS[current]}
        after={USER_ROLE_LABELS[next]}
        data-testid="change-role-dialog-preview"
      />
    </ActionDialog>
  );
};

/** Free-form tags only: Role and Product access own the managed tags and are left as they are. */
export const ManageTagsDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const update = useAdminUserTagsUpdate(user.id);
  const suggestions = useGetUserTags();
  const suggestionsId = useId();
  const showUndo = useUndoToast();
  const [tags] = useState(() => user.tags ?? []);
  const managed = tags.filter(isManagedTag);
  const [custom, setCustom] = useState<string[]>(() => tags.filter(tag => !isManagedTag(tag)));
  const [input, setInput] = useState('');
  const nextTags = [...managed, ...custom];
  const diff = diffTags(tags, nextTags);
  const unchanged = diff.added.length === 0 && diff.removed.length === 0;
  const validTags = AdminUserTagsSchema.safeParse(nextTags).success;

  const addFromInput = () => {
    const seen = new Set(custom.map(tag => tag.toLowerCase()));
    const fresh = input
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => {
        const normalized = tag.toLowerCase();
        if (!tag || isManagedTag(tag) || seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      });
    if (fresh.length > 0) setCustom(previous => [...previous, ...fresh]);
    setInput('');
  };

  const handleConfirm = async () => {
    const savedTags = await update({ before: tags, tags: nextTags });
    onClose();
    showUndo({
      message: 'Tags updated',
      onUndo: async () => {
        await update({ before: savedTags, tags });
      },
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Edit tags"
      description="Free-form labels for finding and grouping accounts. Role and product access tags are managed in their own actions."
      reasonPresets={ADMIN_REASON_PRESETS.accountTags}
      reasonAudited={false}
      confirmLabel="Save tags"
      blockedReason={
        unchanged
          ? 'Add or remove a tag first.'
          : !validTags
            ? 'Use up to 100 distinct tags of 1 to 64 characters.'
            : null
      }
      onConfirm={handleConfirm}
      data-testid="manage-tags-dialog"
    >
      <Stack direction="row" gap={0.75} flexWrap="wrap" data-testid="user-tags-editor">
        {custom.length === 0 && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            No tags yet.
          </Typography>
        )}
        {custom.map(tag => (
          <Chip
            key={tag}
            variant="outlined"
            endDecorator={
              <ChipDelete
                aria-label={`Remove ${tag}`}
                onDelete={() => setCustom(previous => previous.filter(item => item !== tag))}
                data-testid={`manage-tags-dialog-remove-${tag}-btn`}
              />
            }
          >
            {tag}
          </Chip>
        ))}
      </Stack>
      <FormControl>
        <FormLabel>Add tags</FormLabel>
        <Stack direction="row" gap={1}>
          <Input
            autoFocus
            placeholder="Comma-separated"
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              // Enter adds the tag instead of submitting the dialog.
              if (event.key === 'Enter' && input.trim()) {
                event.preventDefault();
                addFromInput();
              }
            }}
            sx={{ flex: 1 }}
            slotProps={{
              input: {
                list: suggestionsId,
                maxLength: 6500,
                'data-testid': 'manage-tags-dialog-input',
                'aria-label': 'Add tags',
              },
            }}
          />
          <datalist id={suggestionsId} data-testid="user-tags-suggestions">
            {(suggestions.data ?? [])
              .filter(tag => !isManagedTag(tag))
              .map(tag => (
                <option key={tag} value={tag} />
              ))}
          </datalist>
          <Button
            variant="outlined"
            color="neutral"
            onClick={addFromInput}
            disabled={!input.trim()}
            data-testid="manage-tags-dialog-add-btn"
          >
            Add
          </Button>
        </Stack>
      </FormControl>
      <ChangePreview
        before={`${custom.length - diff.added.length + diff.removed.length} tags`}
        after={`${custom.length} tags`}
        delta={{ label: describeTagDiff(diff), tone: 'neutral' }}
        data-testid="manage-tags-dialog-preview"
      />
    </ActionDialog>
  );
};

/** Wraps the ProductAccess panel around a draft of the tags, so grants land as one named change. */
export const ProductAccessDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const update = useAdminUserUpdate(user.id);
  const showUndo = useUndoToast();
  const tags = user.tags ?? [];
  const [draftTags, setDraftTags] = useState<string[]>(tags);
  const diff = diffTags(tags, draftTags);
  const unchanged = diff.added.length === 0 && diff.removed.length === 0;

  const handleConfirm = async () => {
    await update({ tags: draftTags });
    onClose();
    showUndo({ message: 'Product access updated', onUndo: () => update({ tags }), onViewAudit: onAudit });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Product access"
      description={`Grant or revoke a product for ${displayName(user)}. Access from a domain, a subscription or the role is shown but changed elsewhere.`}
      reasonPresets={ADMIN_REASON_PRESETS.productAccess}
      reasonAudited={false}
      confirmLabel="Save access"
      blockedReason={unchanged ? 'Grant or revoke a product first.' : null}
      onConfirm={handleConfirm}
      data-testid="product-access-dialog"
    >
      <ProductAccess
        user={{ ...user, tags: draftTags }}
        onFieldChange={(field, value) => {
          if (field === 'tags' && Array.isArray(value))
            setDraftTags(value.filter((tag): tag is string => typeof tag === 'string'));
        }}
      />
      <ChangePreview
        before={`${tags.length} tags`}
        after={`${draftTags.length} tags`}
        delta={{ label: describeTagDiff(diff), tone: 'neutral' }}
        data-testid="product-access-dialog-preview"
      />
    </ActionDialog>
  );
};
