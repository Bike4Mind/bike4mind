import React, { useId, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  DialogContent,
  Dropdown,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { toast } from 'sonner';
import { ADMIN_SAVED_VIEW_NAME_MAX_LENGTH, AdminSavedViewNameSchema } from '@client/app/utils/adminSavedViews';
import type { AdminUsersSummary } from '@client/app/utils/adminUsersFilter';
import { AdminDialog, ViewTabs, type ViewTab } from '../../shared';
import { adminFocus } from '../../shared/adminStyles';
import type { UsersListParams } from '../usersTabSearch';
import { applyUsersView, USERS_BUILT_IN_VIEWS } from './usersListViews';
import { activeUsersTabId, usersParamsFromSavedView, type UsersSavedViewItem } from './usersSavedViews';
import {
  savedViewErrorMessage,
  useCreateUsersSavedView,
  useDeleteUsersSavedView,
  useUpdateUsersSavedView,
  useUsersSavedViews,
} from './useUsersSavedViews';

export const USERS_SAVED_VIEW_CHIP_TESTID = 'users-saved-view-chip';

type NameDialogProps = {
  title: string;
  submitLabel: string;
  initialName?: string;
  /** Shows the "Share with all admins" checkbox. */
  withShare?: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; shared: boolean }) => Promise<unknown>;
  'data-testid': string;
};

/** Name (and optionally share) a view. Mounted only while open, so each open starts clean. */
function SavedViewNameDialog({
  title,
  submitLabel,
  initialName = '',
  withShare = false,
  onClose,
  onSubmit,
  'data-testid': testId,
}: NameDialogProps) {
  const hintId = useId();
  const [name, setName] = useState(initialName);
  const [shared, setShared] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedName = AdminSavedViewNameSchema.safeParse(name);
  const unchanged = initialName !== '' && parsedName.success && parsedName.data === initialName;
  const hint = !parsedName.success
    ? name.trim().length === 0
      ? 'Name the view.'
      : `Keep the name to ${ADMIN_SAVED_VIEW_NAME_MAX_LENGTH} characters.`
    : unchanged
      ? 'Pick a different name.'
      : null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!parsedName.success || hint || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ name: parsedName.data, shared });
      onClose();
    } catch (submitError) {
      setError(savedViewErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AdminDialog onClose={onClose} title={title} data-testid={testId}>
      <Stack component="form" noValidate onSubmit={handleSubmit} gap={1}>
        <DialogContent sx={{ gap: 2 }}>
          <FormControl required error={!!error}>
            <FormLabel>Name</FormLabel>
            <Input
              autoFocus
              value={name}
              onChange={event => {
                setName(event.target.value);
                setError(null);
              }}
              slotProps={{ input: { 'data-testid': `${testId}-name-input` } }}
            />
            {error && <FormHelperText data-testid={`${testId}-error`}>{error}</FormHelperText>}
          </FormControl>
          {withShare && (
            <Checkbox
              label="Share with all admins"
              checked={shared}
              onChange={event => setShared(event.target.checked)}
              slotProps={{ input: { 'data-testid': `${testId}-share-checkbox` } }}
            />
          )}
        </DialogContent>
        <Stack direction="row" alignItems="center" justifyContent="flex-end" gap={1} flexWrap="wrap" sx={{ pt: 1 }}>
          {hint && (
            <Typography id={hintId} level="body-sm" data-testid={`${testId}-hint`} sx={{ mr: 'auto' }}>
              {hint}
            </Typography>
          )}
          <Button variant="plain" color="neutral" onClick={onClose} data-testid={`${testId}-cancel-btn`}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!!hint}
            loading={submitting}
            aria-describedby={hint ? hintId : undefined}
            data-testid={`${testId}-confirm-btn`}
          >
            {submitLabel}
          </Button>
        </Stack>
      </Stack>
    </AdminDialog>
  );
}

function DeleteSavedViewDialog({
  view,
  onClose,
  onDeleted,
}: {
  view: UsersSavedViewItem;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const deleteView = useDeleteUsersSavedView();
  const handleDelete = async () => {
    try {
      await deleteView.mutateAsync(view.id);
      toast.success(`Deleted view "${view.name}"`);
      onDeleted();
    } catch (error) {
      toast.error(savedViewErrorMessage(error));
    }
  };
  return (
    <AdminDialog onClose={onClose} title="Delete view" role="alertdialog" data-testid="users-saved-view-delete-dialog">
      <DialogContent>
        <Typography level="body-sm">
          Delete &quot;{view.name}&quot;?{view.shared ? ' Other admins will lose it too.' : ''} This cannot be undone.
        </Typography>
      </DialogContent>
      <Stack direction="row" justifyContent="flex-end" gap={1} sx={{ pt: 1 }}>
        <Button variant="plain" color="neutral" onClick={onClose} data-testid="users-saved-view-delete-cancel-btn">
          Cancel
        </Button>
        <Button
          color="danger"
          loading={deleteView.isPending}
          onClick={handleDelete}
          data-testid="users-saved-view-delete-confirm-btn"
        >
          Delete view
        </Button>
      </Stack>
    </AdminDialog>
  );
}

type OwnerAction = 'rename' | 'delete';

function SavedViewMenu({
  view,
  onAction,
  onToggleShared,
}: {
  view: UsersSavedViewItem;
  onAction: (action: OwnerAction) => void;
  onToggleShared: () => void;
}) {
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: {
            size: 'sm',
            variant: 'plain',
            'aria-label': `Options for the ${view.name} view`,
            sx: { ...adminFocus, color: 'admin.inkMuted', minWidth: 28, minHeight: 28, ml: -0.5 },
          },
        }}
        data-testid={`users-saved-view-menu-${view.id}`}
      >
        <MoreHorizIcon sx={{ fontSize: 16 }} />
      </MenuButton>
      <Menu size="sm" placement="bottom-start" sx={{ zIndex: 1300 }}>
        <MenuItem onClick={() => onAction('rename')} data-testid={`users-saved-view-rename-${view.id}`}>
          Rename
        </MenuItem>
        <MenuItem onClick={onToggleShared} data-testid={`users-saved-view-share-${view.id}`}>
          {view.shared ? 'Make personal' : 'Share with all admins'}
        </MenuItem>
        <MenuItem color="danger" onClick={() => onAction('delete')} data-testid={`users-saved-view-delete-${view.id}`}>
          Delete
        </MenuItem>
      </Menu>
    </Dropdown>
  );
}

/**
 * The users list's view tabs: the built-in views, then the admin's own and every shared saved view,
 * with "+ Save view" for the current list. Every view opens through `onApply`, which writes the URL.
 */
export function UsersViewTabs({
  params,
  search,
  summary,
  onApply,
}: {
  params: UsersListParams;
  /** The search box's live text; `params.search` trails it by the debounce, so a quick save would miss it. */
  search: string;
  summary: AdminUsersSummary | undefined;
  /** A patch that carries `search` too, so the caller can mirror it into the search box. */
  onApply: (patch: Partial<UsersListParams> & { search: string }) => void;
}) {
  const savedViewsQuery = useUsersSavedViews();
  const createView = useCreateUsersSavedView();
  const updateView = useUpdateUsersSavedView();
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [ownerAction, setOwnerAction] = useState<{ action: OwnerAction; view: UsersSavedViewItem } | null>(null);

  const savedViews = savedViewsQuery.data ?? [];

  const toggleShared = async (view: UsersSavedViewItem) => {
    try {
      await updateView.mutateAsync({ id: view.id, patch: { shared: !view.shared } });
      toast.success(view.shared ? `"${view.name}" is personal again` : `"${view.name}" is shared with all admins`);
    } catch (error) {
      toast.error(savedViewErrorMessage(error));
    }
  };

  const tabs: ViewTab[] = [
    ...USERS_BUILT_IN_VIEWS.map(view => ({
      id: view.id,
      label: view.label,
      count: summary ? view.count(summary) : undefined,
    })),
    ...savedViews.map(view => ({
      id: view.id,
      label: view.name,
      testId: `${USERS_SAVED_VIEW_CHIP_TESTID}-${view.id}`,
      title: view.shared ? (view.isOwner ? 'Shared with all admins' : 'Shared by another admin') : undefined,
      startDecorator: view.shared ? <GroupOutlinedIcon sx={{ fontSize: 14 }} aria-hidden /> : undefined,
      menu: view.isOwner ? (
        <SavedViewMenu
          view={view}
          onAction={action => setOwnerAction({ action, view })}
          onToggleShared={() => void toggleShared(view)}
        />
      ) : undefined,
    })),
  ];

  const onSelect = (id: string) => {
    const builtIn = USERS_BUILT_IN_VIEWS.find(view => view.id === id);
    if (builtIn) {
      onApply({ ...applyUsersView(builtIn), search: '' });
      return;
    }
    const saved = savedViews.find(view => view.id === id);
    if (saved) onApply({ ...usersParamsFromSavedView(saved.view), search: saved.view.params.search ?? '' });
  };

  return (
    <>
      <ViewTabs
        aria-label="Saved views"
        data-testid="admin-users-views"
        activeId={activeUsersTabId(params, savedViews) ?? ''}
        views={tabs}
        onSelect={onSelect}
        trailing={
          <Button
            ref={saveButtonRef}
            size="sm"
            variant="plain"
            color="neutral"
            startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
            onClick={() => setSaving(true)}
            data-testid="users-save-view-btn"
            sx={{ ...adminFocus, flexShrink: 0, minHeight: 34, color: 'admin.inkMuted', fontWeight: 500 }}
          >
            Save view
          </Button>
        }
      />
      {saving && (
        <SavedViewNameDialog
          title="Save view"
          submitLabel="Save view"
          withShare
          data-testid="users-save-view-dialog"
          onClose={() => setSaving(false)}
          onSubmit={async ({ name, shared }) => {
            await createView.mutateAsync({ name, shared, params: { ...params, search } });
            toast.success(`Saved view "${name}"`);
          }}
        />
      )}
      {ownerAction?.action === 'rename' && (
        <SavedViewNameDialog
          title="Rename view"
          submitLabel="Rename view"
          initialName={ownerAction.view.name}
          data-testid="users-rename-view-dialog"
          onClose={() => setOwnerAction(null)}
          onSubmit={async ({ name }) => {
            await updateView.mutateAsync({ id: ownerAction.view.id, patch: { name } });
            toast.success(`Renamed view to "${name}"`);
          }}
        />
      )}
      {ownerAction?.action === 'delete' && (
        <DeleteSavedViewDialog
          view={ownerAction.view}
          onClose={() => setOwnerAction(null)}
          // The deleted tab and its menu are gone, so focus would fall to the page; keep it in the row.
          onDeleted={() => {
            setOwnerAction(null);
            saveButtonRef.current?.focus();
          }}
        />
      )}
    </>
  );
}
