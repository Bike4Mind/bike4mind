import { memo, useCallback, useEffect, useId, useMemo, useReducer, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Tab from '@mui/joy/Tab';
import TabList from '@mui/joy/TabList';
import TabPanel from '@mui/joy/TabPanel';
import Tabs from '@mui/joy/Tabs';
import Typography from '@mui/joy/Typography';
import type { SkillMarketImport, SkillMarketListingRef } from '@shared/skillMarket';
import type { SkillSummary } from '@shared/skills';
import { entryAttentionChip, EntrySection, type ConfigEntry } from './ConfigEntry';
import { ChevronIcon, CloseIcon, ExternalLinkIcon, SearchIcon, ServerIcon, SlidersIcon, SparkIcon } from './icons';
import { McpServersSettings } from './McpServersSettings';
import { NavItem } from './SessionList';
import {
  COLLAPSE_ABOVE_GROUPS,
  filterSkillGroups,
  rememberAllExpansion,
  rememberedExpansion,
  rememberGroupExpansion,
  type SkillGroupModel,
} from './skillGroups';
import { skillChipColor, skillSourceLabel } from './skillMenu';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from './layout';
import { useMcpServers, type McpServersController } from './useMcpServers';
import { useSkills } from './useSkills';
import { useSkillUpload } from './SkillUploadDialog';

/** What this screen is for, said on the screen so it does not have to be inferred from a name. */
const CUSTOMIZE_INTRO = 'What tools the app can reach.';

/** An account skill's server id, out of the `b4m:/api/skills/<id>` path SkillCatalog gives it. */
function accountSkillId(skill: SkillSummary): string | null {
  return skill.source === 'account' ? (/^b4m:\/api\/skills\/(.+)$/.exec(skill.filePath)?.[1] ?? null) : null;
}

const SkillRow = memo(function SkillRow({
  skill,
  imports,
  onOpenListing,
  onUpload,
}: {
  skill: SkillSummary;
  /** Market imports by skill id, for the update badge. Only the account group passes it. */
  imports?: ReadonlyMap<string, SkillMarketImport>;
  onOpenListing?: (listing: SkillMarketListingRef) => void;
  /** Upload a local skill to the account. Account rows never offer it. */
  onUpload?: (skill: SkillSummary) => void;
}) {
  const id = accountSkillId(skill);
  const imported = id ? imports?.get(id) : undefined;
  return (
    <ListItem sx={{ py: 1.25 }} data-testid="customize-skill-row">
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
        {imported?.updateAvailable && onOpenListing && (
          <Button
            size="sm"
            variant="soft"
            color="primary"
            onClick={() => onOpenListing({ id: imported.listingId })}
            data-testid="customize-skill-update-btn"
          >
            Update available
          </Button>
        )}
        {skill.imported && (
          <Chip size="sm" variant="soft" color="warning" data-testid="customize-skill-imported-chip">
            Imported
          </Chip>
        )}
        <Chip size="sm" variant="plain" color={skillChipColor(skill.source)} data-testid="customize-skill-chip">
          {skillSourceLabel(skill.source)}
        </Chip>
        {onUpload && skill.source !== 'account' && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => onUpload(skill)}
            data-testid="skill-row-upload-btn"
          >
            Upload
          </Button>
        )}
        {id && (
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label={`Open /${skill.name} on the web`}
            title="Edit, share or delete on the web"
            onClick={() => void window.b4m.skillMarket.openOnWeb({ kind: 'skill', id })}
            data-testid="customize-skill-web-btn"
          >
            <ExternalLinkIcon />
          </IconButton>
        )}
      </Stack>
    </ListItem>
  );
});

const skillListSx = {
  p: 0,
  '--ListItem-paddingX': 0,
  '& > li + li': { borderTop: '1px solid', borderColor: 'divider' },
} as const;

// Memoized with SkillRow so a toggle redraws only the group it flips, not every open row.
const SkillGroup = memo(function SkillGroup({
  group,
  open,
  onToggle,
  empty,
  imports,
  onOpenListing,
  onUpload,
}: {
  group: SkillGroupModel;
  open: boolean;
  onToggle: (key: string) => void;
  empty?: string;
  imports?: ReadonlyMap<string, SkillMarketImport>;
  onOpenListing?: (listing: SkillMarketListingRef) => void;
  onUpload?: (skill: SkillSummary) => void;
}) {
  const listId = useId();
  const { title, skills } = group;
  const collapsible = skills.length > 0;
  const heading = (
    <>
      <Typography level="title-sm" component="span">
        {title}
      </Typography>
      <Chip size="sm" variant="soft" color="neutral" component="span">
        {skills.length}
      </Chip>
    </>
  );
  return (
    <Box component="section" data-testid="skill-group">
      {collapsible ? (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => onToggle(group.key)}
          startDecorator={<ChevronIcon open={open} />}
          sx={{ gap: 0.25, px: 0.75, ml: -0.75, mb: 0.75, minHeight: 0, fontWeight: 'inherit' }}
          data-testid="skills-group-toggle-btn"
        >
          <Stack direction="row" spacing={1} alignItems="center" component="span">
            {heading}
          </Stack>
        </Button>
      ) : (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.75 }}>
          {heading}
        </Stack>
      )}
      {skills.length === 0 ? (
        <Sheet variant="soft" sx={{ borderRadius: 'md', px: 1.5, py: 1.25 }}>
          <Typography level="body-sm" textColor="text.tertiary">
            {empty}
          </Typography>
        </Sheet>
      ) : (
        // Unmounted rather than hidden: a collapsed group costs nothing however many skills it holds.
        open && (
          <List id={listId} size="sm" sx={skillListSx} data-testid="skills-group-list">
            {skills.map(skill => (
              <SkillRow
                key={`${skill.source}:${skill.name}`}
                skill={skill}
                imports={imports}
                onOpenListing={onOpenListing}
                onUpload={onUpload}
              />
            ))}
          </List>
        )
      )}
    </Box>
  );
});

function skillScope(filePath: string): string | null {
  const parts = filePath.split(/[\\/]+/);
  const claudeIndex = parts.lastIndexOf('.claude');
  if (claudeIndex < 0 || parts[claudeIndex + 1] !== 'skills') return null;
  return parts[claudeIndex + 2] ?? null;
}

const ACCOUNT_GROUP_KEY = 'account';

function userSkillGroups(skills: SkillSummary[]): SkillGroupModel[] {
  const scopes = new Map<string, SkillSummary[]>();
  for (const skill of skills) {
    if (skill.source !== 'global') continue;
    const scope = skillScope(skill.filePath);
    if (!scope) continue;
    const scoped = scopes.get(scope);
    if (scoped) scoped.push(skill);
    else scopes.set(scope, [skill]);
  }
  return [...scopes].map(([scope, scoped]) => ({ key: `user:${scope}`, title: scope, skills: scoped }));
}

function SkillsSettings({
  sessionId,
  onOpenSkillMarket,
}: {
  sessionId: string | null;
  onOpenSkillMarket?: (listing?: SkillMarketListingRef) => void;
}) {
  const { skills, refresh } = useSkills(sessionId);
  const upload = useSkillUpload(() => void refresh(), sessionId);
  const startUpload = upload.start;
  const uploadRow = useCallback(
    (skill: SkillSummary) =>
      void startUpload(() => window.b4m.skillMarket.readLocalSkill({ sessionId, name: skill.name })),
    [startUpload, sessionId]
  );
  const [imports, setImports] = useState<ReadonlyMap<string, SkillMarketImport>>(new Map());
  const [query, setQuery] = useState('');
  // Collapses made while a filter is on; a new query starts from every match expanded again.
  const [collapsedWhileFiltering, setCollapsedWhileFiltering] = useState<ReadonlySet<string>>(new Set());
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    let live = true;
    void window.b4m.skillMarket.imports().then(result => {
      if (live) setImports(new Map(result.imports.map(row => [row.skillId, row])));
    });
    return () => {
      live = false;
    };
  }, []);

  const userGroups = useMemo(() => userSkillGroups(skills), [skills]);
  const accountGroup = useMemo<SkillGroupModel>(
    () => ({
      key: ACCOUNT_GROUP_KEY,
      title: 'Bike4Mind skills',
      skills: skills.filter(skill => skill.source === 'account'),
    }),
    [skills]
  );

  const filtering = query.trim().length > 0;
  const groupCount = userGroups.length + (accountGroup.skills.length > 0 ? 1 : 0);
  const expandedByDefault = groupCount <= COLLAPSE_ABOVE_GROUPS;
  // A group of one is drawn as its row alone: a header to fold a single row away saves nothing.
  const singleSkillScopes = useMemo(
    () => new Set(userGroups.filter(group => group.skills.length === 1).map(group => group.key)),
    [userGroups]
  );
  const shownUserGroups = useMemo(() => filterSkillGroups(userGroups, query), [userGroups, query]);
  const shownAccountGroup = useMemo(() => filterSkillGroups([accountGroup], query)[0], [accountGroup, query]);
  const collapsibleKeys = [
    ...shownUserGroups.filter(group => !singleSkillScopes.has(group.key)).map(group => group.key),
    ...(shownAccountGroup && shownAccountGroup.skills.length > 0 ? [ACCOUNT_GROUP_KEY] : []),
  ];

  const isOpen = (key: string) =>
    filtering ? !collapsedWhileFiltering.has(key) : rememberedExpansion(key, expandedByDefault);
  const anyOpen = collapsibleKeys.some(isOpen);

  const toggle = useCallback(
    (key: string) => {
      if (filtering) {
        setCollapsedWhileFiltering(collapsed => {
          const next = new Set(collapsed);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      } else {
        rememberGroupExpansion(key, !rememberedExpansion(key, expandedByDefault));
        rerender();
      }
    },
    [filtering, expandedByDefault]
  );
  const toggleAll = () => {
    if (filtering) {
      setCollapsedWhileFiltering(anyOpen ? new Set(collapsibleKeys) : new Set());
    } else {
      rememberAllExpansion(!anyOpen);
      rerender();
    }
  };

  const userSkillCount = shownUserGroups.reduce((total, group) => total + group.skills.length, 0);

  return (
    <Stack spacing={2.5} data-testid="skills-settings">
      {/* Collapse all sits beside the filter because it covers the Bike4Mind group above Your skills too. */}
      <Stack direction="row" spacing={1} alignItems="center">
        <Input
          size="sm"
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setCollapsedWhileFiltering(new Set());
          }}
          placeholder="Filter skills"
          startDecorator={<SearchIcon />}
          slotProps={{ input: { 'data-testid': 'skills-filter-input', 'aria-label': 'Filter skills' } }}
          sx={{ flex: 1 }}
        />
        {collapsibleKeys.length > 0 && (
          <Button size="sm" variant="plain" color="neutral" onClick={toggleAll} data-testid="skills-collapse-all-btn">
            {anyOpen ? 'Collapse all' : 'Expand all'}
          </Button>
        )}
      </Stack>
      {shownAccountGroup && (
        <SkillGroup
          group={shownAccountGroup}
          open={isOpen(ACCOUNT_GROUP_KEY)}
          onToggle={toggle}
          empty="No Bike4Mind account skills loaded."
          imports={imports}
          onOpenListing={onOpenSkillMarket}
        />
      )}
      <Box component="section" data-testid="user-skill-scopes">
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Typography level="title-md">Your skills</Typography>
          <Chip size="sm" variant="soft" color="neutral">
            {userSkillCount}
          </Chip>
        </Stack>
        {userGroups.length === 0 ? (
          <Sheet variant="soft" sx={{ borderRadius: 'md', px: 1.5, py: 1.25 }}>
            <Typography level="body-sm" textColor="text.tertiary">
              No skills found in ~/.claude/skills.
            </Typography>
          </Sheet>
        ) : shownUserGroups.length === 0 ? (
          <Sheet variant="soft" sx={{ borderRadius: 'md', px: 1.5, py: 1.25 }}>
            <Typography level="body-sm" textColor="text.tertiary" data-testid="skills-filter-empty">
              No skills match.
            </Typography>
          </Sheet>
        ) : (
          <Stack spacing={2}>
            {shownUserGroups.map(group =>
              singleSkillScopes.has(group.key) ? (
                <List key={group.key} size="sm" sx={skillListSx} data-testid="skills-single-row">
                  <SkillRow skill={group.skills[0]} onUpload={uploadRow} />
                </List>
              ) : (
                <SkillGroup
                  key={group.key}
                  group={group}
                  open={isOpen(group.key)}
                  onToggle={toggle}
                  onUpload={uploadRow}
                />
              )
            )}
          </Stack>
        )}
      </Box>
      {upload.error && (
        <Alert color="danger" data-testid="skill-upload-pick-error">
          {upload.error}
        </Alert>
      )}
      <Stack direction="row" spacing={1}>
        {onOpenSkillMarket && (
          <Button variant="outlined" onClick={() => onOpenSkillMarket()} data-testid="customize-skill-market-btn">
            Browse Skill Market
          </Button>
        )}
        <Button
          variant="outlined"
          color="neutral"
          onClick={() => void upload.start(() => window.b4m.skillMarket.pickUploadSource())}
          data-testid="skill-upload-pick-btn"
        >
          Upload a skill...
        </Button>
      </Stack>
      {upload.dialog}
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
export function CustomizeScreen({
  onClose,
  sessionId = null,
  onOpenSkillMarket,
}: {
  onClose: () => void;
  sessionId?: string | null;
  onOpenSkillMarket?: (listing?: SkillMarketListingRef) => void;
}) {
  const entries = useCustomizeEntries();

  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="customize-panel">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <Stack sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-sm" component="h1">
              Customize
            </Typography>
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
        <Box sx={{ py: 1 }} data-testid="customize-tab-row">
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
            <Tab data-testid="customize-plugins-tab">Plugins</Tab>
          </TabList>
        </Box>
        <TabPanel value={0} sx={{ p: 0, flex: 1, ...scrollingColumnHostSx }}>
          <Box sx={{ ...contentColumnSx, py: 2 }}>
            <SkillsSettings sessionId={sessionId} onOpenSkillMarket={onOpenSkillMarket} />
          </Box>
        </TabPanel>
        <TabPanel value={1} sx={{ p: 0, flex: 1, ...scrollingColumnHostSx }}>
          <Box sx={{ ...contentColumnSx, py: 2 }}>
            {entries.map(entry => (
              <EntrySection key={entry.id} entry={entry} />
            ))}
          </Box>
        </TabPanel>
        <TabPanel value={2} sx={{ p: 0, flex: 1, ...scrollingColumnHostSx }}>
          <Box
            data-testid="customize-plugins-grid"
            sx={{
              ...contentColumnSx,
              py: 2,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
              gap: 2,
            }}
          >
            {['DataLake', 'QuestMaster', 'Tavern', 'Studio'].map(name => (
              <Sheet
                key={name}
                component="article"
                aria-label={name}
                data-testid="customize-plugin-card"
                variant="outlined"
                sx={{
                  p: 2,
                  borderRadius: 'md',
                  borderStyle: 'dashed',
                  bgcolor: 'background.level1',
                  color: 'text.secondary',
                  cursor: 'not-allowed',
                }}
              >
                <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                  <Typography
                    level="h3"
                    component="h2"
                    sx={{ fontSize: 'var(--joy-fontSize-md)', color: 'text.secondary' }}
                  >
                    {name}
                  </Typography>
                  <IconButton
                    disabled
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    aria-label={`Add ${name}`}
                    data-testid="customize-plugin-add-btn"
                  >
                    +
                  </IconButton>
                </Stack>
                <Typography level="body-sm" textColor="text.secondary" data-testid="customize-plugin-status">
                  <Box component="span" aria-hidden="true" sx={{ mr: 0.75 }}>
                    {'\uD83D\uDEA7'}
                  </Box>
                  Under construction
                </Typography>
              </Sheet>
            ))}
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}
