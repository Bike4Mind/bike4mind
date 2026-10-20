import { FC, useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import KeyIcon from '@mui/icons-material/Key';
import { toast } from 'sonner';
import { ApiKeyScope, claudeMarketplaceNameFor, claudeSkillNameFor, toAbsoluteUrl } from '@bike4mind/common';
import { useCreateUserApiKey } from '@client/app/hooks/data/userApiKeys';

export interface ClaudeCodeMarketplaceTabProps {
  org: { id: string; name: string };
  skillName: string;
}

const KEY_PLACEHOLDER = 'b4m_<your skills:read key>';

/**
 * "Team marketplace" tab of the "Use in Claude Code" dialog: a Claude Code settings entry for the
 * org's plugin feed (pages/api/v1/skills/market/claude-marketplace.json.ts). `skills:read` is a
 * confined scope, so the New-Key modals don't offer it and the key is minted here instead.
 */
const ClaudeCodeMarketplaceTab: FC<ClaudeCodeMarketplaceTabProps> = ({ org, skillName }) => {
  const [key, setKey] = useState<string | null>(null);
  const createKey = useCreateUserApiKey({ onSuccess: result => setKey(result.key) });

  const marketplace = claudeMarketplaceNameFor(org);
  const feedUrl = toAbsoluteUrl(
    window.location.origin,
    `/api/v1/skills/market/claude-marketplace.json?orgId=${encodeURIComponent(org.id)}`
  );
  const settings = JSON.stringify(
    {
      extraKnownMarketplaces: {
        [marketplace]: {
          source: { source: 'url', url: feedUrl, headers: { Authorization: `Bearer ${key ?? KEY_PLACEHOLDER}` } },
          autoUpdate: true,
        },
      },
    },
    null,
    2
  );

  const copy = (text: string, done: string) =>
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => toast.success(done))
      .catch(() => toast.error('Could not copy to the clipboard - select the text and copy it instead'));

  return (
    <Stack spacing={2}>
      <Typography level="body-sm">
        Add {org.name}&apos;s approved Skill Market skills to Claude Code as plugins. They update when a new version is
        approved, and are uninstalled when a skill is removed from the market (applied at the next Claude Code session
        after the marketplace refreshes).
      </Typography>

      <Stack spacing={1}>
        <Typography level="title-sm">1. Add this to ~/.claude/settings.json</Typography>
        <Typography
          component="pre"
          level="body-xs"
          sx={{ m: 0, p: 1, borderRadius: 'sm', bgcolor: 'background.level1', overflowX: 'auto' }}
          data-testid="skill-claude-code-marketplace-settings"
        >
          {settings}
        </Typography>
        <Stack direction="row" spacing={1}>
          {key ? null : (
            <Button
              variant="outlined"
              startDecorator={<KeyIcon />}
              loading={createKey.isPending}
              onClick={() =>
                createKey.mutate({ name: `Claude Code marketplace (${org.name})`, scopes: [ApiKeyScope.SKILLS_READ] })
              }
              data-testid="skill-claude-code-create-key"
            >
              Create key
            </Button>
          )}
          <Button
            startDecorator={<ContentCopyIcon />}
            onClick={() => copy(settings, 'Copied - merge it into ~/.claude/settings.json')}
            data-testid="skill-claude-code-copy-settings"
          >
            Copy settings
          </Button>
        </Stack>
        <Typography level="body-xs" textColor="text.tertiary">
          The key can only read this feed, but it is stored in plain text in your settings file.
          {key
            ? ' It is shown only once; revoke it any time under API Keys.'
            : ' Each Create key mints a new key, so revoke any old marketplace keys under API Keys.'}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          Claude Code does not auto-update third-party marketplaces by default; <code>autoUpdate: true</code> above
          turns it on. Without it, run <code>/plugin marketplace update {marketplace}</code> to pick up changes.
        </Typography>
      </Stack>

      <Stack spacing={1}>
        <Typography level="title-sm">2. Start claude once, then install</Typography>
        <Typography component="pre" level="body-xs" sx={{ m: 0 }} data-testid="skill-claude-code-marketplace-install">
          /plugin install {claudeSkillNameFor(skillName)}@{marketplace}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          Or run <code>/plugin</code> to browse every skill in the marketplace. An org admin can roll the same{' '}
          <code>extraKnownMarketplaces</code> entry out to everyone through Claude Code managed settings.
        </Typography>
      </Stack>
    </Stack>
  );
};

export default ClaudeCodeMarketplaceTab;
