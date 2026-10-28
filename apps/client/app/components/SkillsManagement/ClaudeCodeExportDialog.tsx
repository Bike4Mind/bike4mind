import { FC, useMemo } from 'react';
import {
  Alert,
  Button,
  DialogContent,
  DialogTitle,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Typography,
} from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import { toast } from 'sonner';
import { toAbsoluteUrl, type ISkillFile } from '@bike4mind/common';
import {
  b4mOnlyHints,
  buildClaudeCodeInstallCommand,
  toSkillMd,
  type SkillMdSkill,
} from '@bike4mind/common/utils/skillMd';
import { downloadData } from '@client/app/utils/download';
import ClaudeCodeMarketplaceTab, { type ClaudeCodeMarketplaceTabProps } from './ClaudeCodeMarketplaceTab';

export interface ClaudeCodeExportDialogProps {
  onClose: () => void;
  skill: SkillMdSkill & { allowedTools?: string[]; files?: ISkillFile[] };
  /** App path of the skill or listing page, stamped into the file as its source. */
  sourcePath: string;
  version?: number;
  /** Imported skills and market listings: another author's text. */
  thirdParty: boolean;
  /** A market listing the viewer hasn't imported: the export won't exist in Bike4Mind. */
  showImportHint?: boolean;
  /** An Organization listing: adds a "Team marketplace" tab for the org's Claude Code plugin feed. */
  marketplace?: ClaudeCodeMarketplaceTabProps;
}

/** "Use in Claude Code": copy a one-line installer or download the skill as SKILL.md. */
const ClaudeCodeExportDialog: FC<ClaudeCodeExportDialogProps> = ({
  onClose,
  skill,
  sourcePath,
  version,
  thirdParty,
  showImportHint,
  marketplace,
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
    let command: string;
    try {
      command = buildClaudeCodeInstallCommand(skill.name, content);
    } catch {
      toast.error(`Could not build an install command for "${skill.name}" - use Download instead`);
      return;
    }
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(command))
      .then(() => toast.success(`Copied - paste it into a terminal, then use /${skill.name} in Claude Code`))
      .catch(() => toast.error('Could not copy to the clipboard - use Download instead'));
  };

  const singleSkill = (
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
                May call a Bike4Mind agent ({hints.agents.map(a => `@${a}`).join(', ')}), which doesn&apos;t exist in
                Claude Code.
              </span>
            ) : null}
          </Stack>
        </Alert>
      ) : null}
      {skill.files?.length ? (
        <Alert color="warning" variant="soft" data-testid="skill-claude-code-files-not-included">
          Only SKILL.md is written here; its {skill.files.length} supporting file(s) are not.
          {marketplace ? ' Install it from the Team marketplace tab to get them.' : ''}
        </Alert>
      ) : null}
      {thirdParty ? (
        <Typography level="body-sm" color="warning">
          This is a third-party skill from the Skill Market. Review it before you use it.
        </Typography>
      ) : null}

      <Stack spacing={1}>
        <Typography level="title-sm">macOS / Linux (bash, zsh)</Typography>
        <Button startDecorator={<ContentCopyIcon />} onClick={copyCommand} data-testid="skill-claude-code-copy-cmd">
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
          Save to <code>{skillDir}/SKILL.md</code> (or <code>.claude/skills/{skill.name}/</code> in a repo to share with
          the team). On Windows: <code>%USERPROFILE%\.claude\skills\{skill.name}\SKILL.md</code>.
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          Bike4Mind&apos;s own apps skip this file and keep using your Bike4Mind copy. To customize it for them, delete
          its <code># Bike4Mind-Source:</code> line.
        </Typography>
      </Stack>

      {showImportHint ? (
        <Typography level="body-sm" data-testid="skill-claude-code-import-hint">
          To use it in Bike4Mind too, click Import.
        </Typography>
      ) : null}
    </Stack>
  );

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 560 }} data-testid="skill-claude-code-dialog">
        <ModalClose />
        <DialogTitle data-testid="skill-claude-code-title">
          {marketplace ? 'Use in Claude Code' : `Use /${skill.name} in Claude Code`}
        </DialogTitle>
        <DialogContent>
          {marketplace ? (
            <Tabs defaultValue={0} sx={{ bgcolor: 'transparent' }}>
              <TabList>
                <Tab value={0} data-testid="skill-claude-code-tab-single">
                  Single skill
                </Tab>
                <Tab value={1} data-testid="skill-claude-code-tab-marketplace">
                  Team marketplace
                </Tab>
              </TabList>
              <TabPanel value={0} sx={{ px: 0 }}>
                {singleSkill}
              </TabPanel>
              <TabPanel value={1} sx={{ px: 0 }}>
                <ClaudeCodeMarketplaceTab {...marketplace} />
              </TabPanel>
            </Tabs>
          ) : (
            singleSkill
          )}
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default ClaudeCodeExportDialog;
