import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dropdown,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  ListItemDecorator,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import CloudIcon from '@mui/icons-material/Cloud';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useTheme } from '@mui/joy/styles';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { readDroppedItems } from '@client/app/utils/dropReader';
import { countExcludedFiles, formatBytes } from '@client/app/utils/folderTreeParser';
import { slugifyDataLakeName, MIN_DATA_LAKE_SLUG_LENGTH } from '@client/app/hooks/data/dataLakeSlug';
import { useGetDataLakes } from '@client/app/hooks/data/dataLakes';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';

const supportsWebkitDirectory =
  typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export default function SourceSelectionStep() {
  const theme = useTheme();
  const setFiles = useDataLakeWizardStore(s => s.setFiles);
  const allFiles = useDataLakeWizardStore(s => s.allFiles);
  const config = useDataLakeWizardStore(s => s.config);
  const setConfig = useDataLakeWizardStore(s => s.setConfig);
  const targetLake = useDataLakeWizardStore(s => s.targetLake);
  const optionalSteps = useDataLakeWizardStore(s => s.optionalSteps);
  const setOptionalStep = useDataLakeWizardStore(s => s.setOptionalStep);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const dragCounter = useRef(0);

  // Duplicate-name hint. The visible lake list spans every lake the user can read, but a
  // create only ever collides inside its own org scope (the server disambiguates the slug
  // per-org), so narrow it to the account-switcher scope the create will land in. Must stay
  // in sync with activeOrgId() in hooks/data/dataLakes.ts, which the create path reads at
  // mutation time - matching it on a null selection too is what keeps the hint from ever
  // naming a scope the lake won't land in.
  const { data: allLakes } = useGetDataLakes();
  const selectedAccount = useSelectedAccount(s => s.selectedAccount);
  const scopeOrgId = selectedAccount && !selectedAccount.personal ? selectedAccount.id : undefined;
  const duplicateNameLake =
    targetLake || !config.name.trim()
      ? undefined
      : allLakes?.find(
          lake =>
            (lake.organizationId || undefined) === scopeOrgId && normalizeName(lake.name) === normalizeName(config.name)
        );

  // Client mirror of the server's slug.min(2) rule so a name that slugifies to empty/too-short
  // is caught before the user commits files, instead of failing at the final upload step.
  const slug = slugifyDataLakeName(config.name);
  const slugTooShort = config.name.trim().length > 0 && slug.length < MIN_DATA_LAKE_SLUG_LENGTH;

  const includedFiles = allFiles.filter(f => !f.excluded);
  const includedSize = includedFiles.reduce((sum, f) => sum + f.size, 0);

  // Set webkitdirectory attribute imperatively (non-standard, no JSX type)
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', '');
      folderInputRef.current.setAttribute('directory', '');
    }
  }, []);

  const handleFilesSelected = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      setFiles(files);
      // Disclose auto-exclusions here rather than on the Preview step's mount: Preview is
      // opt-in now, so that was the only place the user learned files had been dropped.
      // setFiles is synchronous, so the freshly parsed tree is already in the store.
      const tree = useDataLakeWizardStore.getState().folderTree;
      const excludedCount = tree ? countExcludedFiles(tree) : 0;
      if (excludedCount > 0) {
        toast.info(`Auto-excluded ${excludedCount} junk file${excludedCount !== 1 ? 's' : ''}`);
      }
    },
    [setFiles]
  );

  const handleFileInputChange = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      handleFilesSelected(Array.from(fileList));
    },
    [handleFilesSelected]
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setIsDragging(false);

      // Use webkitGetAsEntry to traverse directories
      if (e.dataTransfer.items?.length) {
        setIsScanning(true);
        try {
          const files = await readDroppedItems(e.dataTransfer.items);
          handleFilesSelected(files);
        } finally {
          setIsScanning(false);
        }
      } else {
        // Fallback for browsers without items API
        handleFilesSelected(Array.from(e.dataTransfer.files));
      }
    },
    [handleFilesSelected]
  );

  return (
    <Box data-testid="wizard-source-step" sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2.5, p: 3 }}>
      {/* Identity lives here, not on Config: naming the lake before committing files is the
          point of the streamlined flow. Append mode has no name to set - the modal header
          already says which lake the files are joining. */}
      {!targetLake && (
        <FormControl required error={slugTooShort}>
          <FormLabel>{DATA_LAKE} Name</FormLabel>
          <Input
            data-testid="source-name-input"
            value={config.name}
            onChange={e => setConfig({ name: e.target.value })}
            placeholder="e.g. Legal Contracts Knowledge Base"
            autoFocus
          />
          <FormHelperText>
            Slug: <code>{slug || '...'}</code>
          </FormHelperText>
          {slugTooShort && (
            <FormHelperText data-testid="source-name-slug-error">
              This name needs at least {MIN_DATA_LAKE_SLUG_LENGTH} letters or numbers - it currently makes an invalid
              URL slug.
            </FormHelperText>
          )}
          {duplicateNameLake && (
            <FormHelperText data-testid="source-name-duplicate-warning" sx={{ color: 'warning.plainColor' }}>
              A data lake named &ldquo;{duplicateNameLake.name}&rdquo; already exists here. You can still continue -
              both will appear under the same name, with different slugs.
            </FormHelperText>
          )}
        </FormControl>
      )}

      {/* Drag-drop zone */}
      <Box
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        sx={{
          flex: 1,
          minHeight: 200,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          border: '2px dashed',
          borderColor: isDragging ? 'primary.500' : 'divider',
          borderRadius: 'lg',
          bgcolor: isDragging ? (theme.palette.mode === 'dark' ? 'primary.900' : 'primary.50') : 'transparent',
          transition: 'all 0.2s',
          cursor: 'pointer',
        }}
        onClick={() => !isScanning && fileInputRef.current?.click()}
      >
        {isScanning ? (
          <>
            <CircularProgress size="lg" />
            <Typography level="title-lg" textAlign="center">
              Scanning folder contents&hellip;
            </Typography>
            <Typography level="body-sm" color="neutral" textAlign="center">
              Reading all files in the dropped folder
            </Typography>
          </>
        ) : (
          <>
            <CloudUploadIcon sx={{ fontSize: 56, color: isDragging ? 'primary.500' : 'neutral.400' }} />
            <Typography level="title-lg" textAlign="center">
              Drop files or a folder here
            </Typography>
            <Typography level="body-sm" color="neutral" textAlign="center">
              Or use the Upload button below
            </Typography>
          </>
        )}
      </Box>

      {/* Action buttons. A single Upload split-button covers both files and folder selection:
          a browser file input can only be in one mode at a time (webkitdirectory forces folder-only),
          so the two modes live behind one control instead of two top-level buttons. */}
      <Stack direction="row" gap={2} justifyContent="center" flexWrap="wrap">
        {/* Joined split-button built from a flex wrapper rather than ButtonGroup: ButtonGroup's
            child-radius CSS keys off data-first/last-child markers, which the Dropdown wrapper
            around the caret swallows, so it can't round the caret correctly. We square the shared
            edge and round the two outer edges by hand. */}
        <Box sx={{ display: 'inline-flex' }}>
          <Button
            data-testid="wizard-upload-btn"
            variant="solid"
            color="primary"
            startDecorator={<CloudUploadIcon />}
            onClick={() => fileInputRef.current?.click()}
            sx={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
          >
            Upload
          </Button>
          <Dropdown>
            <MenuButton
              data-testid="wizard-upload-menu-btn"
              aria-label="Upload options"
              slots={{ root: Button }}
              slotProps={{
                root: {
                  variant: 'solid',
                  color: 'primary',
                  sx: {
                    px: 1,
                    minWidth: 0,
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    borderLeft: '1px solid',
                    borderLeftColor: 'primary.700', // subtle divider between the two halves
                  },
                },
              }}
            >
              <KeyboardArrowDownIcon />
            </MenuButton>
            {/* zIndex above the wizard Modal (1300) so the menu isn't hidden behind it */}
            <Menu placement="bottom-end" sx={{ zIndex: 1400 }}>
              <MenuItem data-testid="wizard-upload-files-item" onClick={() => fileInputRef.current?.click()}>
                <ListItemDecorator>
                  <InsertDriveFileIcon />
                </ListItemDecorator>
                Upload Files&hellip;
              </MenuItem>
              {supportsWebkitDirectory ? (
                <MenuItem data-testid="wizard-upload-folder-item" onClick={() => folderInputRef.current?.click()}>
                  <ListItemDecorator>
                    <CloudUploadIcon />
                  </ListItemDecorator>
                  Upload Folder&hellip;
                </MenuItem>
              ) : (
                <Tooltip title="Folder upload is not supported in this browser. Please use Chrome, Edge, or Safari.">
                  <span>
                    <MenuItem data-testid="wizard-upload-folder-item" disabled>
                      <ListItemDecorator>
                        <CloudUploadIcon />
                      </ListItemDecorator>
                      Upload Folder&hellip;
                    </MenuItem>
                  </span>
                </Tooltip>
              )}
            </Menu>
          </Dropdown>
        </Box>

        <Tooltip title="Coming soon">
          <span>
            <Button variant="outlined" color="neutral" startDecorator={<CloudIcon />} disabled>
              Connect Google Drive
            </Button>
          </span>
        </Tooltip>
      </Stack>

      {/* Once files are in hand: what was picked up, plus the two opt-in steps. Both default
          off so the minimal path is name + files -> config -> upload; the labels lead with what
          each step gives you, since a step nobody opts into may as well not exist. */}
      {allFiles.length > 0 && (
        <Box
          data-testid="source-selection-summary"
          sx={{
            p: 2,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 'md',
            bgcolor: theme.palette.mode === 'dark' ? 'neutral.900' : 'neutral.50',
          }}
        >
          <Typography level="body-sm" data-testid="source-file-summary">
            <strong>{includedFiles.length.toLocaleString()}</strong> file
            {includedFiles.length === 1 ? '' : 's'} ready ({formatBytes(includedSize)})
            {allFiles.length > includedFiles.length && (
              // Not necessarily "auto-excluded": returning from Preview folds the user's own
              // exclusions into this same count, so the label stays neutral about the cause.
              <Typography component="span" level="body-xs" color="neutral">
                {' '}
                - {(allFiles.length - includedFiles.length).toLocaleString()} excluded
              </Typography>
            )}
          </Typography>

          <Stack gap={1} sx={{ mt: 1.5 }}>
            <Checkbox
              size="sm"
              data-testid="source-toggle-preview"
              checked={optionalSteps.preview}
              onChange={e => setOptionalStep('preview', e.target.checked)}
              label="Review and exclude files - browse the folder tree and drop what you don't want"
            />
            {!targetLake && (
              <Checkbox
                size="sm"
                data-testid="source-toggle-taxonomy"
                checked={optionalSteps.taxonomy}
                onChange={e => setOptionalStep('taxonomy', e.target.checked)}
                label="Suggest tags with AI - auto-tag files by topic so you can filter them later"
              />
            )}
          </Stack>
        </Box>
      )}

      {/* Hidden file inputs */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={e => handleFileInputChange(e.target.files)}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={e => handleFileInputChange(e.target.files)}
      />
    </Box>
  );
}
