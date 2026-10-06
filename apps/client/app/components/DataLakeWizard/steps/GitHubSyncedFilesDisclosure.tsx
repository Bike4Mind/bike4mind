import { useState } from 'react';
import { Box, Link, Stack, Typography } from '@mui/joy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { GITHUB_LAKE_FILE_RULES } from '@bike4mind/common';
import { formatBytes } from '@client/app/utils/folderTreeParser';

/**
 * What a GitHub-fed lake will actually ingest, rendered FROM the filter constants
 * (GITHUB_LAKE_FILE_RULES) rather than described in prose beside them - a hand-written list is the
 * one thing here guaranteed to drift from what the sync does. Collapsed by default: the read-only
 * promise above it is what the user has to read, this is what they check.
 */
export default function GitHubSyncedFilesDisclosure() {
  const [open, setOpen] = useState(false);
  const rules = GITHUB_LAKE_FILE_RULES;

  const row = (label: string, value: string) => (
    <Box>
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        {label}
      </Typography>
      <Typography level="body-xs">{value}</Typography>
    </Box>
  );

  return (
    <Stack gap={0.75} data-testid="github-synced-files-disclosure">
      <Link
        component="button"
        type="button"
        level="body-sm"
        color="neutral"
        aria-expanded={open}
        data-testid="github-synced-files-toggle-btn"
        onClick={() => setOpen(current => !current)}
        endDecorator={open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        sx={{ alignSelf: 'flex-start' }}
      >
        What gets synced
      </Link>
      {open && (
        <Stack gap={0.75} data-testid="github-synced-files-details" sx={{ pl: 0.5 }}>
          {row('File types', rules.extensions.map(extension => `.${extension}`).join(', '))}
          {row('Also included', rules.extensionlessNames.join(', '))}
          {row('Skipped folders', rules.deniedPathSegments.join(', '))}
          {row('Skipped files', rules.deniedFileNames.join(', '))}
          {row(
            'Limits',
            `Files up to ${formatBytes(rules.maxFileBytes)}, up to ${rules.maxCandidates.toLocaleString()} files per sync`
          )}
        </Stack>
      )}
    </Stack>
  );
}
