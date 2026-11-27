import { OrchestrationSettings } from './OrchestrationSettings';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import Divider from '@mui/joy/Divider';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import ListItemContent from '@mui/joy/ListItemContent';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
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
import type { ModelServerView } from '@shared/modelServers';
import { ModelServersSettings, modelServersSummary, useModelServers } from './ModelServersSettings';
import { WorktreesSettings } from './WorktreesSettings';
import { AutoFixAttemptsSettings, autoFixAttemptsSummary, useAutoFixAttempts } from './AutoFixAttemptsSettings';
import { TurnExtensionsSettings, turnExtensionsSummary, useTurnExtensions } from './TurnExtensionsSettings';
import type { CuratedListSettings as CuratedListSettingsState } from '@shared/models';
import { CuratedListSettings, curatedListSummary, useCuratedListSettings } from './CuratedListSettings';
import { SettingsRow, entryAttentionChip, settingHighlightSx, type ConfigEntry } from './ConfigEntry';
import {
  AgentsIcon,
  ArrowLeftIcon,
  BranchIcon,
  ContrastIcon,
  DownloadIcon,
  FolderIcon,
  GearIcon,
  ModelsIcon,
  PullRequestIcon,
  SearchIcon,
  ServerIcon,
  ShieldIcon,
  SlidersIcon,
  SoundIcon,
  SparkIcon,
  StatsIcon,
  SubSessionsIcon,
} from './icons';
import { nestedSessionsSummary, useNestedSessions } from './nestedSessions';
import { prAttentionSortSummary, usePrAttentionSort } from './prAttentionSort';
import { useMenuBarSetting } from './menuBarSetting';
import type { NotifyScope } from '@shared/attention';
import { notifyScopeSummary, useNotifyScope } from './notifyScopeSetting';
import { spawnLocationSummary, useSpawnLocation } from './spawnLocationSetting';
import { SPAWN_LOCATIONS, SPAWN_LOCATION_TEXT, type SpawnLocation } from '@shared/spawnLocation';
import { useOrchestratorSound } from './orchestrator/chime';
import { SoundMixControl } from './orchestrator/SoundMixControl';
import { columnStackSx, contentColumnSx, thinScrollbarSx } from './layout';
import { useCostDisplayPreference } from './costDisplay';
import { REPLY_STAT_TEXT, REPLY_STATS } from './replyStats';
import {
  replyStatsSummary,
  setReplyStatShown,
  setReplyStatsRail,
  useReplyStatsPrefs,
  type ReplyStatsPrefs,
} from './replyStatsPrefs';
import { PermissionsSettings, permissionsSummary, usePermissions } from './PermissionsSettings';
import { LAUNCH_PLACE_OPTIONS, useLaunchPlace, type LaunchPlace } from './rail/launchPlace';
import { promptSuggestionsSummary, usePromptSuggestionModel, usePromptSuggestions } from './promptSuggestions';
import { SuggestionModelPicker } from './SuggestionModelPicker';
import { THEME_MODES, currentThemeMode, themeModeSummary, type ResolvedThemeMode, type ThemeMode } from './themeMode';
import { UpdateSettings } from './UpdateSettings';
import { useAppUpdate, type AppUpdateController } from './useAppUpdate';
import { useWorktreeByDefault, worktreeDefaultSummary } from './worktreeDefault';
import {
  PAGE_ENTRIES,
  SECTION_INTRO,
  SECTION_LABEL,
  SETTINGS_SECTIONS,
  isSettingId,
  matchSettings,
  sectionOfSetting,
  type SettingId,
  type SettingsSection,
} from './settingsNavigation';

const settingsColumnSx = {
  ...contentColumnSx,
  maxWidth: 1040,
  boxSizing: 'border-box',
  px: { xs: 3, md: 5 },
} as const;

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

function launchPlaceEntry(value: LaunchPlace, setValue: (next: LaunchPlace) => void): ConfigEntry {
  const label = LAUNCH_PLACE_OPTIONS.find(option => option.value === value)?.label ?? 'Last used';
  return {
    id: 'launch-place',
    icon: null,
    label: 'Open on launch',
    summary: label,
    description: 'Applies next time the app opens.',
    control: (
      <Select
        size="sm"
        value={value}
        onChange={(_event, next) => {
          if (next) setValue(next);
        }}
        slotProps={{ button: { 'aria-label': 'Open on launch' } }}
        data-testid="settings-launch-place-select"
        sx={{ minWidth: 140 }}
      >
        {LAUNCH_PLACE_OPTIONS.map(option => (
          <Option key={option.value} value={option.value} data-testid={`settings-launch-place-${option.value}-option`}>
            {option.label}
          </Option>
        ))}
      </Select>
    ),
  };
}

function suggestionsEntry(enabled: boolean, toggle: () => void, model: string | null): ConfigEntry {
  return {
    id: 'prompt-suggestions',
    icon: <SparkIcon />,
    label: 'Suggest a next prompt',
    summary: promptSuggestionsSummary(enabled, model),
    description: 'Offer a next prompt after each reply, for a little extra model usage.',
    control: (
      <Stack spacing={1.25} sx={{ alignItems: { xs: 'flex-start', md: 'flex-end' } }}>
        <Switch
          size="sm"
          checked={enabled}
          onChange={toggle}
          sx={{ alignSelf: { xs: 'flex-start', md: 'flex-end' } }}
          slotProps={{
            input: { 'aria-label': 'Suggest a next prompt', 'data-testid': 'settings-suggestions-switch' },
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
    description: 'Start Code sessions in their own git worktree; you can still change it before the first message.',
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
      'How many times auto-fix tries a pull request before it stops, from the next time you turn it on (a raise also reaches pull requests where it is already on).',
    control: <AutoFixAttemptsSettings attempts={attempts} onChange={onChange} error={error} />,
  };
}

function turnExtensionsEntry(
  extensions: number | null,
  onChange: (extensions: number) => void,
  error: string | null
): ConfigEntry {
  return {
    id: 'turn-extensions',
    icon: <SlidersIcon />,
    label: 'Extra turns for long tasks',
    summary: turnExtensionsSummary(extensions),
    description:
      'An agent that hits its turn budget while still making progress carries on up to this many times per message, spending more credits each time, but one repeating the same step always stops.',
    control: <TurnExtensionsSettings extensions={extensions} onChange={onChange} error={error} />,
  };
}

function nestedSessionsEntry(enabled: boolean, toggle: () => void): ConfigEntry {
  return {
    id: 'nested-sessions',
    icon: <SubSessionsIcon />,
    label: 'Group sub-sessions under their parent',
    summary: nestedSessionsSummary(enabled),
    description: 'In the sidebar, sessions an agent started sit inside the session that started them.',
    control: (
      <Switch
        size="sm"
        checked={enabled}
        onChange={toggle}
        slotProps={{
          input: {
            'aria-label': 'Group sub-sessions under their parent',
            'data-testid': 'settings-nested-sessions-switch',
          },
        }}
      />
    ),
  };
}

function prAttentionSortEntry(enabled: boolean, setEnabled: (enabled: boolean) => void): ConfigEntry {
  return {
    id: 'pr-attention-sort',
    icon: <PullRequestIcon />,
    label: 'Sort the sidebar by pull request status',
    summary: prAttentionSortSummary(enabled),
    description: 'Sessions whose pull request needs you move to the top.',
    control: (
      <Switch
        size="sm"
        checked={enabled}
        onChange={event => setEnabled(event.target.checked)}
        slotProps={{
          input: {
            'aria-label': 'Sort the sidebar by pull request status',
            'data-testid': 'settings-pr-attention-sort-switch',
          },
        }}
      />
    ),
  };
}

function orchestratorSoundEntry(enabled: boolean, toggle: () => void): ConfigEntry {
  return {
    id: 'orchestrator-sound',
    icon: <SoundIcon />,
    label: 'Play sounds',
    summary: enabled ? 'Sounds are on.' : 'Muted.',
    description: 'A chime when an agent needs you, plus the events you pick below.',
    control: (
      <Switch
        size="sm"
        checked={enabled}
        onChange={toggle}
        slotProps={{
          input: { 'aria-label': 'Play sounds', 'data-testid': 'settings-orchestrator-sound-switch' },
        }}
      />
    ),
  };
}

function orchestratorSoundMixEntry(): ConfigEntry {
  return {
    id: 'orchestrator-sound-mix',
    icon: <SoundIcon />,
    label: 'Volume and events',
    summary: 'Volume and which moments make a sound.',
    description:
      'The needs-you chime always plays while sounds are on, and a sound pack from the view menu replaces the rest.',
    control: <SoundMixControl />,
  };
}

const NOTIFY_SCOPE_LABEL: Record<NotifyScope, string> = { agents: 'Agents only', all: 'All sessions' };

function notifyScopeEntry(scope: NotifyScope, setScope: (scope: NotifyScope) => void): ConfigEntry {
  return {
    id: 'notify-scope',
    icon: null,
    label: 'Notify me about',
    summary: notifyScopeSummary(scope),
    description:
      'Which sessions send a notification, count on the dock badge and play the chime when they need your approval or answer.',
    control: (
      <ToggleButtonGroup
        size="sm"
        value={scope}
        onChange={(_event, next) => {
          if (next) setScope(next as NotifyScope);
        }}
        aria-label="Notify me about"
        data-testid="settings-notify-scope-group"
        sx={{
          bgcolor: 'background.level1',
          borderRadius: 'md',
          p: 0.5,
          gap: 0.5,
          '& .MuiButton-root': { border: 0, borderRadius: 'sm' },
        }}
      >
        {(['agents', 'all'] as const).map(option => (
          <Button key={option} value={option} data-testid={`settings-notify-scope-${option}-btn`}>
            {NOTIFY_SCOPE_LABEL[option]}
          </Button>
        ))}
      </ToggleButtonGroup>
    ),
  };
}

function spawnLocationEntry(location: SpawnLocation, setLocation: (location: SpawnLocation) => void): ConfigEntry {
  return {
    id: 'spawn-location',
    icon: null,
    label: 'New agent sessions',
    summary: spawnLocationSummary(location),
    description:
      'Where a session started by another session opens; with Approve for me or Full access it starts at once, and in Ask mode a card confirms it.',
    control: (
      <ToggleButtonGroup
        size="sm"
        value={location}
        onChange={(_event, next) => {
          if (next) setLocation(next as SpawnLocation);
        }}
        aria-label="New agent sessions"
        data-testid="settings-spawn-location-group"
        sx={{
          bgcolor: 'background.level1',
          borderRadius: 'md',
          p: 0.5,
          gap: 0.5,
          '& .MuiButton-root': { border: 0, borderRadius: 'sm' },
        }}
      >
        {SPAWN_LOCATIONS.map(option => (
          <Button key={option} value={option} data-testid={`settings-spawn-location-${option}-btn`}>
            {SPAWN_LOCATION_TEXT[option].label}
          </Button>
        ))}
      </ToggleButtonGroup>
    ),
  };
}

function menuBarEntry(shown: boolean, toggle: () => void): ConfigEntry {
  return {
    id: 'menu-bar',
    icon: null,
    label: 'Show in menu bar',
    summary: shown ? 'Agent status and quick approvals in the menu bar.' : 'Off.',
    description: 'Running agents at a glance in the menu bar, with quick approvals.',
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
    description: 'Show dollar amounts while a reply streams and in usage details (development builds only).',
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

function replyStatsEntry(prefs: ReplyStatsPrefs): ConfigEntry {
  return {
    id: 'reply-stats',
    icon: <StatsIcon />,
    label: 'Reply stats',
    summary: replyStatsSummary(prefs),
    description: 'Show speed and token counts beside each reply.',
    control: (
      <Stack spacing={1.25} sx={{ alignItems: { xs: 'flex-start', md: 'flex-end' } }}>
        <Switch
          size="sm"
          checked={prefs.rail}
          onChange={event => setReplyStatsRail(event.target.checked)}
          endDecorator="Beside the conversation"
          sx={{ alignSelf: { xs: 'flex-start', md: 'flex-end' } }}
          slotProps={{
            input: {
              'aria-label': 'Show reply stats beside the conversation',
              'data-testid': 'settings-reply-stats-rail-switch',
            },
          }}
        />
        <Stack spacing={0.75} role="group" aria-label="Stats to show">
          {REPLY_STATS.map(id => (
            <Checkbox
              key={id}
              size="sm"
              label={REPLY_STAT_TEXT[id].setting}
              checked={!prefs.hidden.has(id)}
              onChange={event => setReplyStatShown(id, event.target.checked)}
              slotProps={{ input: { 'data-testid': `settings-reply-stat-${id}-checkbox` } }}
            />
          ))}
        </Stack>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ maxWidth: 300 }}>
          Beside the reply when the window is wide enough and you are in the chat view. Otherwise, in a narrow window or
          while orchestrating, the speed, total, model load and thinking time show under the reply on hover, and the
          rest in its tooltip. Each shows only where the model or server reports it; a figure starting with ~ is an
          estimate. Draft acceptance is reported by llama-server running a draft model.
        </Typography>
      </Stack>
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
    label: 'Memory for local models',
    summary: localContextSummary(setting),
    description: 'How much of the conversation a local model can see. More uses more memory.',
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
    label: 'Keep the model list up to date',
    summary: !settings && error ? error : curatedListSummary(settings),
    description:
      !settings && error
        ? error
        : settings?.available
          ? 'Check for an updated list when you open Models, at most every 6 hours, without ever downloading a model.'
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
    label: 'Keep history on this device',
    summary: 'Opted-in conversations and pages stay on this device and remain searchable offline.',
    description: 'Conversations you opt in stay on this device and are never uploaded.',
    control: <LocalHistorySettings />,
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
        color="neutral"
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
      'Save conversations, attachments, generated media and project memories to a folder, without credentials or server settings.',
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
    description: 'Allow, ask and deny rules for what agents may do.',
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
    description: 'Bring your Claude Code sessions and Claude chats into the app, and keep them in sync.',
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
    label: 'Bike4Mind server',
    summary: state.environment.url ? state.environment.label : 'No server is set yet',
    // How far the choice reaches is the one thing the picker cannot say about itself. It picks a
    // backend, never where the agent runs: this app's agent is the Electron main process.
    description: 'Hosted conversations use this server. Local models are not affected.',
    control: <EnvironmentPicker state={state} />,
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
    description: 'Check for, download and install new versions of the app.',
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
    description: 'This computer, plus Ollama or OpenAI-compatible servers on other machines.',
    ...(attention ? { attention } : {}),
    control: <ModelServersSettings servers={servers} onServers={setServers} loadError={loadError} />,
  };
}

/** px, border included; the header indents its column by this much. */
const SETTINGS_NAV_WIDTH = 256;

/** ms a deep-linked row stays highlighted. */
const HIGHLIGHT_MS = 3000;

/** Every page but About, which sits pinned at the foot of the nav. */
const LISTED_SECTIONS = SETTINGS_SECTIONS.filter(section => section !== 'about');

const SECTION_ICON: Record<SettingsSection, ReactNode> = {
  general: <GearIcon />,
  notifications: <SoundIcon />,
  agents: <AgentsIcon />,
  models: <ModelsIcon />,
  permissions: <ShieldIcon />,
  privacy: <FolderIcon />,
  advanced: <SlidersIcon />,
  about: <DownloadIcon />,
};

/** Settings whose control needs the full row width rather than a column beside the label. */
const EXPANDED_SETTINGS = new Set([
  'orchestrator-sound-mix',
  'orchestration-policy',
  'local-context',
  'model-servers',
  'permissions',
  'claude-import',
  'server',
  'worktrees',
  'updates',
]);

/**
 * Every Settings entry. PAGE_ENTRIES (settingsNavigation.ts) decides which page shows each.
 *
 * Nothing stays mounted while the page is shut. What an unopened Settings still has to report
 * is one string, which the account strip reads for itself - see `useSettingsAttention`.
 */
function useSettingsEntries(
  auth: AuthState | null,
  importFocus?: ClaudeImportKind
): { entries: ConfigEntry[]; appVersion: string } {
  const showDollarCosts = useCostDisplayPreference(state => state.showDollarCosts);
  const setShowDollarCosts = useCostDisplayPreference(state => state.setShowDollarCosts);
  const replyStatsPrefs = useReplyStatsPrefs();
  const update = useAppUpdate();
  const { mode, setMode } = useColorScheme();
  const theme = useTheme();
  const [launchPlace, setLaunchPlace] = useLaunchPlace();
  const [suggestions, toggleSuggestions] = usePromptSuggestions();
  const [suggestionModel] = usePromptSuggestionModel();
  const [permissions, setPermissions, permissionsError, retryPermissions] = usePermissions();
  const [claudeImport, setClaudeImport, importError, retryImport] = useClaudeImport();
  const [worktreeDefault, toggleWorktreeDefault] = useWorktreeByDefault();
  const [nestedSessions, toggleNestedSessions] = useNestedSessions();
  const sortByAttention = usePrAttentionSort(state => state.sortByAttention);
  const setSortByAttention = usePrAttentionSort(state => state.setSortByAttention);
  const [orchestratorSound, toggleOrchestratorSound] = useOrchestratorSound();
  const [autoFixAttempts, setAutoFixAttempts, autoFixAttemptsError] = useAutoFixAttempts();
  const [turnExtensions, setTurnExtensions, turnExtensionsError] = useTurnExtensions();
  const [menuBar, toggleMenuBar] = useMenuBarSetting();
  const [notifyScope, setNotifyScope] = useNotifyScope();
  const [spawnLocation, setSpawnLocation] = useSpawnLocation();
  const [localContext, setLocalContext, localContextError, localContextFit] = useLocalContextSetting();
  const [modelServers, setModelServers, modelServersError] = useModelServers();
  const curatedList = useCuratedListSettings();

  const entries: ConfigEntry[] = [
    launchPlaceEntry(launchPlace, setLaunchPlace),
    appearanceEntry(mode, setMode, theme.palette.mode),
    menuBarEntry(menuBar, toggleMenuBar),
    suggestionsEntry(suggestions, toggleSuggestions, suggestionModel),
    nestedSessionsEntry(nestedSessions, toggleNestedSessions),
    prAttentionSortEntry(sortByAttention, setSortByAttention),
    notifyScopeEntry(notifyScope, setNotifyScope),
    orchestratorSoundEntry(orchestratorSound, toggleOrchestratorSound),
    orchestratorSoundMixEntry(),
    spawnLocationEntry(spawnLocation, setSpawnLocation),
    worktreeEntry(worktreeDefault, toggleWorktreeDefault),
    autoFixAttemptsEntry(autoFixAttempts, next => void setAutoFixAttempts(next), autoFixAttemptsError),
    turnExtensionsEntry(turnExtensions, next => void setTurnExtensions(next), turnExtensionsError),
    {
      id: 'orchestration-policy',
      icon: null,
      label: 'Models for helper agents',
      summary: 'Explicit worker defaults and targeted model upgrades',
      description: 'Which models Orchestrate may pick for the agents it starts.',
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
    replyStatsEntry(replyStatsPrefs),
    localContextEntry(localContext, next => void setLocalContext(next), localContextError, localContextFit),
    curatedListEntry(
      curatedList.settings,
      enabled => void curatedList.setEnabled(enabled),
      curatedList.error,
      () => void curatedList.reload(),
      curatedList.saving
    ),
    modelServersEntry(modelServers, setModelServers, modelServersError),
    permissionsEntry(permissions, setPermissions, permissionsError, retryPermissions),
    localHistoryEntry(),
    localDataExportEntry(),
    claudeImportEntry(claudeImport, setClaudeImport, importError, retryImport, importFocus),
    ...(auth ? [serverEntry(auth)] : []),
    worktreesEntry(),
    ...(import.meta.env.DEV ? [dollarCostsEntry(showDollarCosts, setShowDollarCosts)] : []),
    updatesEntry(update),
  ];
  return { entries, appVersion: update.state.currentVersion };
}

/** The page an entry shows on. One PAGE_ENTRIES forgot lands on Advanced rather than nowhere. */
function pageOf(id: string): SettingsSection {
  return sectionOfSetting(id) ?? 'advanced';
}

/** A page's entries in PAGE_ENTRIES order, then (Advanced only) any that no page lists. */
function pageEntries(section: SettingsSection, entries: readonly ConfigEntry[]): ConfigEntry[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const ids: readonly string[] = PAGE_ENTRIES[section];
  const placed = ids.flatMap(id => byId.get(id) ?? []);
  if (section !== 'advanced') return placed;
  return [...placed, ...entries.filter(entry => !isSettingId(entry.id))];
}

function PageHeading({ title, intro }: { title: string; intro: string }) {
  return (
    <Stack spacing={1}>
      <Typography component="h2" level="h3" sx={{ fontSize: 26 }}>
        {title}
      </Typography>
      <Typography level="body-sm" textColor="text.tertiary" data-testid="settings-page-intro">
        {intro}
      </Typography>
    </Stack>
  );
}

/** A page that is one setting needs no row around it: the page heading is its label. */
function SingleEntryPage({ entry, highlighted }: { entry: ConfigEntry; highlighted: boolean }) {
  return (
    <Box
      data-testid="config-section"
      data-entry={entry.id}
      data-highlighted={highlighted ? 'true' : undefined}
      sx={{ ...settingHighlightSx(highlighted), py: 1 }}
    >
      {entry.control}
    </Box>
  );
}

function SectionPage({
  section,
  entries,
  highlighted,
}: {
  section: SettingsSection;
  entries: readonly ConfigEntry[];
  highlighted: string | undefined;
}) {
  const rows = pageEntries(section, entries);
  // Keyed on the page's design, not on what rendered: Advanced can be down to one row (Worktrees)
  // while auth loads, and that row still needs its label.
  const single = rows.length === 1 && PAGE_ENTRIES[section].length === 1 ? rows[0] : undefined;
  const intro = section === 'permissions' ? (rows[0]?.summary ?? '') : SECTION_INTRO[section];
  return (
    <Stack spacing={single ? 2 : 3}>
      <PageHeading title={SECTION_LABEL[section]} intro={intro} />
      {/* About's row summary is the version line, which the intro does not repeat. */}
      {single && single.summary !== intro && (
        <Typography level="body-sm" textColor="text.secondary" data-testid="config-entry-summary">
          {single.summary}
        </Typography>
      )}
      {single ? (
        <SingleEntryPage entry={single} highlighted={highlighted === single.id} />
      ) : (
        <Box>
          {rows.map(entry => (
            <SettingsRow
              key={entry.id}
              entry={entry}
              expanded={EXPANDED_SETTINGS.has(entry.id)}
              highlighted={highlighted === entry.id}
            />
          ))}
        </Box>
      )}
    </Stack>
  );
}

function SearchResults({
  query,
  entries,
  onOpen,
}: {
  query: string;
  entries: readonly ConfigEntry[];
  onOpen: (id: string) => void;
}) {
  const results = matchSettings(query, entries);
  const groups = SETTINGS_SECTIONS.map(section => ({
    section,
    rows: results.filter(entry => pageOf(entry.id) === section),
  })).filter(group => group.rows.length > 0);

  return (
    <Stack spacing={3} data-testid="settings-search-results">
      <Stack spacing={1}>
        <Typography component="h2" level="h3" sx={{ fontSize: 26 }}>
          {`Results for "${query.trim()}"`}
        </Typography>
        <Typography level="body-sm" textColor="text.tertiary" data-testid="settings-search-count">
          {results.length === 1 ? '1 setting' : `${results.length} settings`}
        </Typography>
      </Stack>
      {groups.length === 0 && (
        <Typography level="body-md" textColor="text.secondary" data-testid="settings-search-empty">
          {'No settings match. Try "sound", "theme" or "version".'}
        </Typography>
      )}
      {groups.map(({ section, rows }) => (
        <Box
          component="section"
          key={section}
          aria-labelledby={`settings-results-${section}`}
          data-testid={`settings-results-${section}`}
        >
          <Typography
            id={`settings-results-${section}`}
            component="h3"
            level="title-sm"
            textColor="text.tertiary"
            sx={{ mb: 0.5 }}
          >
            {SECTION_LABEL[section]}
          </Typography>
          {rows.map(entry => (
            <SettingsRow
              key={entry.id}
              entry={entry}
              expanded={EXPANDED_SETTINGS.has(entry.id)}
              action={
                <Button
                  size="sm"
                  variant="plain"
                  onClick={() => onOpen(entry.id)}
                  sx={{ ml: 'auto', flexShrink: 0 }}
                  data-testid={`settings-result-open-${entry.id}-btn`}
                >
                  Open in {SECTION_LABEL[section]}
                </Button>
              }
            />
          ))}
        </Box>
      ))}
    </Stack>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The deep-linked row, highlighted for HIGHLIGHT_MS once its page is up, after scrolling it into view.
 * Seeded from `setting` so the first paint already carries the highlight. `request` replays it for
 * the same row. `scroll` is off when Claude import will scroll to its own focused source instead.
 */
function useRowHighlight(
  page: RefObject<HTMLElement | null>,
  section: SettingsSection,
  setting: string | undefined,
  request: number,
  scroll: boolean
): string | undefined {
  const [highlighted, setHighlighted] = useState(setting);
  useEffect(() => {
    setHighlighted(setting);
    if (!setting) return;
    if (scroll) {
      page.current
        ?.querySelector(`[data-entry="${setting}"]`)
        ?.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
    const timer = window.setTimeout(() => setHighlighted(undefined), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [page, section, setting, request, scroll]);
  return highlighted;
}

/** Mod+F focuses the search box. Nothing else on this route claims the chord. */
function useFindShortcut(input: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.code !== 'KeyF' || event.defaultPrevented) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [input]);
}

/**
 * "Settings": app preferences, permissions, connections and maintenance, as a page of its own
 * beside Profile rather than a screen in the conversation pane.
 *
 * Customize owns tool connections. Settings owns everything else app-wide, split into category
 * pages by PAGE_ENTRIES, with a search across all of them. A query replaces the page with results.
 */
export function SettingsScreen({
  auth,
  section = 'general',
  setting,
  importFocus,
  onSection,
  onOpenSetting,
  onClose,
}: {
  auth: AuthState | null;
  section?: SettingsSection;
  /** A row on `section`'s page to scroll to and highlight. */
  setting?: SettingId;
  /** Data and privacy page only: the Claude import source to scroll to, as the sidebar's sync hints ask. */
  importFocus?: ClaudeImportKind;
  /** Opens a page; the route drops `setting` with it. */
  onSection?: (section: SettingsSection) => void;
  onOpenSetting?: (link: { section: SettingsSection; setting: SettingId }) => void;
  onClose: () => void;
}) {
  const focus = section === 'privacy' ? importFocus : undefined;
  const { entries, appVersion } = useSettingsEntries(auth, focus);
  const [query, setQuery] = useState('');
  const [highlightRequest, setHighlightRequest] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;
  const highlighted = useRowHighlight(
    page,
    section,
    setting,
    highlightRequest,
    !(focus && setting === 'claude-import')
  );
  useFindShortcut(searchInput);

  const openSection = (next: SettingsSection) => {
    setQuery('');
    onSection?.(next);
  };

  const openResult = (id: string) => {
    setQuery('');
    if (!isSettingId(id)) return;
    // Only a reopen of the current row needs a replay; any other id re-runs the highlight when the
    // route lands, and bumping here would first flash the previous row.
    if (id === setting) setHighlightRequest(request => request + 1);
    onOpenSetting?.({ section: pageOf(id), setting: id });
  };

  const navItem = (id: SettingsSection) => (
    <ListItem key={id}>
      <ListItemButton
        selected={!searching && id === section}
        onClick={() => openSection(id)}
        data-testid={`settings-nav-${id}-btn`}
      >
        <ListItemDecorator>{SECTION_ICON[id]}</ListItemDecorator>
        <ListItemContent sx={{ minWidth: 0 }}>
          <Typography level="inherit" noWrap>
            {SECTION_LABEL[id]}
          </Typography>
          {id === 'about' && appVersion && (
            <Typography
              level="body-xs"
              textColor="text.tertiary"
              noWrap
              title={appVersion}
              data-testid="settings-nav-about-version"
            >
              Version {appVersion}
            </Typography>
          )}
        </ListItemContent>
        {entryAttentionChip(pageEntries(id, entries), `settings-nav-${id}-attention`)}
      </ListItemButton>
    </ListItem>
  );

  return (
    <Stack sx={{ height: '100vh', bgcolor: 'background.body' }} data-testid="settings-panel">
      {/* ProfileScreen's header, with its column set over the page beside the nav rather than the
          whole window, so the back button lines up with the page below it: shares settingsColumnSx with the page column. */}
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider', pl: `${SETTINGS_NAV_WIDTH}px`, ...columnStackSx }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...settingsColumnSx, py: 1.25 }}>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Back to conversations"
            onClick={onClose}
            sx={{ ml: -0.75 }}
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
        <Stack
          component="nav"
          aria-label="Settings"
          spacing={1}
          sx={{
            flex: 'none',
            boxSizing: 'border-box',
            width: SETTINGS_NAV_WIDTH,
            p: 1,
            borderRight: '1px solid',
            borderColor: 'divider',
          }}
          data-testid="settings-nav"
        >
          <Input
            size="sm"
            startDecorator={<SearchIcon />}
            placeholder="Search settings"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Escape' || !query) return;
              event.preventDefault();
              setQuery('');
            }}
            slotProps={{
              input: { ref: searchInput, 'aria-label': 'Search settings', 'data-testid': 'settings-search-input' },
            }}
          />
          <List
            size="sm"
            aria-label="Settings sections"
            sx={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              p: 0,
              gap: 0.25,
              '--ListItem-radius': 'var(--joy-radius-sm)',
            }}
          >
            {LISTED_SECTIONS.map(navItem)}
          </List>
          <Divider />
          <List size="sm" aria-label="About" sx={{ flex: 'none', p: 0, '--ListItem-radius': 'var(--joy-radius-sm)' }}>
            {navItem('about')}
          </List>
        </Stack>

        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', scrollbarGutter: 'stable', ...thinScrollbarSx }}>
          <Box
            ref={page}
            sx={{ ...settingsColumnSx, py: 4 }}
            data-testid={searching ? 'settings-page-search' : `settings-page-${section}`}
          >
            {searching ? (
              <SearchResults query={query} entries={entries} onOpen={openResult} />
            ) : (
              <SectionPage section={section} entries={entries} highlighted={highlighted} />
            )}
          </Box>
        </Box>
      </Stack>
    </Stack>
  );
}
