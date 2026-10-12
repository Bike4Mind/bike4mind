import { FC } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useConfig } from '@client/app/hooks/data/settings';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { isToolKeyMissing } from '@client/app/utils/toolMapping';
import { replyReportsNoWebSearch } from '@client/app/utils/webSearchUnavailable';

/**
 * Under a reply that says it had no search tool, offers the same switch as Tools > Web Search.
 * Hidden once Web Search is on, and when the deployment has no search key (the switch is disabled
 * there too, see ToolsSection), and for models without tool support (ToolsSection clears the tool list
 * for them, so the switch would do nothing). Fast mode sends no tools at all (resolveTools in
 * useLLMSettingsAssembly), so there the click also switches Tools to Smart.
 */
const EnableWebSearchAction: FC<{ reply: string }> = ({ reply }) => {
  const [tools, toolMode, setLLM, model] = useLLM(useShallow(s => [s.tools, s.toolMode, s.setLLM, s.model]));
  const { data: config } = useConfig();
  const { data: modelInfo } = useModelInfo();
  const supportsTools = !!modelInfo?.find(m => m.id === model)?.supportsTools;

  if (
    !supportsTools ||
    (toolMode !== 'fast' && tools.includes('web_search')) ||
    isToolKeyMissing('web_search', config?.toolAvailability) ||
    !replyReportsNoWebSearch(reply)
  ) {
    return null;
  }

  const enable = () => {
    setLLM({
      toolMode: 'smart',
      tools: tools.includes('web_search') ? tools : [...tools, 'web_search'],
    });
    toast.success('Web Search is on. Send your question again to search the web.');
  };

  return (
    <Box
      data-testid="enable-web-search-action"
      sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 1 }}
    >
      <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
        Web Search is off.
      </Typography>
      <Button
        size="sm"
        variant="soft"
        color="primary"
        startDecorator={<TravelExploreIcon />}
        onClick={enable}
        data-testid="enable-web-search-btn"
      >
        Enable web search
      </Button>
    </Box>
  );
};

export default EnableWebSearchAction;
