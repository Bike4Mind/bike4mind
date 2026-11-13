import { OrchestrationSettings } from './OrchestrationSettings';
import { useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import ListItemContent from '@mui/joy/ListItemContent';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import ToggleButtonGroup from '@mui/joy/ToggleButtonGroup';
import Typography from '@mui/joy/Typography';
import { useColorScheme, useTheme } from '@mui/joy/styles';
import type { AuthState } from '@shared/auth';
import type { PermissionsState } from '@shared/permissions';
import { updateAttention, updateSummary } from '@shared/update';
import { EnvironmentPicker } from '../auth/EnvironmentPicker';
import type { ClaudeImportKind, ClaudeImportState } from '@shared/claudeImport';
import { ClaudeImportSettings, claudeImportSummary, useClaudeImport } from './ClaudeImportSettings';
import type { LocalContextFit, LocalContextSetting } from '@shared/localContextSetting';
import { LocalContextSettings, localContextSummary, useLocalContextSetting } from './LocalContextSettings';
import { LocalHistorySettings } from './LocalHistorySettings';
import type { LoopRunnerState } from '@shared/loopRunner';
import { LoopRunnerSettings, loopRunnerSummary, useLoopRunnerState } from './LoopRunnerSettings';
import type { ModelServerView } from '@shared/modelServers';
import { ModelServersSettings, modelServersSummary, useModelServers } from './ModelServersSettings';
import { WorktreesSettings } from './WorktreesSettings';
import { AutoFixAttemptsSettings, autoFixAttemptsSummary, useAutoFixAttempts } from './AutoFixAttemptsSettings';
import type { CuratedListSettings as CuratedListSettingsState } from '@shared/models';
import { CuratedListSettings, curatedListSummary, useCuratedListSettings } from './CuratedListSettings';
import { SettingsRow, entryAttentionChip, type ConfigEntry } from './ConfigEntry';
import {
  ArrowLeftIcon,
  BranchIcon,
  ContrastIcon,
  DownloadIcon,
  FolderIcon,
  ModelsIcon,
  PullRequestIcon,
  ServerIcon,
  ShieldIcon,
  SlidersIcon,
  SoundIcon,
  SparkIcon,
  SubSessionsIcon,
} from './icons';
import { nestedSessionsSummary, useNestedSessions } from './nestedSessions';
import { useMenuBarSetting } from './menuBarSetting';
import { useOrchestratorSound } from './orchestrator/chime';
import { columnStackSx, contentColumnSx, thinScrollbarSx } from './layout';
import { useCostDisplayPreference } from './costDisplay';
import { tokenRateSummary, useTokenRateSetting } from './tokenRate';
import { PermissionsSettings, permissionsSummary, usePermissions } from './PermissionsSettings';
import { promptSuggestionsSummary, usePromptSuggestionModel, usePromptSuggestions } from './promptSuggestions';
import { SuggestionModelPicker } from './SuggestionModelPicker';
import { THEME_MODES, currentThemeMode, themeModeSummary, type ResolvedThemeMode, type ThemeMode } from './themeMode';
import { UpdateSettings } from './UpdateSettings';
import { useAppUpdate, type AppUpdateController } from './useAppUpdate';
import { useWorktreeByDefault, worktreeDefaultSummary } from './worktreeDefault';

/** What the General page is for, said on the page so it does not have to be inferred from a name. */
const SETTINGS_INTRO = 'How the app looks, behaves, connects, and keeps itself up to date.';

const THEME_MODE_LABEL: Record<ThemeMode, string> = { system: 'System', light: 'Light', dark: 'Dark' };

function appearanceEntry(
  mode: string | undefined,
  setMode: (mode: ThemeMode) => void,
  resolved: ResolvedThemeMode
): ConfigEntry {
  return {
    id: 'appearance',
    icon: <ContrastIcon />,
    label: 'Appearance',
    summary: themeModeSummary(mode, resolved),
    description:
      currentThemeMode(mode) === 'system'
        ? `Choose a light or dark appearance, or follow your system settings (currently ${resolved}).`
        : 'Choose a light or dark appearance, or follow your system settings.',
    control: (
      <ToggleButtonGroup
        size="sm"
        value={currentThemeMode(mode)}
        onChange={(_event, next) => {
          if (next) setMode(next as ThemeMode);
        }}
        data-testid="settings-appearance-group"
        sx={{
          bgcolor: 'background.level1',
          borderRadius: 'md',
          p: 0.5,
          gap: 0.5,
          '& .MuiButton-root': { border: 0, borderRadius: 'sm' },
        }}
      >
        {THEME_MODES.map(themeMode => (
          <Button key={themeMode} value={themeMode} data-testid={`settings-appearance-${themeMode}-btn`}>
            {THEME_MODE_LABEL[themeMode]}
          </Button>
        ))}
      </ToggleButtonGroup>
    ),
  };
}

function suggestionsEntry(enabled: boolean, toggle: () => void, model: string | null): ConfigEntry {
  return {
    id: 'prompt-suggestions',
    icon: <SparkIcon />,
    label: 'Suggested next prompt',
    summary: promptSuggestionsSummary(enabled, model),
    description: 'Suggest a next prompt after a reply. Uses a little extra model usage.',
    control: (
      <Stack spacing={1.25} sx={{ alignItems: { xs: 'flex-start', md: 'flex-end' } }}>
        <Switch
          size="sm"
          checked={enabled}
          onChange={toggle}
          sx={{ alignSelf: { xs: 'flex-start', md: 'flex-end' } }}
          slotProps={{
            input: { 'aria-label': 'Suggested next prompt', 'data-testid': 'settings-suggestions-switch' },
          }}
        />
        {enabled && (
          <Box component="details" sx={{ width: '100%' }}>
            <Typography
              component="summary"
              level="body-sm"
              sx={{ display: 'list-item', cursor: 'pointer', color: 'text.secondary' }}
            >
              Suggestion model: {model ?? 'Automatic'}
            </Typography>
            <Box sx={{ mt: 1.5 }}>
              <SuggestionModelPicker />
            </Box>
          </Box>
        )}
      </Stack>
    ),
  };
}

function worktreeEntry(enabled: boolean, toggle: () => void): ConfigEntry {
  return {
    id: 'worktree-default',
    icon: <BranchIcon />,
    label: 'Worktree by default',
    summary: worktreeDefaultSummary(enabled),
    description:
      'Start Code sessions in a separate git worktree by default. You can change this before the first message.',
    control: (
      <Switch
        size="sm"
        checked={enabled}
        onChange={toggle}
        slotProps={{
          input: { 'aria-label': 'Worktree by default', 'data-testid': 'settings-worktree-default-switch' },
        }}
      />
    ),
  };
}

function autoFixAttemptsEntry(
  attempts: number | null,
  onChange: (attempts: number) => void,
  error: string | null
): ConfigEntry {
  return {
    id: 'autofix-attempts',
    icon: <PullRequestIcon />,
    label: 'Auto-fix attempts',
    summary: autoFixAttemptsSummary(attempts),
    description:
      'How many times auto-fix tries a pull request before it stops. Takes effect when you next turn auto-fix on. Raising it also applies where auto-fix is already on.',
    control: <AutoFixAttemptsSettings attempts={attempts} onChange={onChange} error={error} />,
  };
}

function nestedSessionsEntry(enabled: boolean, toggle: () => void): ConfigEntry {
  return {
    id: 'nested-sessions',
    icon: <SubSessionsIcon />,
    label: 'Nest sub-sessions',
    summary: nestedSessionsSummary(enabled),
    description:
      'Group agent-created sessions under the conversation that started them. Turn off to list each session separately.',
    control: (
      <Switch
        size="sm"
        checked={enabled}
        onChange={toggle}
        slotProps={{
          input: { 'aria-label': 'Nest sub-sessions', 'data-testid': 'settings-nested-sessions-switch' },
        }}
      />
    ),
  };
}

function orchestratorSoundEntry(enabled: boolean, toggle: () => void): ConfigEntry {
  return {
    id: 'orchestrator-sound',
    icon: <SoundIcon />,
    label: 'Orchestrator sounds',
    summary: enabled ? 'A chime when an agent needs you or a run finishes.' : 'Off.',
    description: 'Play a chime when an agent needs your attention or a run finishes.',
    control: (
      <Switch
        size="sm"
        checked={enabled}
        onChange={toggle}
        slotProps={{
          input: { 'aria-label': 'Orchestrator sounds', 'data-testid': 'settings-orchestrator-sound-switch' },
        }}
      />
    ),
  };
}

function menuBarEntry(shown: boolean, toggle: () => void): ConfigEntry {
  return {
    id: 'menu-bar',
    icon: null,
    label: 'Show in menu bar',
    summary: shown ? 'Agent status and quick approvals in the menu bar.' : 'Off.',
    description:
      'Show how your orchestrations are doing in the menu bar, with quick approvals and the mini Tavern. It appears once you start an orchestration.',
    control: (
      <Switch
        size="sm"
        checked={shown}
        onChange={toggle}
        slotProps={{ input: { 'aria-label': 'Show in menu bar', 'data-testid': 'settings-menu-bar-switch' } }}
      />
    ),
  };
}

function dollarCostsEntry(enabled: boolean, setEnabled: (enabled: boolean) => void): ConfigEntry {
  return {
    id: 'dollar-costs',
    icon: <ContrastIcon />,
    label: 'Show dollar costs',
    summary: 'Development only. Show dollars while streaming and in usage details.',
    control: (
      <Switch
        size="sm"
        checked={enabled}
        onChange={event => setEnabled(event.target.checked)}
        slotProps={{ input: { 'aria-label': 'Show dollar costs', 'data-testid': 'settings-dollar-costs-switch' } }}
      />
    ),
  };
}

function tokenRateEntry(enabled: boolean, toggle: () => void): ConfigEntry {
  return {
    id: 'token-rate',
    icon: <ModelsIcon />,
    label: 'Self-hosted model speed',
    summary: tokenRateSummary(enabled),
    description:
      'Show tokens per second for self-hosted models. Hover the rate for prompt speed, load time, and draft acceptance when available. A rate starting with ~ is timed by this app.',
    control: (
      <Switch
        size="sm"
        checked={enabled}
        onChange={toggle}
        slotProps={{
          input: { 'aria-label': 'Self-hosted model speed', 'data-testid': 'settings-token-rate-switch' },
        }}
      />
    ),
  };
}

function localContextEntry(
  setting: LocalContextSetting | null,
  onChange: (setting: LocalContextSetting) => void,
  error: string | null,
  fit: LocalContextFit | undefined
): ConfigEntry {
  return {
    id: 'local-context',
    icon: <SlidersIcon />,
    label: 'Local model context',
    summary: localContextSummary(setting),
    control: <LocalContextSettings setting={setting} onChange={onChange} error={error} fit={fit} />,
  };
}

function curatedListEntry(
  settings: CuratedListSettingsState | null,
  onEnabled: (enabled: boolean) => void,
  error: string | null,
  onRetry: () => void,
  saving: boolean
): ConfigEntry {
  return {
    id: 'curated-list',
    icon: <DownloadIcon />,
    label: 'Curated models list',
    summary: !settings && error ? error : curatedListSummary(settings),
    description:
      !settings && error
        ? error
        : settings?.available
          ? 'Check for an updated list when you open Models, at most every 6 hours. Models are never downloaded automatically.'
          : curatedListSummary(settings),
    control: (
      <CuratedListSettings settings={settings} onEnabled={onEnabled} error={error} onRetry={onRetry} saving={saving} />
    ),
  };
}

function localHistoryEntry(): ConfigEntry {
  return {
    id: 'local-history',
    icon: <FolderIcon />,
    label: 'Local history',
    summary: 'Opted-in conversations and pages stay on this device and remain searchable offline.',
    control: <LocalHistorySettings />,
  };
}

function loopRunnerEntry(state: LoopRunnerState | null, setState: (state: LoopRunnerState) => void): ConfigEntry {
  return {
    id: 'loop-runner',
    icon: <ServerIcon />,
    label: 'Loop runner',
    summary: loopRunnerSummary(state),
    control: <LoopRunnerSettings state={state} onState={setState} />,
  };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes a rejected invoke with where it came from; the user needs the reason only.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function LocalDataExport() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const run = async () => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      const result = await window.b4m.chat.exportLocalData();
      if (result.saved) {
        setFailed(false);
        setMessage(
          result.warnings?.length
            ? `Export saved to ${result.path}. Skipped: ${result.warnings.join(' ')}`
            : `Export saved to ${result.path}`
        );
      }
    } catch (error) {
      setFailed(true);
      setMessage(`Could not export local data: ${errorText(error)}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <Stack spacing={1}>
      <Button
        size="sm"
        variant="outlined"
        loading={pending}
        onClick={() => void run()}
        data-testid="settings-export-local-btn"
      >
        Export local data...
      </Button>
      {message && (
        <Typography
          level="body-xs"
          color={failed ? 'danger' : 'success'}
          role="status"
          data-testid="settings-export-local-status"
        >
          {message}
        </Typography>
      )}
    </Stack>
  );
}

function localDataExportEntry(): ConfigEntry {
  return {
    id: 'local-data-export',
    icon: <DownloadIcon />,
    label: 'Export local data',
    summary: 'Save your local conversations and project memories in a portable bundle.',
    description:
      'Save conversations, attachments, generated media, and project memories to a folder. Credentials and server settings are not included.',
    control: <LocalDataExport />,
  };
}

function worktreesEntry(): ConfigEntry {
  return {
    id: 'worktrees',
    icon: <BranchIcon />,
    label: 'Worktrees',
    summary: 'Worktrees the app made for your projects, and the ones no conversation uses any more.',
    control: <WorktreesSettings />,
  };
}

function permissionsEntry(
  state: PermissionsState | null,
  setState: (state: PermissionsState) => void,
  loadError: string | null,
  onRetry: () => void
): ConfigEntry {
  return {
    id: 'permissions',
    icon: <ShieldIcon />,
    label: 'Permissions',
    summary: permissionsSummary(state),
    control: <PermissionsSettings state={state} onState={setState} loadError={loadError} onRetry={onRetry} />,
  };
}

function claudeImportEntry(
  state: ClaudeImportState | null,
  setState: (state: ClaudeImportState) => void,
  loadError: string | null,
  onRetry: () => void,
  focus?: ClaudeImportKind
): ConfigEntry {
  return {
    id: 'claude-import',
    icon: <FolderIcon />,
    label: 'Import from Claude',
    summary: loadError ? 'Could not load import settings' : claudeImportSummary(state),
    control: (
      <ClaudeImportSettings state={state} onState={setState} loadError={loadError} onRetry={onRetry} focus={focus} />
    ),
  };
}

/**
 * Which backend hosted conversations talk to.
 *
 * It used to live in the account menu, which is where a user looks for who they are rather than
 * for what the app is wired to. The signed-out card keeps its own copy of this picker - someone
 * whose saved server is unreachable has to be able to change it before they can reach any screen.
 */
function serverEntry(state: AuthState): ConfigEntry {
  return {
    id: 'server',
    icon: <ServerIcon />,
    label: 'Server',
    summary: state.environment.url ? state.environment.label : 'No server is set yet',
    control: (
      <Stack spacing={1.5}>
        {/* The scope is said out loud because it is the one thing the picker's own caption
            cannot tell you: how far the choice reaches. It is a choice of backend, never of
            where the agent runs; this app's agent is the Electron main process and has
            nowhere else to go. */}
        <Typography level="body-xs" textColor="text.tertiary">
          Hosted conversations use this server. Local models run on this device.
        </Typography>
        <EnvironmentPicker state={state} />
      </Stack>
    ),
  };
}

/** The app's own version, and the only place an update is offered. */
function updatesEntry(controller: AppUpdateController): ConfigEntry {
  const attention = updateAttention(controller.state);
  return {
    id: 'updates',
    icon: <DownloadIcon />,
    label: 'Updates',
    summary: updateSummary(controller.state),
    ...(attention ? { attention, attentionColor: 'primary' as const } : {}),
    control: <UpdateSettings controller={controller} />,
  };
}

function modelServersEntry(
  servers: ModelServerView[] | null,
  setServers: (servers: ModelServerView[]) => void,
  loadError: string | null
): ConfigEntry {
  // One word: the side nav shows it beside the section label.
  const attention = servers?.some(server => server.health.state === 'credentials') ? 'Credentials' : undefined;
  return {
    id: 'model-servers',
    icon: <ServerIcon />,
    label: 'Model servers',
    summary: modelServersSummary(servers),
    ...(attention ? { attention } : {}),
    control: <ModelServersSettings servers={servers} onServers={setServers} loadError={loadError} />,
  };
}

/** The pages of Settings, in the order the side nav lists them. */
export const SETTINGS_SECTIONS = ['general', 'servers', 'permissions', 'import', 'worktrees'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection);
}

/** px, border included; the header indents its column by this much. */
const SETTINGS_NAV_WIDTH = 200;

const SECTION_LABEL: Record<SettingsSection, string> = {
  general: 'General',
  servers: 'Model servers',
  permissions: 'Permissions',
  import: 'Import',
  worktrees: 'Worktrees',
};

const SECTION_ICON: Record<SettingsSection, ReactNode> = {
  general: <SlidersIcon />,
  servers: <ServerIcon />,
  permissions: <ShieldIcon />,
  import: <FolderIcon />,
  worktrees: <BranchIcon />,
};

/**
 * Every Settings entry, grouped by the page that shows it.
 *
 * What the app talks to comes before how it maintains itself: the server is the setting a user
 * arrives here to change, and an update is the one that arrives on its own.
 *
 * Nothing stays mounted while the page is shut. What an unopened Settings still has to report
 * is one string, which the account strip reads for itself - see `useSettingsAttention`.
 */
function useSettingsEntries(
  auth: AuthState | null,
  importFocus?: ClaudeImportKind
): Record<SettingsSection, ConfigEntry[]> {
  const showDollarCosts = useCostDisplayPreference(state => state.showDollarCosts);
  const setShowDollarCosts = useCostDisplayPreference(state => state.setShowDollarCosts);
  const [showTokenRate, toggleTokenRate] = useTokenRateSetting();
  const update = useAppUpdate();
  const { mode, setMode } = useColorScheme();
  const theme = useTheme();
  const [suggestions, toggleSuggestions] = usePromptSuggestions();
  const [suggestionModel] = usePromptSuggestionModel();
  const [permissions, setPermissions, permissionsError, retryPermissions] = usePermissions();
  const [claudeImport, setClaudeImport, importError, retryImport] = useClaudeImport();
  const [worktreeDefault, toggleWorktreeDefault] = useWorktreeByDefault();
  const [nestedSessions, toggleNestedSessions] = useNestedSessions();
  const [orchestratorSound, toggleOrchestratorSound] = useOrchestratorSound();
  const [autoFixAttempts, setAutoFixAttempts, autoFixAttemptsError] = useAutoFixAttempts();
  const [menuBar, toggleMenuBar] = useMenuBarSetting();
  const [localContext, setLocalContext, localContextError, localContextFit] = useLocalContextSetting();
  const [modelServers, setModelServers, modelServersError] = useModelServers();
  const curatedList = useCuratedListSettings();
  const [loopRunner, setLoopRunner] = useLoopRunnerState();

  return {
    general: [
      appearanceEntry(mode, setMode, theme.palette.mode),
      suggestionsEntry(suggestions, toggleSuggestions, suggestionModel),
      worktreeEntry(worktreeDefault, toggleWorktreeDefault),
      autoFixAttemptsEntry(autoFixAttempts, next => void setAutoFixAttempts(next), autoFixAttemptsError),
      nestedSessionsEntry(nestedSessions, toggleNestedSessions),
      orchestratorSoundEntry(orchestratorSound, toggleOrchestratorSound),
      menuBarEntry(menuBar, toggleMenuBar),
      {
        id: 'orchestration-policy',
        icon: null,
        label: 'Orchestration worker models',
        summary: 'Explicit worker defaults and targeted model upgrades',
        control: (
          <Box component="details">
            <Typography
              component="summary"
              level="body-sm"
              sx={{ display: 'list-item', cursor: 'pointer', color: 'text.secondary' }}
              data-testid="settings-worker-models-details"
            >
              Configure worker models
            </Typography>
            <Box sx={{ mt: 2 }}>
              <OrchestrationSettings key={`${auth?.environment?.url ?? 'device'}:${auth?.user?.id ?? 'local'}`} />
            </Box>
          </Box>
        ),
      },
      localContextEntry(localContext, next => void setLocalContext(next), localContextError, localContextFit),
      tokenRateEntry(showTokenRate, toggleTokenRate),
      curatedListEntry(
        curatedList.settings,
        enabled => void curatedList.setEnabled(enabled),
        curatedList.error,
        () => void curatedList.reload(),
        curatedList.saving
      ),
      localHistoryEntry(),
      ...(loopRunner ? [loopRunnerEntry(loopRunner, setLoopRunner)] : []),
      localDataExportEntry(),
      ...(import.meta.env.DEV ? [dollarCostsEntry(showDollarCosts, setShowDollarCosts)] : []),
      ...(auth ? [serverEntry(auth)] : []),
      updatesEntry(update),
    ],
    servers: [modelServersEntry(modelServers, setModelServers, modelServersError)],
    permissions: [permissionsEntry(permissions, setPermissions, permissionsError, retryPermissions)],
    import: [claudeImportEntry(claudeImport, setClaudeImport, importError, retryImport, importFocus)],
    worktrees: [worktreesEntry()],
  };
}

/** A page that is one setting needs no box around it: the page heading is its label. */
function SingleEntryPage({ entry }: { entry: ConfigEntry }) {
  return (
    <Stack spacing={2} data-testid="config-section" data-entry={entry.id}>
      <Stack>
        <Typography level="title-lg">{entry.label}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" data-testid="config-entry-summary">
          {entry.summary}
        </Typography>
      </Stack>
      {entry.control}
    </Stack>
  );
}

const GENERAL_GROUPS = [
  {
    id: 'appearance',
    label: 'Appearance & feedback',
    entries: ['appearance', 'orchestrator-sound', 'menu-bar', 'nested-sessions'],
  },
  {
    id: 'conversations',
    label: 'Conversations & code',
    entries: ['prompt-suggestions', 'worktree-default', 'autofix-attempts', 'orchestration-policy'],
  },
  { id: 'models', label: 'Models', entries: ['local-context', 'token-rate', 'curated-list'] },
  { id: 'data', label: 'Data & privacy', entries: ['local-history', 'local-data-export'] },
  { id: 'connection', label: 'Connection & updates', entries: ['server', 'updates', 'dollar-costs'] },
];

const EXPANDED_SETTINGS = new Set(['orchestration-policy', 'local-context', 'server', 'updates']);

/** Entries missing from GENERAL_GROUPS land in a trailing "Other" group instead of vanishing. */
function groupEntries(entries: ConfigEntry[]) {
  const grouped = new Set(GENERAL_GROUPS.flatMap(group => group.entries));
  const groups = [
    ...GENERAL_GROUPS.map(group => ({
      group,
      rows: group.entries.flatMap(id => entries.filter(entry => entry.id === id)),
    })),
    { group: { id: 'other', label: 'Other' }, rows: entries.filter(entry => !grouped.has(entry.id)) },
  ];
  return groups.filter(({ rows }) => rows.length > 0);
}

function SectionPage({ section, entries }: { section: SettingsSection; entries: ConfigEntry[] }) {
  if (entries.length === 1) return <SingleEntryPage entry={entries[0]} />;
  return (
    <Stack spacing={4}>
      <Stack spacing={1}>
        <Typography component="h2" level="h3" sx={{ fontSize: 26 }}>
          {SECTION_LABEL[section]}
        </Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {SETTINGS_INTRO}
        </Typography>
      </Stack>
      {groupEntries(entries).map(({ group, rows }) => (
        <Box
          component="section"
          key={group.id}
          aria-labelledby={`settings-group-${group.id}`}
          data-testid={`settings-group-${group.id}`}
        >
          <Typography id={`settings-group-${group.id}`} component="h3" level="title-md" sx={{ mb: 0.5 }}>
            {group.label}
          </Typography>
          {rows.map(entry => (
            <SettingsRow key={entry.id} entry={entry} expanded={EXPANDED_SETTINGS.has(entry.id)} />
          ))}
        </Box>
      ))}
    </Stack>
  );
}

/**
 * "Settings": app preferences, permissions, connections and maintenance, as a page of its own
 * beside Profile rather than a screen in the conversation pane.
 *
 * Customize owns tool connections. Settings owns app-wide preferences, what the agent may do,
 * the deployment a reply comes from, imports, and updates. The side nav splits those into pages
 * so no one page carries all of them.
 */
export function SettingsScreen({
  auth,
  section = 'general',
  importFocus,
  onSection,
  onClose,
}: {
  auth: AuthState | null;
  section?: SettingsSection;
  /** Import page only: the source to scroll to, as the sidebar's sync hints ask. */
  importFocus?: ClaudeImportKind;
  onSection?: (section: SettingsSection) => void;
  onClose: () => void;
}) {
  const entries = useSettingsEntries(auth, section === 'import' ? importFocus : undefined);

  return (
    <Stack sx={{ height: '100vh', bgcolor: 'background.body' }} data-testid="settings-panel">
      {/* ProfileScreen's header, with its column set over the page beside the nav rather than the
          whole window, so the back button and title line up with the page below them. */}
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider', pl: `${SETTINGS_NAV_WIDTH}px`, ...columnStackSx }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Back to conversations"
            onClick={onClose}
            data-testid="settings-close-btn"
          >
            <ArrowLeftIcon />
          </IconButton>
          <Typography level="title-sm" sx={{ flex: 1 }}>
            Settings
          </Typography>
        </Stack>
      </Box>

      <Stack direction="row" sx={{ flex: 1, minHeight: 0 }}>
        <List
          size="sm"
          aria-label="Settings sections"
          sx={{
            flex: 'none',
            boxSizing: 'border-box',
            width: SETTINGS_NAV_WIDTH,
            p: 1,
            gap: 0.25,
            borderRight: '1px solid',
            borderColor: 'divider',
            '--ListItem-radius': 'var(--joy-radius-sm)',
          }}
          data-testid="settings-nav"
        >
          {SETTINGS_SECTIONS.map(id => (
            <ListItem key={id}>
              <ListItemButton
                selected={id === section}
                onClick={() => onSection?.(id)}
                data-testid={`settings-nav-${id}-btn`}
              >
                <ListItemDecorator>{SECTION_ICON[id]}</ListItemDecorator>
                <ListItemContent>{SECTION_LABEL[id]}</ListItemContent>
                {entryAttentionChip(entries[id], `settings-nav-${id}-attention`)}
              </ListItemButton>
            </ListItem>
          ))}
        </List>

        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', scrollbarGutter: 'stable', ...thinScrollbarSx }}>
          <Box
            sx={{ ...contentColumnSx, maxWidth: 1040, boxSizing: 'border-box', px: { xs: 3, md: 5 }, py: 4 }}
            data-testid={`settings-page-${section}`}
          >
            <SectionPage section={section} entries={entries[section]} />
          </Box>
        </Box>
      </Stack>
    </Stack>
  );
}
