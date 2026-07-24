import { useRef, useState } from 'react';
import {
  Box,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  Modal,
  ModalDialog,
  Radio,
  Skeleton,
  Stack,
  Typography,
} from '@mui/joy';
import { DataLakeIcon, DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { KnowledgeType } from '@bike4mind/common';
import { createFabFileOnServerWithUpload, updateFabFileOnServer } from '@client/app/utils/filesAPICalls';
import { useDataLakes } from '@client/app/hooks/data/dataLakeWizard';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useSendToDataLakeStore } from '@client/app/stores/useSendToDataLakeStore';

/**
 * App-level singleton (mounted once in ProviderBundle) that picks a data lake and saves
 * arbitrary text into it as a tagged file. Open it from anywhere via
 * `useSendToDataLakeStore.open({ content, fileName, sourceLabel })` rather than mounting a
 * modal per call site - previously one was rendered inside every chat message, so a long
 * session mounted N copies each subscribing to useDataLakes().
 *
 * Composes the existing primitives: create a FabFile (which uploads to S3 and triggers the
 * standard chunk/vectorize pipeline) then tag it with the lake's datalakeTag so it shows up
 * in, and is retrievable from, that lake. No explicit reprocess - that would race the S3
 * ObjectCreated auto-chunk event; we lean on the same pipeline every other upload uses.
 */
export default function SendToDataLakeModal() {
  const { isOpen, content, fileName, mimeType, sourceLabel } = useSendToDataLakeStore();
  const closeStore = useSendToDataLakeStore(s => s.close);
  // Only fetch once the modal opens AND the feature is entitled - otherwise this app-wide
  // singleton fires the admin-gated /api/data-lakes call on every page, which 403s when
  // EnableDataLakes is off. The flag defaults closed while settings load, so no fetch races in.
  const { isFeatureEnabled } = useAdminSettingsCache();
  const { data: lakes, isLoading } = useDataLakes(isOpen && isFeatureEnabled('EnableDataLakes'));
  // Sending a file tags it into the lake - a write - so only lakes the caller can manage are
  // valid targets. The list also carries other users' read-only public lakes; exclude them.
  const manageableLakes = lakes?.filter(l => l.canManage);
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // setSubmitting alone can't stop a second click fired before React commits the
  // re-render - this ref is checked synchronously so a rapid double-click can't
  // slip both calls past the disabled/loading button state.
  const sendingRef = useRef(false);

  const close = () => {
    if (submitting) return;
    setSelectedId(null);
    closeStore();
  };

  const handleSend = async () => {
    if (sendingRef.current) return;
    const lake = manageableLakes?.find(l => l.id === selectedId);
    if (!lake) return;
    sendingRef.current = true;
    setSubmitting(true);
    let created: Awaited<ReturnType<typeof createFabFileOnServerWithUpload>> | undefined;
    try {
      const file = new File([content], fileName, { type: mimeType });
      created = await createFabFileOnServerWithUpload(
        { type: KnowledgeType.FILE, fileName, mimeType, fileSize: file.size },
        file
      );
      await updateFabFileOnServer(created.id, {
        tags: [{ name: lake.datalakeTag, strength: 1 }],
        primaryTag: lake.datalakeTag,
      });
      queryClient.invalidateQueries({ queryKey: ['dataLakeFiles', lake.id] });
      queryClient.invalidateQueries({ queryKey: ['data-lakes'] });
      toast.success(`Saved ${sourceLabel} to “${lake.name}”. It'll be searchable once processing finishes.`);
      setSelectedId(null);
      closeStore();
    } catch (err) {
      // If create succeeded but tagging failed, the file exists in Files but isn't in the
      // lake - say so, so the orphan isn't a mystery (atomic create+tag is a future option).
      const base = err instanceof Error ? err.message : 'Failed to send to data lake';
      const tail = created
        ? ` "${fileName}" was uploaded to your files but not added to the lake — retry, or remove it from Files.`
        : '';
      toast.error(base + tail);
    } finally {
      sendingRef.current = false;
      setSubmitting(false);
    }
  };

  // Shared choke point for every "Send to Data Lake" entry point: with the feature
  // off, never render - even if some (future) ungated caller opens the store, the
  // dead-end empty state must not surface. Mirrors CreateDataLakeButton's gate.
  // Placed after all hooks so the hook order is stable across flag changes.
  if (!isFeatureEnabled('EnableDataLakes')) return null;

  return (
    <Modal open={isOpen} onClose={close}>
      <ModalDialog data-testid="send-to-datalake-modal" sx={{ width: { xs: '95%', sm: '28rem' }, maxWidth: '28rem' }}>
        <DialogTitle>Send to {DATA_LAKE}</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" sx={{ mb: 1 }}>
            Choose a data lake to add “{fileName}”. It will be tagged into the lake and indexed for retrieval.
          </Typography>
          {isLoading ? (
            <Stack gap={1}>
              {[1, 2, 3].map(i => (
                <Skeleton key={i} variant="rectangular" height={48} sx={{ borderRadius: 'md' }} />
              ))}
            </Stack>
          ) : !manageableLakes || manageableLakes.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 3 }}>
              <DataLakeIcon sx={{ fontSize: 36, opacity: 0.3, mb: 1 }} />
              <Typography level="body-sm" color="neutral">
                No data lakes you can add to. Create one first from Files → Data Lakes.
              </Typography>
            </Box>
          ) : (
            <List sx={{ '--ListItem-paddingY': '8px', maxHeight: '40vh', overflow: 'auto' }}>
              {manageableLakes.map(lake => (
                <ListItemButton
                  key={lake.id}
                  data-testid={`send-to-datalake-option-${lake.id}`}
                  selected={selectedId === lake.id}
                  onClick={() => setSelectedId(lake.id)}
                  sx={{ borderRadius: 'sm', gap: 1 }}
                >
                  <Radio checked={selectedId === lake.id} size="sm" />
                  <DataLakeIcon sx={{ fontSize: 18, color: 'primary.400' }} />
                  <Typography level="title-sm" noWrap>
                    {lake.name}
                  </Typography>
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            variant="solid"
            color="primary"
            disabled={!selectedId}
            loading={submitting}
            onClick={handleSend}
            data-testid="send-to-datalake-confirm-btn"
          >
            Send
          </Button>
          <Button variant="plain" color="neutral" disabled={submitting} onClick={close}>
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
