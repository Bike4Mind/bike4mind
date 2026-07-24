import {
  Box,
  Button,
  Chip,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  Modal,
  ModalDialog,
  Skeleton,
  Stack,
  Typography,
} from '@mui/joy';
import { DataLakeIcon } from '@client/app/components/datalake/dataLakeBranding';
import { useDataLakes } from '@client/app/hooks/data/dataLakeWizard';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';

interface DataLakeIngestPickerModalProps {
  open: boolean;
  /** Files already gathered from a drop (folder-traversed). */
  files: File[];
  onClose: () => void;
}

/**
 * Choose which lake a set of dropped files should be ingested into, then hand off to
 * the existing append wizard pre-seeded with those files. Reuses the full upload
 * pipeline (dedup, config, chunk/vectorize) rather than reinventing it - the picker
 * only resolves the target lake and jumps the wizard past the source-selection step.
 */
export default function DataLakeIngestPickerModal({ open, files, onClose }: DataLakeIngestPickerModalProps) {
  const { data: lakes, isLoading } = useDataLakes();
  // Only lakes the caller can write into are valid ingest targets - the list also carries
  // other users' read-only public lakes, which the write path would reject.
  const manageableLakes = lakes?.filter(l => l.canManage);
  const openWizardForLake = useDataLakeWizardStore(s => s.openWizardForLake);
  const setFiles = useDataLakeWizardStore(s => s.setFiles);
  const setStep = useDataLakeWizardStore(s => s.setStep);

  const handlePick = (lake: NonNullable<typeof lakes>[number]) => {
    openWizardForLake({
      id: lake.id,
      slug: lake.slug,
      name: lake.name,
      fileTagPrefix: lake.fileTagPrefix,
      requiredUserTag: lake.requiredUserTag,
      requiredEntitlement: lake.requiredEntitlement,
    });
    setFiles(files);
    // Skip source selection - files are already in hand from the drop.
    setStep('preview');
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        data-testid="datalake-ingest-picker-modal"
        sx={{ width: { xs: '95%', sm: '28rem' }, maxWidth: '28rem' }}
      >
        <DialogTitle>Add to which data lake?</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" sx={{ mb: 1 }}>
            {files.length} {files.length === 1 ? 'file' : 'files'} ready to ingest. Choose a destination lake — you can
            review and configure before uploading.
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
                No data lakes you can add to. Create one from Files → Data Lakes first.
              </Typography>
            </Box>
          ) : (
            <List sx={{ '--ListItem-paddingY': '8px', maxHeight: '40vh', overflow: 'auto' }}>
              {manageableLakes.map(lake => (
                <ListItemButton
                  key={lake.id}
                  data-testid={`datalake-ingest-option-${lake.id}`}
                  onClick={() => handlePick(lake)}
                  sx={{ borderRadius: 'sm', gap: 1 }}
                >
                  <DataLakeIcon sx={{ fontSize: 18, color: 'primary.400' }} />
                  <Typography level="title-sm" noWrap sx={{ flex: 1 }}>
                    {lake.name}
                  </Typography>
                  <Chip size="sm" variant="soft" color="neutral" sx={{ fontSize: '10px' }}>
                    {lake.fileTagPrefix}
                  </Chip>
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', pt: 1 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Cancel
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
}
