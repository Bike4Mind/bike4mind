import { FC, useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import KeyIcon from '@mui/icons-material/Key';
import { toast } from 'sonner';
import { ApiKeyScope, claudeMarketplaceNameFor, claudeSkillNameFor, toAbsoluteUrl } from '@bike4mind/common';
import { usePublicConfig } from '@client/app/hooks/data/settings';
import { useCreateUserApiKey } from '@client/app/hooks/data/userApiKeys';
import type { MarketMe, MyListing } from '@client/app/hooks/data/skillMarket';
import ClaudeCodeBundles from './ClaudeCodeBundles';

export interface ClaudeCodeMarketplaceTabProps {
  org: { id: string; name: string };
  /** The listing's stored `claudePluginName`, exactly as the feed serves it. */
  pluginName?: string;
  /**
   * The listing's `name`, denormalized from its approved version: the feed
   * (server/skillMarket/claudeMarketplace.ts) slugs the same name into the plugin's skill folder.
   */
  skillName?: string;
}

/** The author's approved Organization listing of `skillId` in an org they still belong to, as the tab's props. */
export const findMarketplaceListing = (
  listings: MyListing[] | undefined,
  skillId: string,
  orgs: MarketMe['organizations'] | undefined
): ClaudeCodeMarketplaceTabProps | undefined => {
  for (const listing of listings ?? []) {
    if (
      listing.sourceSkillId !== skillId ||
      listing.visibility !== 'organization' ||
      listing.status !== 'approved' ||
      listing.hiddenByReports ||
      !listing.currentApprovedVersionId
    ) {
      continue;
    }
    const org = orgs?.find(o => o.id === listing.organizationId);
    if (org) return { org, pluginName: listing.claudePluginName, skillName: listing.name };
  }
  return undefined;
};

const KEY_PLACEHOLDER = 'b4m_<your skills:read key>';

/**
 * "Team marketplace" tab of the "Use in Claude Code" dialog: a Claude Code settings entry for the
 * org's plugin feed (pages/api/v1/skills/market/claude-marketplace.json.ts). `skills:read` is a
 * confined scope, so the New-Key modals don't offer it and the key is minted here instead.
 */
const ClaudeCodeMarketplaceTab: FC<ClaudeCodeMarketplaceTabProps> = ({ org, pluginName, skillName }) => {
  const { data: config, isPending, refetch } = usePublicConfig();
  const [key, setKey] = useState<string | null>(null);
  const createKey = useCreateUserApiKey({ onSuccess: result => setKey(result.key) });

  if (isPending) return <Typography level="body-sm">Loading marketplace settings...</Typography>;
  if (!config?.apiUrl) {
    return (
      <Stack spacing={1}>
        <Typography color="danger">Could not load the marketplace address.</Typography>
        <Button data-testid="skill-claude-code-marketplace-retry" onClick={() => void refetch()}>
          Retry
        </Button>
      </Stack>
    );
  }

  const marketplace = claudeMarketplaceNameFor(org.id);
  const feedUrl = toAbsoluteUrl(
    config.apiUrl,
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
        Add {org.name}&apos;s approved Skill Market skills to Claude Code as plugins. New approved versions and removals
        from the market reach Claude Code when the marketplace refreshes (see updates below), not instantly.
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
          The key can read Skill Market marketplace feeds and plugin archives for every organization you belong to. It
          is stored in plain text in your settings file, and Claude Code also copies it into{' '}
          <code>~/.claude/plugins/known_marketplaces.json</code>.
          {key
            ? ' It is shown only once; revoke it any time under API Keys.'
            : ' Each Create key mints a new key, so revoke any old marketplace keys under API Keys.'}
        </Typography>
        <Alert color="warning" variant="soft" data-testid="skill-claude-code-key-warning">
          <Typography level="body-xs">
            Only add this to your own <code>~/.claude/settings.json</code>, never to a project&apos;s{' '}
            <code>.claude/settings.json</code>: that file is usually committed, which would share your key. To keep the
            key out of files, Claude Code v2.1.238+ can run a <code>headersHelper</code> command that prints the{' '}
            <code>Authorization</code> header instead of storing <code>headers</code>.
          </Typography>
        </Alert>
        <Typography level="body-xs" textColor="text.tertiary" data-testid="skill-claude-code-marketplace-update">
          <code>autoUpdate: true</code> makes Claude Code check this marketplace during an interactive session, up to
          about 10 minutes after your first message. Updated skills load after <code>/reload-plugins</code> or at the
          next start. To update now, run <code>claude plugin marketplace update {marketplace}</code>, then{' '}
          <code>
            claude plugin update {pluginName ?? '<plugin>'}@{marketplace}
          </code>
          , then <code>/reload-plugins</code> or restart.
        </Typography>
      </Stack>

      <Stack spacing={1}>
        <Typography level="title-sm">2. Start Claude Code once, then install</Typography>
        <Typography level="body-xs" data-testid="skill-claude-code-marketplace-setup">
          Claude Code registers this marketplace only after <code>claude</code> has started once with these settings: an
          interactive session (log in and trust the folder), or <code>claude -p &quot;hi&quot;</code> from a script.
          Until then, <code>claude plugin marketplace update</code> says the marketplace is not found.{' '}
          <code>claude plugin marketplace add &lt;url&gt;</code> can&apos;t send the key, so use the settings entry
          above instead.
        </Typography>
        {pluginName ? (
          <>
            <Typography
              component="pre"
              level="body-xs"
              sx={{ m: 0 }}
              data-testid="skill-claude-code-marketplace-install"
            >
              /plugin install {pluginName}@{marketplace}
            </Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              Or from a shell:
            </Typography>
            <Typography
              component="pre"
              level="body-xs"
              sx={{ m: 0 }}
              data-testid="skill-claude-code-marketplace-install-shell"
            >
              claude plugin install {pluginName}@{marketplace}
            </Typography>
          </>
        ) : null}
        <Typography level="body-xs" textColor="text.tertiary">
          {pluginName ? 'Or run' : 'Run'} <code>/plugin</code> to browse every skill in the marketplace.
        </Typography>
      </Stack>

      {pluginName && skillName ? (
        <Stack spacing={1}>
          <Typography level="title-sm">3. Use it</Typography>
          <Typography component="pre" level="body-xs" sx={{ m: 0 }} data-testid="skill-claude-code-marketplace-invoke">
            /{pluginName}:{claudeSkillNameFor(skillName)}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary">
            Plugin skills are namespaced by their plugin, so use this instead of the single-skill name.
          </Typography>
        </Stack>
      ) : null}
      <ClaudeCodeBundles orgId={org.id} marketplace={marketplace} />
    </Stack>
  );
};

export default ClaudeCodeMarketplaceTab;
