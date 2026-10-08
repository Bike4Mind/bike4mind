import { DialogContent, DialogTitle, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import { GITHUB_LAKE_FILE_RULES } from '@bike4mind/common';

const BYTES_PER_MB = 1024 * 1024;

function RuleRow({ label, values, testId }: { label: string; values: readonly string[]; testId: string }) {
  return (
    <Stack gap={0.25} data-testid={testId}>
      <Typography level="title-sm">{label}</Typography>
      <Typography level="body-sm" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
        {values.join(', ')}
      </Typography>
    </Stack>
  );
}

/**
 * What a GitHub-fed lake syncs and skips, rendered from the GITHUB_LAKE_FILE_RULES the ingest enforces
 * (lakeFileFilter.ts), so the list cannot drift from the behavior it explains.
 */
export default function GitHubLakeSyncRulesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { extensions, extensionlessNames, deniedPathSegments, deniedFileNames, maxFileBytes, maxCandidates } =
    GITHUB_LAKE_FILE_RULES;

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog data-testid="github-sync-rules-modal" sx={{ maxWidth: 520 }}>
        <ModalClose />
        <DialogTitle>Sync rules</DialogTitle>
        <DialogContent>
          <Stack gap={1.5}>
            <Typography level="body-sm">
              A sync reads the default branch and keeps only text and source files. Everything else is skipped.
            </Typography>
            <RuleRow
              label="Synced file types"
              values={extensions.map(extension => `.${extension}`)}
              testId="github-sync-rules-extensions"
            />
            <RuleRow label="Also synced" values={extensionlessNames} testId="github-sync-rules-names" />
            <RuleRow label="Skipped folders" values={deniedPathSegments} testId="github-sync-rules-folders" />
            <RuleRow label="Skipped lockfiles" values={deniedFileNames} testId="github-sync-rules-lockfiles" />
            <Typography level="body-sm" sx={{ color: 'text.secondary' }} data-testid="github-sync-rules-limits">
              Symlinks, binary files and files over {maxFileBytes / BYTES_PER_MB} MB (or your workspace&apos;s upload
              limit, if lower) are skipped. A repository with more than {maxCandidates} matching files is too large to
              sync.
            </Typography>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}
