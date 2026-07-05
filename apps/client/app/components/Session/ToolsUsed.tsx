import { Chip, Tooltip, Box, Stack, Typography, Modal, ModalDialog, ModalClose, IconButton } from '@mui/joy';
import { Construction as ConstructionIcon, Info as InfoIcon } from '@mui/icons-material';
import { memo, useMemo, useState } from 'react';
import { getToolInfo, getToolDisplayName, PublicTools } from '@client/app/utils/toolMapping';

interface FunctionCall {
  name?: string;
  parameters?: Record<string, unknown>;
  returnValue?: string;
  executionTime?: number;
  success?: boolean;
  error?: string;
}

interface ToolsUsedProps {
  /**
   * Array of function calls from promptMeta.functionCalls
   */
  functionCalls?: FunctionCall[];
  /**
   * Size variant for the chip
   */
  size?: 'sm' | 'md' | 'lg';
}

const ToolsUsed = memo<ToolsUsedProps>(({ functionCalls = [], size = 'sm' }) => {
  const [selectedTool, setSelectedTool] = useState<FunctionCall | null>(null);

  const uniqueTools = useMemo(() => {
    const toolSet = new Set<string>();
    functionCalls.forEach(call => {
      if (call.name) {
        toolSet.add(call.name);
      }
    });
    return Array.from(toolSet);
  }, [functionCalls]);

  if (!uniqueTools.length) {
    return null;
  }

  return (
    <>
      <Tooltip
        title={
          <Box>
            <Typography level="body-sm" sx={{ fontWeight: 'bold', mb: 1 }}>
              Tools Used ({uniqueTools.length}):
            </Typography>
            <Stack spacing={0.5}>
              {uniqueTools.map(toolName => {
                const toolInfo = getToolInfo(toolName as PublicTools);
                const toolCalls = functionCalls.filter(call => call.name === toolName);

                return (
                  <Box key={toolName} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box sx={{ color: toolInfo?.color || 'text.secondary', display: 'flex' }}>
                      {toolInfo?.icon && <toolInfo.icon sx={{ fontSize: 16 }} />}
                    </Box>
                    <Typography level="body-xs">
                      {getToolDisplayName(toolName as PublicTools)}
                      {toolCalls.length > 1 && ` (${toolCalls.length}x)`}
                    </Typography>
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="neutral"
                      onClick={e => {
                        e.stopPropagation();
                        setSelectedTool(toolCalls[0]);
                      }}
                      sx={{ '--IconButton-size': '20px', ml: 'auto' }}
                    >
                      <InfoIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Box>
                );
              })}
            </Stack>
          </Box>
        }
        placement="top"
      >
        <Chip
          data-testid="tools-used"
          size={size}
          variant="soft"
          sx={theme => ({
            bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
            color: theme.palette.fileBrowser.statusChip.textColor,
            fontSize: '13px',
            height: '24px',
            border: `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`,
            gap: '4px',
            px: '8px',
            fontWeight: 500,
            cursor: 'pointer',
            '&:hover': {
              bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
              opacity: 0.8,
            },
          })}
          startDecorator={<ConstructionIcon sx={{ fontSize: 14 }} />}
        >
          {uniqueTools.length}
        </Chip>
      </Tooltip>

      {/* Tool Details Modal */}
      <Modal open={!!selectedTool} onClose={() => setSelectedTool(null)}>
        <ModalDialog
          sx={{
            maxWidth: 600,
            maxHeight: '80vh',
            overflow: 'auto',
          }}
        >
          <ModalClose />
          <Typography level="h4" sx={{ mb: 2 }}>
            {selectedTool?.name ? getToolDisplayName(selectedTool.name as PublicTools) : 'Tool Details'}
          </Typography>

          {selectedTool?.parameters && Object.keys(selectedTool.parameters).length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Typography level="title-sm" sx={{ mb: 1 }}>
                Parameters
              </Typography>
              <Box
                sx={{
                  backgroundColor: 'background.level1',
                  borderRadius: 1,
                  p: 1,
                  fontFamily: 'monospace',
                  fontSize: '12px',
                }}
              >
                {Object.entries(selectedTool.parameters).map(([key, value]) => (
                  <Typography key={key} level="body-xs" sx={{ fontFamily: 'monospace' }}>
                    <strong>{key}:</strong> {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                  </Typography>
                ))}
              </Box>
            </Box>
          )}

          {selectedTool?.returnValue && (
            <Box>
              <Typography level="title-sm" sx={{ mb: 1 }}>
                Response
              </Typography>
              <Box
                sx={{
                  backgroundColor: 'background.level1',
                  borderRadius: 1,
                  p: 2,
                  maxHeight: '400px',
                  overflow: 'auto',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                  {selectedTool.returnValue}
                </Typography>
              </Box>
            </Box>
          )}

          {selectedTool?.error && (
            <Box sx={{ mt: 2 }}>
              <Typography level="title-sm" color="danger" sx={{ mb: 1 }}>
                Error
              </Typography>
              <Typography level="body-sm" color="danger">
                {selectedTool.error}
              </Typography>
            </Box>
          )}

          {selectedTool?.executionTime && (
            <Typography level="body-xs" sx={{ mt: 2, color: 'text.secondary' }}>
              Execution time: {selectedTool.executionTime}ms
            </Typography>
          )}
        </ModalDialog>
      </Modal>
    </>
  );
});

ToolsUsed.displayName = 'ToolsUsed';

export default ToolsUsed;
