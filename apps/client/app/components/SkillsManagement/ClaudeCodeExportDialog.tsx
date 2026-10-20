import { FC, useMemo } from 'react';
import { Alert, Button, DialogContent, DialogTitle, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import { toast } from 'sonner';
import { b4mOnlyHints, buildClaudeCodeInstallCommand, toAbsoluteUrl, toSkillMd } from '@bike4mind/common';
import { downloadData } from '@client/app/utils/download';

export interface ClaudeCodeExportDialogProps {
  onClose: () => void;
  skill: {
    name: string;
    description: string;
    body: string;
    argumentHint?: string;
    disableModelInvocation?: boolean;
    allowedTools?: string[];
  };
  /** App path of the skill or listing page, stamped into the file as its source. */
  sourcePath: string;
  version?: number;
  /** Imported skills and market listings: another author's text. */
  thirdParty: boolean;
  /** A market listing the viewer hasn't imported: the export won't exist in Bike4Mind. */
  showImportHint?: boolean;
}

/** "Use in Claude Code": copy a one-line installer or download the skill as SKILL.md. */
const ClaudeCodeExportDialog: FC<ClaudeCodeExportDialogProps> = ({
  onClose,
  skill,
  sourcePath,
  version,
  thirdParty,
  showImportHint,
}) => {
  const content = useMemo(
    () =>
      toSkillMd(skill, {
        sourceUrl: toAbsoluteUrl(window.location.origin, sourcePath),
        version,
        exportedAt: new Date(),
        thirdParty,
      }),
    [skill, sourcePath, version, thirdParty]
  );
  const hints = useMemo(() => b4mOnlyHints(skill), [skill]);
  const skillDir = `~/.claude/skills/${skill.name}`;

  const copyCommand = () => {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(buildClaudeCodeInstallCommand(skill.name, content)))
      .then(() => toast.success(`Copied - paste it into a terminal, then use /${skill.name} in Claude Code`))
      .catch(() => toast.error('Could not copy to the clipboard - use Download instead'));
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 560 }} data-testid="skill-claude-code-dialog">
        <ModalClose />
        <DialogTitle>Use /{skill.name} in Claude Code</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            {hints.tools.length || hints.agents.length ? (
              <Alert color="warning" variant="soft" data-testid="skill-claude-code-b4m-only">
                <Stack spacing={0.5}>
                  {hints.tools.length ? (
                    <span>
                      Uses Bike4Mind tools ({hints.tools.join(', ')}) that Claude Code does not have; it may not work as
                      expected.
                    </span>
                  ) : null}
                  {hints.agents.length ? (
                    <span>
                      Calls a Bike4Mind agent ({hints.agents.map(a => `@${a}`).join(', ')}), which doesn&apos;t exist in
                      Claude Code.
                    </span>
                  ) : null}
                </Stack>
              </Alert>
            ) : null}
            {thirdParty ? (
              <Typography level="body-sm" color="warning">
                This is a third-party skill from the Skill Market. Review it before you use it.
              </Typography>
            ) : null}

            <Stack spacing={1}>
              <Typography level="title-sm">macOS / Linux</Typography>
              <Button
                startDecorator={<ContentCopyIcon />}
                onClick={copyCommand}
                data-testid="skill-claude-code-copy-cmd"
              >
                Copy install command
              </Button>
              <Typography level="body-xs" textColor="text.tertiary">
                Paste it into a terminal. It writes <code>{skillDir}/SKILL.md</code>, and Claude Code picks it up as{' '}
                <code>/{skill.name}</code>.
              </Typography>
            </Stack>

            <Stack spacing={1}>
              <Button
                variant="outlined"
                startDecorator={<DownloadIcon />}
                onClick={() => downloadData(content, 'SKILL.md', 'text/markdown')}
                data-testid="skill-claude-code-download"
              >
                Download SKILL.md
              </Button>
              <Typography level="body-xs" textColor="text.tertiary">
                Save to <code>{skillDir}/SKILL.md</code> (or <code>.claude/skills/{skill.name}/</code> in a repo to
                share with the team). On Windows: <code>%USERPROFILE%\.claude\skills\{skill.name}\SKILL.md</code>.
              </Typography>
              <Typography level="body-xs" textColor="text.tertiary">
                Bike4Mind&apos;s own apps skip this file and keep using your Bike4Mind copy. To customize it for them,
                delete its <code># Bike4Mind-Source:</code> line.
              </Typography>
            </Stack>

            {showImportHint ? (
              <Typography level="body-sm" data-testid="skill-claude-code-import-hint">
                To use it in Bike4Mind too, click Import.
              </Typography>
            ) : null}
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default ClaudeCodeExportDialog;
