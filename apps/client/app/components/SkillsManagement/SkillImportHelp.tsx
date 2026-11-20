import { FC, useState } from 'react';
import {
  Button,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Typography,
} from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { copyTextWithToast } from '@client/app/utils/copyToClipboard';
import { SKILL_IMPORT_CLAUDE_CODE_PROMPT, SKILL_IMPORT_RULES } from './skillImportRules';

export const SkillImportHelp: FC = () => {
  const [open, setOpen] = useState(false);

  const copyPrompt = () =>
    void copyTextWithToast(
      SKILL_IMPORT_CLAUDE_CODE_PROMPT,
      'Copied - paste it into Claude Code and replace <name> with your skill'
    );

  return (
    <>
      <IconButton
        size="sm"
        variant="plain"
        aria-label="SKILL.md import rules"
        onClick={() => setOpen(true)}
        data-testid="skill-form-import-help-btn"
      >
        <HelpOutlineIcon />
      </IconButton>
      <Modal open={open} onClose={() => setOpen(false)}>
        <ModalDialog sx={{ maxWidth: 560 }} data-testid="skill-form-import-help-dialog">
          <ModalClose />
          <DialogTitle>Importing a SKILL.md</DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <List marker="disc" size="sm" data-testid="skill-form-import-help-rules">
                {SKILL_IMPORT_RULES.map(rule => (
                  <ListItem key={rule}>{rule}</ListItem>
                ))}
              </List>
              <Stack spacing={1}>
                <Button
                  startDecorator={<ContentCopyIcon />}
                  onClick={copyPrompt}
                  data-testid="skill-form-import-help-copy-btn"
                >
                  Copy prompt for Claude Code
                </Button>
                <Typography level="body-xs" textColor="text.tertiary">
                  Paste it into Claude Code to fix a local skill so it imports cleanly.
                </Typography>
              </Stack>
            </Stack>
          </DialogContent>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default SkillImportHelp;
