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
import { useEffect, useRef, useState } from 'react';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
import { useComputeHashes, useCheckDuplicates } from '@client/app/hooks/data/dataLakeWizard';
import { slugifyDataLakeName, MIN_DATA_LAKE_SLUG_LENGTH } from '@client/app/hooks/data/dataLakeSlug';
import { isReservedTagPrefix } from '@bike4mind/common';
import { useGetDataLakes } from '@client/app/hooks/data/dataLakes';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export default function ConfigStep() {
  const theme = useTheme();
  const config = useDataLakeWizardStore(s => s.config);
  const setConfig = useDataLakeWizardStore(s => s.setConfig);
  const setTagPrefix = useDataLakeWizardStore(s => s.setTagPrefix);
  const targetLake = useDataLakeWizardStore(s => s.targetLake);
  const taxonomy = useDataLakeWizardStore(s => s.taxonomy);
  const allFiles = useDataLakeWizardStore(s => s.allFiles);
  const duplicateCheckResults = useDataLakeWizardStore(s => s.duplicateCheckResults);
  const reservedTagPrefix = isReservedTagPrefix(config.tagPrefix);
  const hashingProgress = useDataLakeWizardStore(s => s.hashingProgress);

  const computeHashes = useComputeHashes();
  const checkDuplicates = useCheckDuplicates();

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

  // Client mirror of the server's slug.min(2) rule so a name that slugifies to
  // empty/too-short is caught here instead of failing at the final upload step.
  // Append mode reuses the target lake's real slug (which may be disambiguated,
  // e.g. "niche-2"), so show that rather than what the locked name slugifies to,
  // and only gate creates.
  const slug = targetLake ? targetLake.slug : slugifyDataLakeName(config.name);
  const slugTooShort = !targetLake && config.name.trim().length > 0 && slug.length < MIN_DATA_LAKE_SLUG_LENGTH;

  // Tag Prefix's editable home is the taxonomy step (#829). Config only shows it read-only,
  // EXCEPT the empty-prefix dead-end: the taxonomy step is skippable and inference can yield
  // an empty prefix (e.g. no API key), yet Start Upload still gates on tagPrefix >= 2 chars.
  // When create mode lands here with no usable prefix, fall back to an editable field so the
  // user isn't stranded. Captured once via lazy init so typing in the fallback can't flip it
  // read-only mid-edit; navigating back to taxonomy remounts this step and re-evaluates.
  const [prefixEditable] = useState(() => !targetLake && config.tagPrefix.trim().length < MIN_DATA_LAKE_SLUG_LENGTH);

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

        {/* Name */}
        <FormControl required error={slugTooShort}>
          <FormLabel>{DATA_LAKE} Name</FormLabel>
          <Input
            data-testid="config-name-input"
            value={config.name}
            onChange={e => setConfig({ name: e.target.value })}
            placeholder="e.g. Legal Contracts Knowledge Base"
            disabled={!!targetLake}
          />
          <FormHelperText>
            Slug: <code>{slug || '...'}</code>
          </FormHelperText>
          {slugTooShort && (
            <FormHelperText data-testid="config-name-slug-error">
              This name needs at least {MIN_DATA_LAKE_SLUG_LENGTH} letters or numbers - it currently makes an invalid
              URL slug.
            </FormHelperText>
          )}
          {duplicateNameLake && (
            <FormHelperText data-testid="config-name-duplicate-warning" sx={{ color: 'warning.plainColor' }}>
              A data lake named &ldquo;{duplicateNameLake.name}&rdquo; already exists here. You can still continue -
              both will appear under the same name, with different slugs.
            </FormHelperText>
          )}
        </FormControl>

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

        {/* Tag Prefix - read-only here (its editable home is the taxonomy step in create
            mode, or the target lake in append mode), unless the empty-prefix fallback applies.
            Still flags a reserved prefix even when read-only, so a value inherited from the
            taxonomy step shows its reason here rather than only disabling Start Upload. */}
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
                ? 'All tags will be prefixed with this (must end with ":"). No taxonomy prefix was set, so add one here.'
                : targetLake
                  ? 'Inherited from the existing data lake.'
                  : 'Set on the AI Taxonomy step. Go back there to change it.'}
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
            <Typography level="body-sm">
              Tag categories: <strong>{taxonomy.tags.filter(t => !t.deleted).length}</strong>
            </Typography>
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
