import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Chip,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Radio,
  RadioGroup,
  Skeleton,
  Stack,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import StorageIcon from '@mui/icons-material/Storage';
import AddIcon from '@mui/icons-material/Add';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import RestoreIcon from '@mui/icons-material/Restore';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useDataLakes } from '@client/app/hooks/data/dataLakeWizard';
import {
  useArchiveDataLake,
  useUnarchiveDataLake,
  useRestoreDeletedDataLake,
  usePermanentDeleteDataLake,
  useCleanupDataLake,
  useUpdateDataLake,
  useSetLakeVisibility,
  useGetArchivedDataLakes,
  useGetDeletedDataLakes,
} from '@client/app/hooks/data/dataLakes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useAccounts } from '@client/app/components/Credits/AccountSelector';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { toast } from 'sonner';
import DataLakeViewer from './DataLakeViewer';

export default function DataLakeListPanel() {
  const { data: dataLakes, isLoading } = useDataLakes();
  const openWizard = useDataLakeWizardStore(s => s.openWizard);
  const openWizardForLake = useDataLakeWizardStore(s => s.openWizardForLake);
  const [viewingLake, setViewingLake] = useState<{ id: string; name: string; tagPrefix: string } | null>(null);
  const [editingLake, setEditingLake] = useState<EditableLake | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<{ id: string; name: string } | null>(null);

  const archiveLake = useArchiveDataLake();
  const unarchiveLake = useUnarchiveDataLake();
  const restoreDeletedLake = useRestoreDeletedDataLake();
  const deleteLake = usePermanentDeleteDataLake();
  const cleanupLake = useCleanupDataLake();

  const { data: archivedLakes } = useGetArchivedDataLakes(showArchived);
  const { data: deletedLakes } = useGetDeletedDataLakes(showDeleted);
  const { isFeatureEnabled } = useAdminSettingsCache();

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  // Shared choke point for every manager entry point: with the feature off the
  // lakes queries 403 and the empty panel is a dead end, so never render - even
  // if some (future) ungated caller opens the manager. Mirrors the render guard
  // in SendToDataLakeModal. Placed after all hooks so the hook order is stable.
  if (!isFeatureEnabled('EnableDataLakes')) return null;

  return (
    <>
      <Box data-testid="datalake-list-panel" sx={{ p: 2 }}>
        {/* pr clears the modal's absolutely-positioned ModalClose (top-right) so the
            Create button doesn't collide with the × when this panel is shown in a modal. */}
        <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 2, pr: 5 }}>
          <Typography level="title-md" startDecorator={<StorageIcon />}>
            Data Lakes
          </Typography>
          <Button size="sm" variant="soft" color="primary" startDecorator={<AddIcon />} onClick={openWizard}>
            Create
          </Button>
        </Stack>

        {isLoading ? (
          <Stack gap={1}>
            {[1, 2, 3].map(i => (
              <Skeleton key={i} variant="rectangular" height={72} sx={{ borderRadius: 'md' }} />
            ))}
          </Stack>
        ) : !dataLakes || dataLakes.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <StorageIcon sx={{ fontSize: 40, opacity: 0.3, mb: 1 }} />
            <Typography level="body-sm" color="neutral">
              No data lakes yet. Create one to organize your files.
            </Typography>
          </Box>
        ) : (
          <Stack gap={1}>
            {dataLakes.map(lake => (
              <Card
                key={lake.id}
                variant="outlined"
                data-testid={`datalake-card-${lake.id}`}
                sx={{ p: 1.5, cursor: 'pointer', '&:hover': { borderColor: 'primary.300' } }}
                onClick={() => setViewingLake({ id: lake.id, name: lake.name, tagPrefix: lake.fileTagPrefix })}
              >
                <Stack direction="row" alignItems="center" gap={1.5}>
                  <StorageIcon sx={{ fontSize: 20, color: 'primary.400' }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography level="title-sm" noWrap>
                      {lake.name}
                    </Typography>
                    <Stack direction="row" gap={0.5} sx={{ mt: 0.25 }}>
                      <Chip size="sm" variant="soft" color="neutral" sx={{ fontSize: '10px' }}>
                        {lake.fileTagPrefix}
                      </Chip>
                      {lake.requiredUserTag && (
                        <Chip size="sm" variant="soft" color="primary" sx={{ fontSize: '10px' }}>
                          {lake.requiredUserTag}
                        </Chip>
                      )}
                    </Stack>
                  </Box>
                  <Tooltip title="Add files" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="primary"
                      data-testid={`datalake-addfiles-btn-${lake.id}`}
                      onClick={e => {
                        stop(e);
                        openWizardForLake({
                          id: lake.id,
                          slug: lake.slug,
                          name: lake.name,
                          fileTagPrefix: lake.fileTagPrefix,
                          requiredUserTag: lake.requiredUserTag,
                          requiredEntitlement: lake.requiredEntitlement,
                        });
                      }}
                    >
                      <AddIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Settings" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="neutral"
                      data-testid={`datalake-settings-btn-${lake.id}`}
                      onClick={e => {
                        stop(e);
                        setEditingLake({
                          id: lake.id,
                          name: lake.name,
                          description: lake.description ?? '',
                          requiredUserTag: lake.requiredUserTag ?? '',
                          requiredEntitlement: lake.requiredEntitlement ?? '',
                          organizationId: lake.organizationId ?? '',
                        });
                      }}
                    >
                      <SettingsOutlinedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Archive" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="warning"
                      data-testid={`datalake-archive-btn-${lake.id}`}
                      onClick={e => {
                        stop(e);
                        archiveLake.mutate(lake.id);
                      }}
                    >
                      <ArchiveOutlinedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Card>
            ))}
          </Stack>
        )}

        {/* Archived (reversible) */}
        <LifecycleSection
          label="Archived"
          open={showArchived}
          onToggle={() => setShowArchived(v => !v)}
          testid="datalake-archived-section"
          emptyText="No archived data lakes."
          lakes={showArchived ? archivedLakes : undefined}
          renderActions={lake => (
            <>
              <Tooltip title="Restore" size="sm">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="success"
                  data-testid={`datalake-restore-btn-${lake.id}`}
                  onClick={() => unarchiveLake.mutate(lake.id)}
                >
                  <UnarchiveOutlinedIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Delete (recoverable)" size="sm">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="danger"
                  data-testid={`datalake-delete-btn-${lake.id}`}
                  onClick={() => deleteLake.mutate(lake.id)}
                >
                  <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </>
          )}
        />

        {/* Deleted (recoverable until purged) */}
        <LifecycleSection
          label="Deleted (recoverable)"
          open={showDeleted}
          onToggle={() => setShowDeleted(v => !v)}
          testid="datalake-deleted-section"
          emptyText="No deleted data lakes."
          lakes={showDeleted ? deletedLakes : undefined}
          renderActions={lake => (
            <>
              <Tooltip title="Restore" size="sm">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="success"
                  data-testid={`datalake-restore-deleted-btn-${lake.id}`}
                  onClick={() => restoreDeletedLake.mutate(lake.id)}
                >
                  <RestoreIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Purge permanently" size="sm">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="danger"
                  data-testid={`datalake-purge-btn-${lake.id}`}
                  onClick={() => setPurgeTarget({ id: lake.id, name: lake.name })}
                >
                  <DeleteForeverIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </>
          )}
        />
      </Box>

      {/* Settings editor */}
      <DataLakeSettingsModal lake={editingLake} onClose={() => setEditingLake(null)} />

      {/* Viewer modal */}
      <Modal open={!!viewingLake} onClose={() => setViewingLake(null)}>
        <ModalDialog
          sx={{
            width: { xs: '95%', md: '80%', lg: '72rem' },
            maxWidth: '72rem',
            height: '80vh',
            p: 0,
            overflow: 'hidden',
          }}
        >
          {viewingLake && (
            <DataLakeViewer
              dataLakeId={viewingLake.id}
              dataLakeName={viewingLake.name}
              tagPrefix={viewingLake.tagPrefix}
              onClose={() => setViewingLake(null)}
            />
          )}
        </ModalDialog>
      </Modal>

      {/* Irreversible purge confirmation */}
      <Modal open={!!purgeTarget} onClose={() => setPurgeTarget(null)}>
        <ModalDialog data-testid="datalake-purge-confirm" role="alertdialog">
          <DialogTitle>Permanently purge data lake?</DialogTitle>
          <DialogContent>
            This irreversibly deletes “{purgeTarget?.name}” and all its files, chunks, and batches. This cannot be
            undone.
          </DialogContent>
          <DialogActions>
            <Button
              variant="solid"
              color="danger"
              data-testid="datalake-purge-confirm-btn"
              loading={cleanupLake.isPending}
              onClick={() => {
                if (purgeTarget) cleanupLake.mutate(purgeTarget.id, { onSuccess: () => setPurgeTarget(null) });
              }}
            >
              Purge permanently
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setPurgeTarget(null)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  );
}

interface EditableLake {
  id: string;
  name: string;
  description: string;
  requiredUserTag: string;
  requiredEntitlement: string;
  /** Current org scope ('' = personal/private). Drives the Visibility control. */
  organizationId: string;
}

/**
 * Edit a lake's metadata (rename, description, access gate). Wires the previously
 * unused useUpdateDataLake hook. Gates can be set or changed but not cleared here -
 * the backend rejects empty values (a deliberate PHI-boundary non-affordance), so we
 * only send a gate field when it's non-empty.
 */
export function DataLakeSettingsModal({ lake, onClose }: { lake: EditableLake | null; onClose: () => void }) {
  const updateLake = useUpdateDataLake();
  const setVisibility = useSetLakeVisibility();
  const { accounts, selectedAccount } = useAccounts();
  // Promotion targets the active account-switcher org, so the toggle is enabled only in a
  // Team context (a non-personal account selected) - matching what the create/visibility
  // calls actually send. `belongsToOrg` (is the user in any org at all) only shapes the hint.
  const activeOrg = selectedAccount && !selectedAccount.personal ? selectedAccount : undefined;
  const belongsToOrg = accounts.some(account => !account.personal);
  const canShareToOrg = !!activeOrg;
  // Current visibility is derived from the lake's org scope (Public/Common is a later phase).
  const visibility: 'private' | 'organization' = lake?.organizationId ? 'organization' : 'private';
  // The org the lake is CURRENTLY scoped to - which for a multi-org owner may not be the
  // active switcher org. Name it from the account list so the "Shared" copy is unambiguous.
  const lakeOrgName = lake?.organizationId
    ? accounts.find(account => account.id === lake.organizationId)?.name
    : undefined;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [requiredUserTag, setRequiredUserTag] = useState('');
  const [requiredEntitlement, setRequiredEntitlement] = useState('');

  // Re-seed the form whenever a different lake is opened for editing.
  useEffect(() => {
    if (lake) {
      setName(lake.name);
      setDescription(lake.description);
      setRequiredUserTag(lake.requiredUserTag);
      setRequiredEntitlement(lake.requiredEntitlement);
    }
  }, [lake]);

  // A gate can be set or changed but not cleared (the backend rejects empty values). If the
  // user blanks a previously-set gate, the Save silently keeps the old value - surface that
  // instead of only showing the generic "Data lake updated" success.
  const clearingUserTag = !!lake?.requiredUserTag && !requiredUserTag.trim();
  const clearingEntitlement = !!lake?.requiredEntitlement && !requiredEntitlement.trim();

  const handleSave = () => {
    if (!lake) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const clearing = clearingUserTag || clearingEntitlement;
    if (clearing) {
      const kept =
        clearingUserTag && clearingEntitlement
          ? 'tag and entitlement were'
          : clearingUserTag
            ? 'tag was'
            : 'entitlement was';
      toast.warning(`Access gates can be changed but not cleared here — the existing ${kept} kept.`);
    }
    // If blanking a gate is the ONLY change, the update is a no-op the backend ignores - skip it so
    // we don't also fire a misleading "Data lake updated" success alongside the warning above.
    const hasOtherChange =
      trimmedName !== lake.name ||
      description.trim() !== lake.description ||
      (!!requiredUserTag.trim() && requiredUserTag.trim() !== lake.requiredUserTag) ||
      (!!requiredEntitlement.trim() && requiredEntitlement.trim() !== lake.requiredEntitlement);
    if (clearing && !hasOtherChange) {
      onClose();
      return;
    }
    updateLake.mutate(
      {
        id: lake.id,
        name: trimmedName,
        description: description.trim(),
        ...(requiredUserTag.trim() ? { requiredUserTag: requiredUserTag.trim() } : {}),
        ...(requiredEntitlement.trim() ? { requiredEntitlement: requiredEntitlement.trim() } : {}),
      },
      { onSuccess: onClose }
    );
  };

  return (
    <Modal open={!!lake} onClose={onClose}>
      <ModalDialog data-testid="datalake-settings-modal" sx={{ width: { xs: '95%', sm: '28rem' }, maxWidth: '28rem' }}>
        <DialogTitle>Data lake settings</DialogTitle>
        <DialogContent>
          <Stack gap={2} sx={{ mt: 1 }}>
            <FormControl required>
              <FormLabel>Name</FormLabel>
              <Input value={name} onChange={e => setName(e.target.value)} data-testid="datalake-settings-name" />
            </FormControl>
            <FormControl>
              <FormLabel>Description</FormLabel>
              <Textarea
                minRows={2}
                maxRows={5}
                value={description}
                onChange={e => setDescription(e.target.value)}
                data-testid="datalake-settings-description"
              />
            </FormControl>
            <FormControl>
              <FormLabel>Visibility</FormLabel>
              <RadioGroup
                orientation="horizontal"
                value={visibility}
                onChange={e => {
                  if (!lake) return;
                  const next = e.target.value as 'private' | 'organization';
                  if (next === visibility) return;
                  setVisibility.mutate({ id: lake.id, visibility: next });
                }}
                data-testid="datalake-settings-visibility"
              >
                <Radio value="private" label="Private" disabled={setVisibility.isPending} />
                <Radio
                  value="organization"
                  label="Organization"
                  disabled={setVisibility.isPending || (!canShareToOrg && visibility !== 'organization')}
                  data-testid="datalake-settings-visibility-org"
                />
              </RadioGroup>
              <FormHelperText>
                {visibility === 'organization'
                  ? `Shared with everyone in ${lakeOrgName ?? 'your organization'}.`
                  : canShareToOrg
                    ? `Not shared with your organization. Sharing will scope it to “${activeOrg?.name}”.`
                    : belongsToOrg
                      ? 'Switch to your team account (top-left account switcher) to share this lake with your organization.'
                      : 'Not shared with an organization. Join one to share a lake with your team.'}
              </FormHelperText>
            </FormControl>
            <FormControl error={clearingUserTag}>
              <FormLabel>Access tag</FormLabel>
              <Input
                value={requiredUserTag}
                onChange={e => setRequiredUserTag(e.target.value)}
                placeholder="e.g. Opti"
                data-testid="datalake-settings-usertag"
              />
              <FormHelperText>
                {clearingUserTag
                  ? 'A gate can’t be cleared here — saving keeps the current tag. Change it instead, or contact an admin to remove it.'
                  : 'Users must hold this tag to access the lake. Can be set or changed, not cleared.'}
              </FormHelperText>
            </FormControl>
            <FormControl error={clearingEntitlement}>
              <FormLabel>Required entitlement</FormLabel>
              <Input
                value={requiredEntitlement}
                onChange={e => setRequiredEntitlement(e.target.value)}
                placeholder="e.g. product:pro"
                data-testid="datalake-settings-entitlement"
              />
              <FormHelperText>
                {clearingEntitlement
                  ? 'A gate can’t be cleared here — saving keeps the current entitlement. Change it instead, or contact an admin to remove it.'
                  : 'Namespaced key (e.g. "product:pro"). Can be set or changed, not cleared.'}
              </FormHelperText>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            variant="solid"
            color="primary"
            loading={updateLake.isPending}
            disabled={!name.trim()}
            onClick={handleSave}
            data-testid="datalake-settings-save-btn"
          >
            Save
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

interface LifecycleSectionLake {
  id: string;
  name: string;
  fileTagPrefix: string;
}

function LifecycleSection({
  label,
  open,
  onToggle,
  testid,
  emptyText,
  lakes,
  renderActions,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testid: string;
  emptyText: string;
  lakes: LifecycleSectionLake[] | undefined;
  renderActions: (lake: LifecycleSectionLake) => React.ReactNode;
}) {
  return (
    <Box sx={{ mt: 2 }} data-testid={testid}>
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        fullWidth
        endDecorator={open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        sx={{ justifyContent: 'space-between' }}
        onClick={onToggle}
        data-testid={`${testid}-toggle`}
      >
        {label}
      </Button>
      {open && (
        <Stack gap={1} sx={{ mt: 1 }}>
          {!lakes ? (
            <Skeleton variant="rectangular" height={56} sx={{ borderRadius: 'md' }} />
          ) : lakes.length === 0 ? (
            <Typography level="body-xs" color="neutral" sx={{ px: 1, py: 1 }}>
              {emptyText}
            </Typography>
          ) : (
            lakes.map(lake => (
              <Card key={lake.id} variant="soft" sx={{ p: 1.5 }} data-testid={`${testid}-card-${lake.id}`}>
                <Stack direction="row" alignItems="center" gap={1.5}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography level="title-sm" noWrap>
                      {lake.name}
                    </Typography>
                    <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '10px', mt: 0.25 }}>
                      {lake.fileTagPrefix}
                    </Chip>
                  </Box>
                  {renderActions(lake)}
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      )}
    </Box>
  );
}
