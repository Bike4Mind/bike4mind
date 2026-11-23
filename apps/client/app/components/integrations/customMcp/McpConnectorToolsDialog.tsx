import { useId, useState } from 'react';
import { Box, Chip, DialogTitle, Input, Link, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import { Link as RouterLink } from '@tanstack/react-router';
import type { McpConnectionListEntry } from '@bike4mind/common';
import {
  connectorToolsOffered,
  filterConnectorTools,
  toolHintLabels,
  toolTitle,
  TOOL_FILTER_THRESHOLD,
  type McpConnectionTool,
} from './customMcpModel';

const TEST_ID = 'mcp-connector-tools';
const META_SEPARATOR = ' \u00b7 ';

const countText = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const ToolItem = ({ tool }: { tool: McpConnectionTool }) => {
  const title = toolTitle(tool);
  return (
    <Box component="li" data-testid={`${TEST_ID}-tool-${tool.name}`} sx={{ px: '12px', py: '10px' }}>
      <Typography
        level="body-sm"
        sx={{ fontWeight: 600, overflowWrap: 'anywhere', ...(title ? {} : { fontFamily: 'code' }) }}
      >
        {title ?? tool.name}
      </Typography>
      {title && (
        <Typography level="body-xs" sx={{ fontFamily: 'code', color: 'text.tertiary', overflowWrap: 'anywhere' }}>
          {tool.name}
        </Typography>
      )}
      {tool.description ? (
        <Typography level="body-xs" sx={{ mt: '4px', color: 'text.secondary', overflowWrap: 'anywhere' }}>
          {tool.description}
        </Typography>
      ) : (
        <Typography level="body-xs" sx={{ mt: '4px', color: 'text.tertiary', fontStyle: 'italic' }}>
          No description from the server.
        </Typography>
      )}
      <Stack direction="row" flexWrap="wrap" gap="6px" sx={{ mt: '8px' }}>
        {toolHintLabels(tool).map(hint => (
          <Chip key={hint.label} size="sm" variant="outlined" color={hint.color}>
            {hint.label}
          </Chip>
        ))}
      </Stack>
    </Box>
  );
};

const ConnectorTools = ({
  connection,
  titleId,
  onClose,
}: {
  connection: McpConnectionListEntry;
  titleId: string;
  onClose: () => void;
}) => {
  const [query, setQuery] = useState('');
  const { tools, otherCount } = connectorToolsOffered(connection);
  const shown = filterConnectorTools(tools, query);
  const platform = connection.ownerType === 'platform';
  return (
    <>
      <ModalClose aria-label="Close" data-testid={`${TEST_ID}-close-btn`} />
      <Stack gap="4px" sx={{ pr: '32px' }}>
        <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
          {connection.displayName}
        </DialogTitle>
        {connection.description && (
          <Typography
            level="body-sm"
            data-testid={`${TEST_ID}-description`}
            sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}
          >
            {connection.description}
          </Typography>
        )}
        <Typography
          level="body-xs"
          data-testid={`${TEST_ID}-meta`}
          sx={{ color: 'text.tertiary', overflowWrap: 'anywhere' }}
        >
          {[
            countText(tools.length, 'tool'),
            connection.urlHost,
            platform ? 'Set up by an admin' : 'Your connector',
          ].join(META_SEPARATOR)}
        </Typography>
      </Stack>
      <Typography level="body-xs" data-testid={`${TEST_ID}-provenance`} sx={{ color: 'text.tertiary' }}>
        Descriptions and labels are the server&apos;s own claims.
      </Typography>
      {(tools.length > TOOL_FILTER_THRESHOLD || query.length > 0) && (
        <Input
          size="sm"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Filter by name or description"
          startDecorator={<SearchIcon />}
          slotProps={{ input: { 'aria-label': 'Filter tools', 'data-testid': `${TEST_ID}-filter-input` } }}
        />
      )}
      <Box sx={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
        {shown.length > 0 ? (
          <Box
            component="ul"
            data-testid={`${TEST_ID}-list`}
            sx={{
              listStyle: 'none',
              m: 0,
              p: 0,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: '8px',
              '& > li + li': { borderTop: '1px solid', borderColor: 'divider' },
            }}
          >
            {shown.map(tool => (
              <ToolItem key={tool.name} tool={tool} />
            ))}
          </Box>
        ) : (
          <Typography level="body-sm" data-testid={`${TEST_ID}-no-match`} sx={{ color: 'text.tertiary' }}>
            No tools match this filter.
          </Typography>
        )}
      </Box>
      {!platform && otherCount > 0 && (
        <Typography level="body-xs" data-testid={`${TEST_ID}-others`} sx={{ color: 'text.tertiary' }}>
          {countText(otherCount, 'more tool')} {otherCount === 1 ? 'is' : 'are'} switched off or waiting for review.{' '}
          <Link
            component={RouterLink}
            to="/integrations"
            onClick={onClose}
            level="body-xs"
            data-testid={`${TEST_ID}-manage-link`}
          >
            Manage in Integrations
          </Link>
        </Typography>
      )}
    </>
  );
};

/**
 * Read-only view of a custom connector from the Tools menu: what it is, where it points, who set
 * it up, and the tools it offers this user. Switching it on or off stays on the menu row.
 */
const McpConnectorToolsDialog = ({
  connection,
  onClose,
}: {
  connection: McpConnectionListEntry | null;
  onClose: () => void;
}) => {
  const titleId = useId();
  return (
    // Above the Tools menu (z-index 1400), like the other dialogs it opens.
    <Modal open={connection !== null} onClose={onClose} sx={{ zIndex: 1500 }}>
      <ModalDialog
        aria-labelledby={titleId}
        data-testid={`${TEST_ID}-dialog`}
        // The Tools menu is this dialog's React parent, so keys bubble to its list, which takes arrows
        // and Home/End for itself; Escape still has to reach the Modal to close it.
        onKeyDown={event => {
          if (event.key !== 'Escape') event.stopPropagation();
        }}
        sx={{
          width: 'calc(100vw - 32px)',
          maxWidth: 560,
          maxHeight: 'calc(100dvh - 32px)',
          gap: '12px',
          overflow: 'hidden',
        }}
      >
        {connection && <ConnectorTools connection={connection} titleId={titleId} onClose={onClose} />}
      </ModalDialog>
    </Modal>
  );
};

export default McpConnectorToolsDialog;
