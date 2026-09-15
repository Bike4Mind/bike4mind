import { Box } from '@mui/joy';
import {
  Image as ImageIcon,
  Language as WebFetchIcon,
  HdrAuto as AtlassianIcon,
  GitHub as GitHubIcon,
} from '@mui/icons-material';
import WebSearchIcon from '../svgs/icons/WebSearchIcon';
import SupportsToolsIcon from '../svgs/SupportsToolsIcon';
import CountBadge from './CountBadge';
import { green } from '../../utils/themes/colors';

// MCP servers that render as their own icon here. Enabled servers NOT in this set
// (e.g. linkedin, notion) have no icon, so they fall into the "+N" count badge
// instead. Callers computing that count must exclude these to avoid double-counting.
export const ICONED_MCP_SERVERS = ['github', 'atlassian'];

interface ToolIndicatorsProps {
  activePrimaryTools: string[];
  isThinkingActive: boolean;
  otherActiveToolsCount: number;
  /** List of enabled MCP servers (e.g., ['confluence', 'jira']). When null, all available servers are shown. */
  enabledMcpServers?: string[] | null;
  /** List of MCP servers available in the database (e.g., ['github', 'atlassian']). Defaults to all servers. */
  availableMcpServers?: string[];
  /** Custom color for active tools (default: green[800]) */
  activeColor?: string;
  /** Size of the tool icons (default: '16px') */
  iconSize?: string;
  /** Gap between indicators (default: '12px') */
  gap?: string;
  /** Custom margins for individual icons */
  iconMargins?: {
    webSearch?: string;
    webFetch?: string;
    imageGeneration?: string;
    thinking?: string;
    confluence?: string;
    jira?: string;
    github?: string;
    counter?: string;
  };
}

const ToolIndicators = ({
  activePrimaryTools,
  isThinkingActive,
  otherActiveToolsCount,
  enabledMcpServers = null,
  availableMcpServers = ICONED_MCP_SERVERS, // Default to the servers that have icons
  activeColor = green[800],
  iconSize = '16px',
  gap = '8px',
  iconMargins = {},
}: ToolIndicatorsProps) => {
  const indicators = [];

  // Show an MCP server only if it's available AND (no enable-list set, or it's listed).
  const shouldShowMcpServer = (serverName: string) => {
    if (!availableMcpServers.includes(serverName)) {
      return false;
    }

    if (enabledMcpServers === null) {
      return true;
    }

    return enabledMcpServers.includes(serverName);
  };

  // Add primary tool icons
  if (activePrimaryTools.includes('web_search')) {
    indicators.push(
      <WebSearchIcon
        className="tool-indicator-web-search"
        key="search"
        sx={{
          fontSize: iconSize,
          color: activeColor,
          ...(iconMargins.webSearch && { m: iconMargins.webSearch }),
        }}
      />
    );
  }

  if (activePrimaryTools.includes('web_fetch')) {
    indicators.push(
      <WebFetchIcon
        className="tool-indicator-web-fetch"
        key="web-fetch"
        sx={{
          fontSize: iconSize,
          color: activeColor,
          ...(iconMargins.webFetch && { m: iconMargins.webFetch }),
        }}
      />
    );
  }

  if (activePrimaryTools.includes('image_generation')) {
    indicators.push(
      <ImageIcon
        className="tool-indicator-image-generation"
        key="image"
        sx={{
          fontSize: iconSize,
          color: activeColor,
          ...(iconMargins.imageGeneration && { m: iconMargins.imageGeneration }),
        }}
      />
    );
  }

  // Add MCP server icons
  if (shouldShowMcpServer('atlassian')) {
    indicators.push(
      <AtlassianIcon
        className="tool-indicator-confluence"
        key="confluence"
        sx={{
          fontSize: iconSize,
          color: activeColor,
          ...(iconMargins.confluence && { m: iconMargins.confluence }),
        }}
      />
    );
  }

  if (shouldShowMcpServer('github')) {
    indicators.push(
      <GitHubIcon
        className="tool-indicator-github"
        key="github"
        sx={{
          fontSize: iconSize,
          color: activeColor,
          ...(iconMargins.github && { m: iconMargins.github }),
        }}
      />
    );
  }

  // Add thinking icon
  if (isThinkingActive) {
    indicators.push(
      <Box
        className="tool-indicator-thinking"
        key="thinking"
        sx={{ m: iconMargins.thinking || '0px 0px 0 0px', display: 'inline-flex' }}
      >
        <SupportsToolsIcon width={20} height={20} fill={activeColor} />
      </Box>
    );
  }

  // Add count for other tools
  if (otherActiveToolsCount > 0) {
    indicators.push(
      <CountBadge
        key="count"
        prefix="+"
        count={otherActiveToolsCount}
        color={activeColor}
        margin={iconMargins.counter || '0px 0px 0 0px'}
        sx={{ width: 'auto', minWidth: 'auto', px: 1 }}
      />
    );
  }

  if (indicators.length === 0) {
    return null;
  }

  return (
    <Box className="tool-indicators-container" sx={{ display: 'flex', alignItems: 'center', gap }}>
      {indicators}
    </Box>
  );
};

export default ToolIndicators;
