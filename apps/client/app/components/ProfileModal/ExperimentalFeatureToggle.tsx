import { SettingKey } from '@bike4mind/common';
import { APP_NAME } from '@client/config/general';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import type { ExperimentalFeature } from '@client/app/contexts/UserSettingsContext';
import { useExperimentalFeatureSettings } from '@client/app/hooks/data/settings';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { Box, Button, ButtonGroup, CircularProgress, Typography } from '@mui/joy';
import { useCallback, useState } from 'react';
import SquareSlideToggle from '@client/app/components/SquareSlideToggle';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import ConfirmationModal from '@client/app/components/common/ConfirmationModal';
import { cardSurfaceSx, mutedTextColor, TYPE } from './settingsStyles';

export default function ExperimentalFeatureToggle() {
  const { settings, updatePreferences } = useUserSettings();
  const { data: serverSettings, isLoading } = useExperimentalFeatureSettings();
  const { isFeatureEnabled } = useFeatureEnabled();

  const getServerSettingValue = (settingName: SettingKey): boolean => {
    const setting = serverSettings?.find(s => s.settingName === settingName);
    if (!setting) return false; // If setting doesn't exist, default to disabled
    const value = setting.settingValue;
    // Handle both string and number types
    let interpreted: boolean;
    if (typeof value === 'number') {
      interpreted = value === 1;
    } else {
      interpreted = value === 'true' || value === '1' || value.toString() === 'true';
    }
    return interpreted;
  };

  const { currentUser } = useUser();
  const currentUserId = currentUser?.id;
  const telemetryLevel = settings.contextTelemetryLevel ?? 'basic';
  const telemetryAdminEnabled = getServerSettingValue('EnableContextTelemetry');
  const [showNoneConfirm, setShowNoneConfirm] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<'idle' | 'error' | 'empty'>('idle');

  const handleExportTelemetry = useCallback(async () => {
    if (!currentUserId) return;
    setIsExporting(true);
    setExportStatus('idle');
    try {
      const { data } = await api.get(`/api/users/${currentUserId}/telemetry-export`);
      if (data.recordCount === 0) {
        setExportStatus('empty');
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `telemetry-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Telemetry] Export failed:', err);
      setExportStatus('error');
    } finally {
      setIsExporting(false);
    }
  }, [currentUserId]);

  const handleTelemetryLevelChange = (level: 'none' | 'basic' | 'enhanced') => {
    if (level === 'none') {
      setShowNoneConfirm(true);
      return;
    }
    updatePreferences({ contextTelemetryLevel: level });
  };

  const handleToggle = (feature: ExperimentalFeature) => {
    updatePreferences({
      experimentalFeatures: {
        [feature]: !isFeatureEnabled(feature),
      },
    });
  };

  // Layer-1 gate: Smart Routing controls are only meaningful when the user is
  // in the experimental cohort; rendering the tri-state for non-gated users
  // would imply behavior they'll never see. Read from `settings` (not
  // `currentUser.preferences`) so the tri-state reflects the optimistic value
  // from `updatePreferences` before the server echo arrives, avoiding a
  // stuck-button flicker on click.
  const agentModeFeatureEnabled = isFeatureEnabled('agentMode');
  const agentModeDefault = settings.agentModeDefault ?? 'off';
  const handleAgentModeDefaultChange = (next: 'off' | 'auto' | 'on') => {
    updatePreferences({ agentModeDefault: next });
  };

  if (isLoading) {
    return (
      <Typography level="body-md" data-testid="experimental-feature-loading-text">
        Loading settings...
      </Typography>
    );
  }

  return (
    <Box
      className="experimental-feature-grid"
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))',
        gap: '1.25rem',
      }}
    >
      <FeatureContainer
        title="Agents"
        featureKey="enableAgents"
        description="Enable AI assistants with specialized capabilities that can be triggered with @mentions."
        helpId="features/agents"
        enabled={isFeatureEnabled('enableAgents')}
        disabled={!getServerSettingValue('EnableAgents')}
        disabledReason={!getServerSettingValue('EnableAgents') ? 'Disabled by administrator' : undefined}
        loading={false}
        onChange={() => handleToggle('enableAgents')}
      />
      <FeatureContainer
        title="Agent Mode"
        featureKey="agentMode"
        description="Let Bike4Mind automatically route complex prompts to multi-step agents that can reason and use tools. Once enabled, choose how it routes in the Smart Routing control below."
        enabled={isFeatureEnabled('agentMode')}
        disabled={!getServerSettingValue('EnableAgentMode')}
        disabledReason={!getServerSettingValue('EnableAgentMode') ? 'Disabled by administrator' : undefined}
        loading={false}
        onChange={() => handleToggle('agentMode')}
      />
      <FeatureContainer
        title="Artifacts"
        featureKey="enableArtifacts"
        description="Generate and collect learning artifacts like summaries, diagrams, and practice exercises."
        helpId="features/artifacts-system"
        enabled={isFeatureEnabled('enableArtifacts')}
        disabled={!getServerSettingValue('EnableArtifacts')}
        disabledReason={!getServerSettingValue('EnableArtifacts') ? 'Disabled by administrator' : undefined}
        loading={false}
        onChange={() => handleToggle('enableArtifacts')}
      />
      <FeatureContainer
        title="B4M Pi"
        featureKey="enableBmPi"
        description="Repository analysis, task scheduling, Gantt charts, and team activity dashboards for project intelligence."
        helpId="features/b4m-pi"
        enabled={isFeatureEnabled('enableBmPi')}
        disabled={!getServerSettingValue('EnableBmPi')}
        disabledReason={!getServerSettingValue('EnableBmPi') ? 'Disabled by administrator' : undefined}
        loading={false}
        onChange={() => handleToggle('enableBmPi')}
      />
      {getServerSettingValue('EnableLattice') && (
        <FeatureContainer
          title="Lattice"
          featureKey="enableLattice"
          description="Create and manipulate financial pro-forma models using natural language. Build spreadsheet-like models through conversation."
          helpId="features/lattice"
          enabled={isFeatureEnabled('enableLattice')}
          loading={false}
          onChange={() => handleToggle('enableLattice')}
        />
      )}
      {getServerSettingValue('EnableMementos') && (
        <FeatureContainer
          title="Mementos"
          featureKey="enableMementos"
          description="Save and revisit important moments from your learning sessions with AI-generated summaries."
          helpId="features/mementos"
          enabled={isFeatureEnabled('enableMementos')}
          loading={false}
          onChange={() => handleToggle('enableMementos')}
        />
      )}
      {getServerSettingValue('EnableOllama') && (
        <FeatureContainer
          title="Private Model Hub"
          featureKey="enableOllama"
          description="Access our exclusive collection of privately hosted cutting-edge models, including DeepSeek, Qwen, and other frontier models not available through mainstream providers."
          helpId="features/private-model-hub"
          enabled={isFeatureEnabled('enableOllama')}
          loading={false}
          onChange={() => handleToggle('enableOllama')}
        />
      )}
      <FeatureContainer
        title="Quest Master"
        featureKey="enableQuestMaster"
        description="Enable our AI model agnostic agentic Quest Master."
        helpId="features/quest-master"
        enabled={isFeatureEnabled('enableQuestMaster')}
        disabled={!getServerSettingValue('EnableQuestMaster')}
        disabledReason={!getServerSettingValue('EnableQuestMaster') ? 'Disabled by administrator' : undefined}
        loading={false}
        onChange={() => handleToggle('enableQuestMaster')}
      />
      <FeatureContainer
        title="Rapid Reply"
        featureKey="enableRapidReply"
        description="Get instant acknowledgments using fast mini models while your full response is being prepared."
        helpId="features/rapid-reply"
        enabled={isFeatureEnabled('enableRapidReply')}
        disabled={!getServerSettingValue('EnableRapidReply')}
        disabledReason={!getServerSettingValue('EnableRapidReply') ? 'Disabled by administrator' : undefined}
        loading={false}
        onChange={() => handleToggle('enableRapidReply')}
      />
      <FeatureContainer
        title="Research Engine"
        featureKey="enableResearchEngine"
        description="Enable the Research Engine feature to search the web for information."
        helpId="features/research-engine"
        enabled={isFeatureEnabled('enableResearchEngine')}
        disabled={!getServerSettingValue('EnableResearchEngine')}
        disabledReason={!getServerSettingValue('EnableResearchEngine') ? 'Disabled by administrator' : undefined}
        loading={false}
        onChange={() => handleToggle('enableResearchEngine')}
      />
      <FeatureContainer
        title="Research Mode"
        featureKey="enableResearchMode"
        description="Compare responses from up to 4 different AI models or configurations simultaneously."
        helpId="features/research-mode"
        enabled={settings.experimentalFeatures?.enableResearchMode}
        disabled={false}
        loading={false}
        onChange={() => handleToggle('enableResearchMode')}
      />
      {/* Full-width telemetry card */}
      <Box
        data-testid="telemetry-level-card"
        sx={theme => ({
          ...cardSurfaceSx(theme),
          gridColumn: '1 / -1',
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          flexWrap: 'wrap',
          gap: '12px',
        })}
      >
        <Box data-testid="telemetry-level-content" sx={{ flex: 1, minWidth: '220px' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
            <Typography level={TYPE.cardTitle}>{APP_NAME ? `Help Improve ${APP_NAME}` : 'Help Improve'}</Typography>
            <ContextHelpButton helpId="features/context-telemetry" tooltipText="Learn about telemetry" size="sm" />
          </Box>
          <Typography level={TYPE.body} sx={{ lineHeight: 1.4, color: mutedTextColor }}>
            {telemetryLevel === 'none' &&
              'Collection is stopped. No telemetry data is being captured. You can re-enable at any time by selecting Basic or Enhanced.'}
            {telemetryLevel === 'basic' &&
              'Sharing performance data: model selection, response times, token counts, and tool success/failure rates. We never collect prompts, responses, or personal information. All data uses rotating IDs and is automatically deleted after 90 days.'}
            {telemetryLevel === 'enhanced' &&
              'Sharing full diagnostic data: everything in Basic plus context composition breakdown, system prompt details, cache efficiency, truncation patterns, tool error details, and sub-agent metrics. Helps us diagnose complex issues. We never collect prompts, responses, or personal information.'}
          </Typography>
          {!telemetryAdminEnabled && (
            <Typography level={TYPE.caption} sx={{ mt: 0.5, color: 'warning.500', fontStyle: 'italic' }}>
              Telemetry is not enabled by administrator
            </Typography>
          )}
        </Box>
        <ButtonGroup
          data-testid="telemetry-level-button-group"
          size="sm"
          variant="outlined"
          disabled={!telemetryAdminEnabled}
          sx={{ flexShrink: 0 }}
        >
          <Button
            data-testid="telemetry-level-none"
            variant={telemetryLevel === 'none' ? 'solid' : 'outlined'}
            color={telemetryLevel === 'none' ? 'danger' : 'neutral'}
            onClick={() => handleTelemetryLevelChange('none')}
          >
            None
          </Button>
          <Button
            data-testid="telemetry-level-basic"
            variant={telemetryLevel === 'basic' ? 'solid' : 'outlined'}
            color={telemetryLevel === 'basic' ? 'primary' : 'neutral'}
            onClick={() => handleTelemetryLevelChange('basic')}
          >
            Basic
          </Button>
          <Button
            data-testid="telemetry-level-enhanced"
            variant={telemetryLevel === 'enhanced' ? 'solid' : 'outlined'}
            color={telemetryLevel === 'enhanced' ? 'success' : 'neutral'}
            onClick={() => handleTelemetryLevelChange('enhanced')}
          >
            Enhanced
          </Button>
        </ButtonGroup>
        {telemetryLevel !== 'none' && (
          <Box sx={{ display: 'flex', alignItems: 'center', ml: 1, gap: 0.5 }}>
            <Button
              data-testid="telemetry-export-btn"
              size="sm"
              variant="outlined"
              color={exportStatus === 'error' ? 'danger' : 'neutral'}
              disabled={isExporting}
              onClick={handleExportTelemetry}
              sx={{ flexShrink: 0 }}
            >
              {isExporting ? (
                <CircularProgress size="sm" />
              ) : exportStatus === 'error' ? (
                'Retry Export'
              ) : (
                'Export My Data'
              )}
            </Button>
            {exportStatus === 'error' && (
              <Typography level="body-xs" color="danger">
                Export failed
              </Typography>
            )}
            {exportStatus === 'empty' && (
              <Typography level="body-xs" color="neutral">
                No telemetry data yet
              </Typography>
            )}
          </Box>
        )}
      </Box>
      {/* Smart Routing - Layer-1 gated. Renders only when the user has the
          experimental Agent-mode flag enabled; otherwise no UI surface so
          non-gated users don't see a control they can't act on. */}
      {agentModeFeatureEnabled && (
        <Box
          data-testid="smart-routing-card"
          sx={theme => ({
            ...cardSurfaceSx(theme),
            gridColumn: '1 / -1',
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'stretch', sm: 'center' },
            flexWrap: 'wrap',
            gap: '12px',
          })}
        >
          <Box sx={{ flex: 1, minWidth: '220px' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
              <Typography level={TYPE.cardTitle}>Smart Routing</Typography>
            </Box>
            <Typography level={TYPE.body} sx={{ lineHeight: 1.4, color: mutedTextColor }}>
              {agentModeDefault === 'off' &&
                'Agent mode only engages when you turn it on manually or @mention an agent.'}
              {agentModeDefault === 'auto' &&
                `${APP_NAME ? `${APP_NAME} decides` : 'The app decides'} when to route to Agent mode based on the request. You can dismiss any auto-routed response to pause auto-routing for the session.`}
              {agentModeDefault === 'on' &&
                'Every message runs through Agent mode (multi-step reasoning + tools). Higher token usage.'}
            </Typography>
          </Box>
          <ButtonGroup data-testid="smart-routing-button-group" size="sm" variant="outlined" sx={{ flexShrink: 0 }}>
            <Button
              data-testid="smart-routing-off"
              variant={agentModeDefault === 'off' ? 'solid' : 'outlined'}
              color={agentModeDefault === 'off' ? 'neutral' : 'neutral'}
              onClick={() => handleAgentModeDefaultChange('off')}
            >
              Off
            </Button>
            <Button
              data-testid="smart-routing-auto"
              variant={agentModeDefault === 'auto' ? 'solid' : 'outlined'}
              color={agentModeDefault === 'auto' ? 'primary' : 'neutral'}
              onClick={() => handleAgentModeDefaultChange('auto')}
            >
              Auto
            </Button>
            <Button
              data-testid="smart-routing-on"
              variant={agentModeDefault === 'on' ? 'solid' : 'outlined'}
              color={agentModeDefault === 'on' ? 'success' : 'neutral'}
              onClick={() => handleAgentModeDefaultChange('on')}
            >
              Always on
            </Button>
          </ButtonGroup>
        </Box>
      )}
      <ConfirmationModal
        open={showNoneConfirm}
        onClose={() => setShowNoneConfirm(false)}
        onConfirm={() => {
          updatePreferences({ contextTelemetryLevel: 'none' });
          setShowNoneConfirm(false);
        }}
        title="Stop Telemetry Collection"
        description="This will stop telemetry collection and delete all your existing telemetry data. This cannot be undone."
        confirmText="Stop & Delete"
        confirmColor="danger"
        showWarningIcon
      />
    </Box>
  );
}

const FeatureContainer = ({
  title,
  description,
  helpId,
  enabled,
  disabled,
  disabledReason,
  loading,
  onChange,
  featureKey,
}: {
  title: string;
  description: string;
  helpId?: string;
  enabled: boolean;
  disabled?: boolean;
  disabledReason?: string;
  loading: boolean;
  onChange: (event: { target: { checked: boolean } }) => void;
  /** Experimental feature key, used to build a per-feature toggle testid so
   *  each Beta toggle is individually targetable (every container otherwise
   *  shared a single `experimental-feature-toggle` testid). */
  featureKey?: ExperimentalFeature;
}) => {
  return (
    <Box
      data-testid="experimental-feature-container"
      sx={theme => ({
        ...cardSurfaceSx(theme),
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
      })}
    >
      <Box data-testid="experimental-feature-content" sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
          <Typography
            data-testid="experimental-feature-title"
            className="experimental-feature-title"
            level={TYPE.cardTitle}
          >
            {title}
          </Typography>
          {helpId && <ContextHelpButton helpId={helpId} tooltipText={`Learn about ${title}`} size="sm" />}
        </Box>
        <Typography
          data-testid="experimental-feature-description"
          level={TYPE.body}
          sx={{ lineHeight: 1.4, color: mutedTextColor }}
        >
          {description}
        </Typography>
        {disabledReason && (
          <Typography
            data-testid="experimental-feature-disabled-reason"
            level={TYPE.caption}
            sx={{ mt: 0.5, color: 'warning.500', fontStyle: 'italic' }}
          >
            {disabledReason}
          </Typography>
        )}
      </Box>

      <Box
        data-testid="experimental-feature-toggle-container"
        className="experimental-feature-toggle-container"
        sx={{ flexShrink: 0 }}
      >
        {loading ? (
          <CircularProgress size="sm" />
        ) : (
          <SquareSlideToggle
            checked={enabled}
            disabled={disabled}
            onChange={onChange}
            data-testid={featureKey ? `experimental-feature-toggle-${featureKey}` : 'experimental-feature-toggle'}
          />
        )}
      </Box>
    </Box>
  );
};
