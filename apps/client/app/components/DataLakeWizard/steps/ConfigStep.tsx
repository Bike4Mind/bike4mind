import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  LinearProgress,
  Radio,
  RadioGroup,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { useEffect, useRef } from 'react';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useComputeHashes, useCheckDuplicates } from '@client/app/hooks/data/dataLakeWizard';
import { slugifyDataLakeName } from '@client/app/hooks/data/dataLakeSlug';
// The name, its slug rule, and the duplicate-name hint moved to the source step (#824), so
// their imports live there now; only the reserved-prefix guard is still needed here.
import { isReservedTagPrefix } from '@bike4mind/common';

export default function ConfigStep() {
  const theme = useTheme();
  const config = useDataLakeWizardStore(s => s.config);
  const setConfig = useDataLakeWizardStore(s => s.setConfig);
  const setTagPrefix = useDataLakeWizardStore(s => s.setTagPrefix);
  const targetLake = useDataLakeWizardStore(s => s.targetLake);
  const optionalSteps = useDataLakeWizardStore(s => s.optionalSteps);
  const allFiles = useDataLakeWizardStore(s => s.allFiles);
  const duplicateCheckResults = useDataLakeWizardStore(s => s.duplicateCheckResults);
  const reservedTagPrefix = isReservedTagPrefix(config.tagPrefix);
  const hashingProgress = useDataLakeWizardStore(s => s.hashingProgress);

  const computeHashes = useComputeHashes();
  const checkDuplicates = useCheckDuplicates();

  // Append mode reuses the target lake's real slug (which may be disambiguated, e.g.
  // "niche-2"), so show that rather than what its name slugifies to. Name and slug are set
  // on the source step; they appear here read-only in the summary.
  const slug = targetLake ? targetLake.slug : slugifyDataLakeName(config.name);

  // The Tag Prefix's only editable home is here (the taxonomy step, its former competing
  // owner, was removed - AI tag suggestion now runs post-upload and never touches the prefix).
  // Append mode always inherits the target lake's.
  const prefixEditable = !targetLake;

  const autoTriggered = useRef(false);

  const includedFiles = allFiles.filter(f => !f.excluded);
  const includedCount = includedFiles.length;
  const duplicateCount = includedFiles.filter(f => f.isDuplicate).length;

  // Auto-trigger hashing on first mount
  useEffect(() => {
    if (autoTriggered.current) return;
    if (hashingProgress.status === 'idle' && includedCount > 0) {
      autoTriggered.current = true;
      computeHashes.mutate();
    }
  }, []);

  // Auto-trigger dedup check after hashing completes
  useEffect(() => {
    if (hashingProgress.status === 'done' && !duplicateCheckResults && !checkDuplicates.isPending) {
      checkDuplicates.mutate();
    }
  }, [hashingProgress.status]);

  const hashPct = hashingProgress.total > 0 ? Math.round((hashingProgress.completed / hashingProgress.total) * 100) : 0;

  return (
    <Box data-testid="wizard-config-step" sx={{ flex: 1, p: 3, overflow: 'auto' }}>
      <Stack gap={2.5} sx={{ maxWidth: 560 }}>
        {/* Append mode: files go into the existing lake; identity fields are locked. */}
        {targetLake && (
          <Alert color="primary" variant="soft">
            <Box>
              <Typography level="title-sm">Adding files to “{targetLake.name}”</Typography>
              <Typography level="body-xs">
                These files join the existing lake (prefix <code>{targetLake.fileTagPrefix}</code>
                {targetLake.requiredUserTag ? `, access tag “${targetLake.requiredUserTag}”` : ''}). Name, prefix, and
                access tag can’t be changed here - edit them in the lake’s settings.
              </Typography>
            </Box>
          </Alert>
        )}

        {/* Hashing progress */}
        {hashingProgress.status === 'hashing' && (
          <Alert color="neutral" startDecorator={<CircularProgress size="sm" />}>
            <Box sx={{ flex: 1 }}>
              <Typography level="body-sm">Computing file hashes for deduplication... {hashPct}%</Typography>
              <LinearProgress determinate value={hashPct} sx={{ mt: 0.5, height: 4 }} />
            </Box>
          </Alert>
        )}

        {/* Dedup check in progress */}
        {checkDuplicates.isPending && (
          <Alert color="neutral" startDecorator={<CircularProgress size="sm" />}>
            Checking for duplicate files...
          </Alert>
        )}

        {/* Description */}
        <FormControl>
          <FormLabel>Description</FormLabel>
          <Textarea
            value={config.description}
            onChange={e => setConfig({ description: e.target.value })}
            placeholder="What is this data lake for?"
            minRows={2}
            maxRows={4}
          />
        </FormControl>

        {/* Tag Prefix - editable here only when no other step owns it (see prefixEditable);
            read-only when the taxonomy step is in the flow, locked in append mode. Still flags
            a reserved prefix even when read-only, so a value inherited from the taxonomy step
            shows its reason here rather than only disabling Start Upload. */}
        <FormControl required={prefixEditable} error={reservedTagPrefix}>
          <FormLabel>Tag Prefix</FormLabel>
          <Input
            data-testid="config-tag-prefix-input"
            value={config.tagPrefix}
            onChange={e => setTagPrefix(e.target.value)}
            onBlur={e => {
              const v = e.target.value.trim();
              if (v && !v.endsWith(':')) {
                setTagPrefix(v + ':');
              }
            }}
            placeholder="e.g. legal:"
            sx={{ fontFamily: 'monospace' }}
            disabled={!prefixEditable}
          />
          <FormHelperText data-testid="datalake-config-tagprefix-help">
            {reservedTagPrefix
              ? '"datalake:" is reserved for lake membership. Pick another prefix, such as legal:'
              : prefixEditable
                ? 'All tags will be prefixed with this (must end with ":"). Derived from the name - change it if you like.'
                : 'Inherited from the existing data lake.'}
          </FormHelperText>
        </FormControl>

        {/* Required User Tag */}
        <FormControl>
          <FormLabel>Access Tag (optional)</FormLabel>
          <Input
            value={config.requiredUserTag}
            onChange={e => setConfig({ requiredUserTag: e.target.value })}
            placeholder="e.g. LegalTeam"
            disabled={!!targetLake}
          />
          <FormHelperText>
            If set, only users with this tag can access this data lake. Leave blank to keep it private to you (share it
            later from the lake&apos;s settings). Can be changed or removed there too.
          </FormHelperText>
        </FormControl>

        {/* Required Entitlement (optional) */}
        <FormControl>
          <FormLabel>Required Entitlement (optional)</FormLabel>
          <Input
            value={config.requiredEntitlement}
            onChange={e => setConfig({ requiredEntitlement: e.target.value })}
            placeholder="e.g. product:pro"
            disabled={!!targetLake}
            sx={{ fontFamily: 'monospace' }}
          />
          <FormHelperText>
            If set, users holding this entitlement key can access the lake (in addition to the access tag, if any). Must
            be namespaced (contain &quot;:&quot;). Leave blank for tag-only access.
          </FormHelperText>
        </FormControl>

        {/* Conflict Resolution — only show if duplicates found */}
        {duplicateCheckResults && duplicateCheckResults.duplicateCount > 0 && (
          <FormControl>
            <FormLabel>Duplicate File Handling</FormLabel>
            <Typography level="body-xs" color="warning" sx={{ mb: 1 }}>
              {duplicateCount} of {includedCount} files already exist in your knowledge base
            </Typography>
            <RadioGroup
              value={config.conflictResolution}
              onChange={e => setConfig({ conflictResolution: e.target.value as 'skip' | 'update' | 'duplicate' })}
            >
              <Radio value="skip" label="Skip duplicates (recommended)" />
              <Radio value="update" label="Re-upload and replace existing" />
              <Radio value="duplicate" label="Upload as new copies" />
            </RadioGroup>
          </FormControl>
        )}

        {/* Summary Card */}
        <Box
          sx={{
            p: 2,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 'md',
            bgcolor: theme.palette.mode === 'dark' ? 'neutral.900' : 'neutral.50',
          }}
        >
          <Typography level="title-sm" sx={{ mb: 1 }}>
            Upload Summary
          </Typography>
          <Stack gap={0.5}>
            {/* Name is set on the source step; echo it here so the last screen before upload
                still shows what is about to be created. */}
            <Typography level="body-sm" data-testid="config-summary-name">
              {targetLake ? 'Adding to' : 'Name'}: <strong>{config.name || '-'}</strong>
              {slug && (
                <Typography component="span" level="body-xs" color="neutral">
                  {' '}
                  (<code>{slug}</code>)
                </Typography>
              )}
            </Typography>
            <Typography level="body-sm">
              Files to upload:{' '}
              <strong>
                {config.conflictResolution === 'skip'
                  ? (includedCount - duplicateCount).toLocaleString()
                  : includedCount.toLocaleString()}
              </strong>
              {config.conflictResolution === 'skip' && duplicateCount > 0 && (
                <Typography component="span" level="body-xs" color="neutral">
                  {' '}
                  ({duplicateCount} skipped)
                </Typography>
              )}
            </Typography>
            {optionalSteps.taxonomy && !targetLake && (
              <Typography level="body-sm" color="neutral">
                AI tag suggestions will run in the background after upload - review them from the Data Lakes list.
              </Typography>
            )}
            {duplicateCheckResults && (
              <Typography level="body-sm" color={duplicateCheckResults.duplicateCount > 0 ? 'warning' : 'success'}>
                Duplicates: <strong>{duplicateCheckResults.duplicateCount}</strong>
                {duplicateCheckResults.duplicateCount > 0 && ` (will ${config.conflictResolution})`}
              </Typography>
            )}
            {!duplicateCheckResults && hashingProgress.status === 'done' && (
              <Typography level="body-sm" color="neutral">
                Duplicate check: pending...
              </Typography>
            )}
          </Stack>
        </Box>

        {/* Re-check button */}
        {duplicateCheckResults && (
          <Button
            variant="outlined"
            color="neutral"
            size="sm"
            loading={checkDuplicates.isPending}
            onClick={() => checkDuplicates.mutate()}
            sx={{ alignSelf: 'flex-start' }}
          >
            Re-check Duplicates
          </Button>
        )}
      </Stack>
    </Box>
  );
}
