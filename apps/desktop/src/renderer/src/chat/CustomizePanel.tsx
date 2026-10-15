import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Tab from '@mui/joy/Tab';
import TabList from '@mui/joy/TabList';
import TabPanel from '@mui/joy/TabPanel';
import Tabs from '@mui/joy/Tabs';
import Typography from '@mui/joy/Typography';
import type { SkillSummary } from '@shared/skills';
import { entryAttentionChip, EntrySection, type ConfigEntry } from './ConfigEntry';
import { CloseIcon, ServerIcon, SlidersIcon, SparkIcon } from './icons';
import { McpServersSettings } from './McpServersSettings';
import { NavItem } from './SessionList';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from './layout';
import { useMcpServers, type McpServersController } from './useMcpServers';
import { useSkills } from './useSkills';

/** What this screen is for, said on the screen so it does not have to be inferred from a name. */
const CUSTOMIZE_INTRO = 'What tools the app can reach.';

function SkillGroup({ title, skills, empty }: { title: string; skills: SkillSummary[]; empty: string }) {
  return (
    <Box component="section" data-testid="skill-group">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.75 }}>
        <Typography level="title-sm">{title}</Typography>
        <Chip size="sm" variant="soft" color="neutral">
          {skills.length}
        </Chip>
      </Stack>
      {skills.length === 0 ? (
        <Sheet variant="soft" sx={{ borderRadius: 'md', px: 1.5, py: 1.25 }}>
          <Typography level="body-sm" textColor="text.tertiary">
            {empty}
          </Typography>
        </Sheet>
      ) : (
        <List
          size="sm"
          sx={{
            p: 0,
            '--ListItem-paddingX': 0,
            '& > li + li': { borderTop: '1px solid', borderColor: 'divider' },
          }}
        >
          {skills.map(skill => (
            <ListItem key={`${skill.source}:${skill.name}`} sx={{ py: 1.25 }} data-testid="customize-skill-row">
              <Stack direction="row" spacing={1.25} sx={{ minWidth: 0, width: '100%', alignItems: 'center' }}>
                <Sheet
                  variant="outlined"
                  sx={{
                    width: 34,
                    height: 34,
                    borderRadius: 'sm',
                    flexShrink: 0,
                    display: 'grid',
                    placeItems: 'center',
                    color: 'text.tertiary',
                  }}
                >
                  <SparkIcon />
                </Sheet>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ minWidth: 0 }}>
                    <Typography level="title-sm" noWrap>
                      /{skill.name}
                    </Typography>
                    {skill.argumentHint && (
                      <Typography level="body-xs" textColor="text.tertiary" noWrap>
                        {skill.argumentHint}
                      </Typography>
                    )}
                  </Stack>
                  <Typography level="body-sm" textColor="text.secondary" noWrap title={skill.description}>
                    {skill.description}
                  </Typography>
                </Box>
                <Chip size="sm" variant="plain" color={skill.source === 'project' ? 'warning' : 'neutral'}>
                  {skill.source === 'project' ? 'Project' : 'Global'}
                </Chip>
              </Stack>
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
}

function skillScope(filePath: string): string | null {
  const parts = filePath.split(/[\\/]+/);
  const claudeIndex = parts.lastIndexOf('.claude');
  if (claudeIndex < 0 || parts[claudeIndex + 1] !== 'skills') return null;
  return parts[claudeIndex + 2] ?? null;
}

function SkillsSettings({ sessionId }: { sessionId: string | null }) {
  const { skills } = useSkills(sessionId);
  const userSkillScopes = new Map<string, SkillSummary[]>();
  for (const skill of skills) {
    if (skill.source !== 'global') continue;
    const scope = skillScope(skill.filePath);
    if (!scope) continue;
    userSkillScopes.set(scope, [...(userSkillScopes.get(scope) ?? []), skill]);
  }
  const userSkillCount = [...userSkillScopes.values()].reduce((total, scopedSkills) => total + scopedSkills.length, 0);

  return (
    <Stack spacing={2.5} data-testid="skills-settings">
      <Box component="section" data-testid="user-skill-scopes">
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Typography level="title-md">Your skills</Typography>
          <Chip size="sm" variant="soft" color="neutral">
            {userSkillCount}
          </Chip>
        </Stack>
        {userSkillScopes.size === 0 ? (
          <Sheet variant="soft" sx={{ borderRadius: 'md', px: 1.5, py: 1.25 }}>
            <Typography level="body-sm" textColor="text.tertiary">
              No skills found in ~/.claude/skills.
            </Typography>
          </Sheet>
        ) : (
          <Stack spacing={2}>
            {[...userSkillScopes].map(([scope, scopedSkills]) => (
              <SkillGroup key={scope} title={scope} skills={scopedSkills} empty="" />
            ))}
          </Stack>
        )}
      </Box>
      <SkillGroup title="Bike4Mind skills" skills={[]} empty="No Bike4Mind account skills loaded." />
    </Stack>
  );
}

function mcpEntry(controller: McpServersController): ConfigEntry {
  const connected = controller.servers.filter(server => server.status === 'connected').length;
  const failed = controller.servers.filter(server => server.status === 'failed').length;
  const tools = controller.servers.reduce((total, server) => total + server.tools.length, 0);

  // A count rather than a list, because the count is what is wrong when something is wrong: a
  // failed server is otherwise indistinguishable from one that simply declared no tools.
  const summary = (() => {
    if (controller.loading) return 'Loading...';
    if (controller.servers.length === 0) return 'None configured';
    if (connected === 0 && failed === 0) return `${controller.servers.length} configured`;
    return `${connected} connected, ${tools} ${tools === 1 ? 'tool' : 'tools'}`;
  })();

  return {
    id: 'mcp',
    icon: <ServerIcon />,
    label: 'MCP servers',
    summary,
    ...(failed > 0 ? { attention: `${failed} failed` } : {}),
    control: <McpServersSettings controller={controller} />,
  };
}

/**
 * Every tool setting, built once and read by both the nav row and the screen.
 *
 * The row needs only `attention` out of this, but it has to come from the same list the screen
 * draws or the badge would be answering a different question from the section it points at.
 * MCP is now the only entry here that can raise one; the chip still honours `attentionColor`,
 * since what the row has to say about an entry is the entry's to decide.
 */
function useCustomizeEntries(): ConfigEntry[] {
  const mcp = useMcpServers();
  return [mcpEntry(mcp)];
}

/**
 * The Customize row in the nav, which opens the screen.
 *
 * It carries the attention badge whether or not the screen is showing. On the old collapse the
 * badge was hidden while open, because the entry it named was then one row below it and the
 * chip was saying the same thing twice; a screen replaces the conversation instead, so nothing
 * about which screen is up changes whether the sidebar should report a dead server.
 *
 * That badge is the whole reason MCP lives here: it used to hold a permanent card in the
 * sidebar for a control that is opened rarely, and the failure count was the only part of that
 * card worth the space.
 */
export function CustomizeNavItem({ onOpen }: { onOpen: () => void }) {
  const entries = useCustomizeEntries();

  return (
    <NavItem
      icon={<SlidersIcon />}
      label="Customize"
      onClick={onOpen}
      end={entryAttentionChip(entries, 'customize-attention-chip')}
      testId="chat-customize-btn"
    />
  );
}

/**
 * "Customize": what tools the app can reach, as a screen beside Artifacts.
 *
 * Each setting is on the page rather than behind a row that opens something else. A list of
 * three links that each lead somewhere would be a navigation step bought with a whole screen -
 * strictly worse than the one-row collapse it replaces - so the screen shows the controls
 * themselves and MCP, the one that used to need a window, is a section like the rest.
 *
 * App preferences, the server and updates are Settings. The two screens say which half they own
 * under their titles, so neither has to be searched for the other's half.
 */
export function CustomizeScreen({ onClose, sessionId = null }: { onClose: () => void; sessionId?: string | null }) {
  const entries = useCustomizeEntries();

  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="customize-panel">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <Stack sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-sm">Customize</Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              {CUSTOMIZE_INTRO}
            </Typography>
          </Stack>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Close customize"
            onClick={onClose}
            data-testid="customize-close-btn"
          >
            <CloseIcon />
          </IconButton>
        </Stack>
      </Box>

      <Tabs defaultValue={0} sx={{ flex: 1, minHeight: 0, bgcolor: 'transparent' }}>
        <Box sx={{ borderBottom: '1px solid', borderColor: 'divider', py: 1 }}>
          <TabList
            variant="plain"
            sx={{
              ...contentColumnSx,
              gap: 0.5,
              bgcolor: 'transparent',
              '& .MuiTab-root': { borderRadius: 'md', minHeight: 34, px: 1.5 },
              '& .Mui-selected': { bgcolor: 'background.level1', boxShadow: 'sm' },
            }}
          >
            <Tab data-testid="customize-skills-tab">Skills</Tab>
            <Tab data-testid="customize-mcp-tab">MCP</Tab>
          </TabList>
        </Box>
        <TabPanel value={0} sx={{ p: 0, flex: 1, ...scrollingColumnHostSx }}>
          <Box sx={{ ...contentColumnSx, py: 2 }}>
            <SkillsSettings sessionId={sessionId} />
          </Box>
        </TabPanel>
        <TabPanel value={1} sx={{ p: 0, flex: 1, ...scrollingColumnHostSx }}>
          <Box sx={{ ...contentColumnSx, py: 2 }}>
            {entries.map(entry => (
              <EntrySection key={entry.id} entry={entry} />
            ))}
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}
