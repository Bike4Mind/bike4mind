import { ISessionDocument } from '@bike4mind/common';
import { useShallow } from 'zustand/react/shallow';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useMcpServers } from '@client/app/hooks/data/mcpServers';
import { useConfig } from '@client/app/hooks/data/settings';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { filterToolsForDisplay } from '@client/app/utils/toolMapping';
import { effectiveDisabledTools } from '@client/app/utils/effectiveDisabledTools';
import { AGENT_ONLY_MCP_SERVERS, ICONED_MCP_SERVERS } from '../../common/ToolIndicators';

const PRIMARY_TOOLS = ['web_search', 'web_fetch', 'image_generation'] as const;

/**
 * What the Tools button's indicators show: the composer row on desktop (AdvancedAISettings) and
 * the Tools row of the phone's plus menu (AttachFileButton) read the same numbers from here.
 */
export function useActiveTools(currentSession: ISessionDocument | null) {
  const { isFeatureEnabled } = useFeatureEnabled();
  const isAgentsFeatureEnabled = isFeatureEnabled('enableAgents');
  const isQuestMasterFeatureEnabled = isFeatureEnabled('enableQuestMaster');
  const isLatticeFeatureEnabled = isFeatureEnabled('enableLattice');

  const [tools, toolMode, enabledMcpServers, skipAutoOffers, model, thinking] = useLLM(
    useShallow(s => [s.tools, s.toolMode, s.enabledMcpServers, s.skipAutoOffers, s.model, s.thinking])
  );
  const [isQuestMasterEnabled, isAgentsEnabled, isLatticeEnabled] = useLLM(
    useShallow(s => [s.isQuestMasterEnabled, s.isAgentsEnabled, s.isLatticeEnabled])
  );

  // Presence-only availability of key-gated tools. Already mounted app-wide by
  // WebsocketConfigProvider with a 5-min staleTime, so this shares that cache
  // rather than adding a request.
  const { data: serverConfig } = useConfig();
  const { data: mcpServersData = [] } = useMcpServers();
  const availableMcpServers = mcpServersData.filter(server => server.enabled).map(server => server.name);

  // Indicators must agree with the Tools picker: a tool whose key is missing renders
  // off there, and one the session denies is not listed at all, so neither may show an
  // icon or feed the "+N" badge here. The raw `tools` still goes to ToolsButton -
  // that array is what handleToggleTool reads and rewrites, so filtering it would drop
  // preferences on the next toggle.
  const disabledTools = effectiveDisabledTools(currentSession);
  const displayTools = filterToolsForDisplay(tools, serverConfig?.toolAvailability, disabledTools);
  const activePrimaryTools: string[] = PRIMARY_TOOLS.filter(tool => displayTools.includes(tool));
  const isThinkingActive = thinking?.enabled ?? false;
  // Integrations that actually reach this turn. "Only tools I pick" withholds every
  // non-agent-only MCP tool server-side (`offerOnlyNamedTools` in sharedToolBuilder), so
  // those integrations contribute nothing and must not read as active here - the same
  // reason ToolsButton hides every indicator in Fast mode. Agent-only servers are exempt
  // from that gate (delegation reaches them either way), so they keep their icon.
  const activeMcpServers = availableMcpServers.filter(
    name =>
      (enabledMcpServers === null || enabledMcpServers.includes(name)) &&
      (!skipAutoOffers || AGENT_ONLY_MCP_SERVERS.includes(name))
  );
  // Active integrations without their own icon (e.g. linkedin, notion) roll into the
  // "+N" badge; iconed ones (ICONED_MCP_SERVERS) are shown as icons and excluded here
  // so they aren't double-counted.
  const iconedMcpCount = activeMcpServers.filter(name => ICONED_MCP_SERVERS.includes(name)).length;
  const enabledNonIconMcpCount = activeMcpServers.length - iconedMcpCount;
  // Feature-gated switches outside the `tools` array (Quest Master, Agent Detection,
  // Lattice). Must stay in sync with pinnedCount's specialToolsCount in ToolsSection.
  const specialToolsCount =
    (isQuestMasterFeatureEnabled && isQuestMasterEnabled ? 1 : 0) +
    (isAgentsFeatureEnabled && isAgentsEnabled ? 1 : 0) +
    (isLatticeFeatureEnabled && isLatticeEnabled ? 1 : 0);
  const otherActiveToolsCount =
    displayTools.filter(
      tool => !PRIMARY_TOOLS.includes(tool as unknown as (typeof PRIMARY_TOOLS)[number]) && tool !== 'dice_roll'
    ).length +
    specialToolsCount +
    enabledNonIconMcpCount;

  // Fast mode and a model without tool support send no tools, so nothing counts (ToolsButton
  // hides its indicators for the same reason). Same fail-open as ToolsButton while the catalog
  // has not resolved the model yet.
  const { data: modelInfoRepo } = useModelInfo();
  const info = modelInfoRepo?.find(m => m.id === model);
  const toolsLive = toolMode !== 'fast' && (info ? !!info.supportsTools : true);
  const activeToolsCount = toolsLive ? activePrimaryTools.length + iconedMcpCount + otherActiveToolsCount : 0;

  return {
    tools,
    toolMode,
    disabledTools,
    activePrimaryTools,
    isThinkingActive,
    activeMcpServers,
    availableMcpServers,
    otherActiveToolsCount,
    /** Every tool and integration the Tools button would show, as one number. */
    activeToolsCount,
  };
}
