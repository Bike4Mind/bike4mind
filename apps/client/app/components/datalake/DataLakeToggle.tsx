import Button from '@mui/joy/Button';
import Tooltip from '@mui/joy/Tooltip';
import WaterOutlinedIcon from '@mui/icons-material/WaterOutlined';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useUpdateSession } from '@client/app/hooks/data/sessions';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';

/**
 * Header toggle that grounds the current chat in the user's Data Lakes. It flips
 * `forceKnowledgeRetrieval` on the session (never `surface`, so the chat stays in the
 * sidebar list) and drives the tree-left/chat-right surface via useDataLakeMode.
 * Phase 1: existing sessions only (gated on currentSession); /new support is Phase 2.
 */
export default function DataLakeToggle() {
  const { isFeatureEnabled } = useAdminSettingsCache();
  const { currentSession, setCurrentSession } = useSessions();
  const enabled = useDataLakeMode(s => s.enabled);
  const setEnabled = useDataLakeMode(s => s.setEnabled);
  const { mutate: updateSession } = useUpdateSession();

  if (!isFeatureEnabled('EnableDataLakes') || !currentSession) return null;

  const handleToggle = () => {
    const next = !enabled;
    setEnabled(next);
    const updated = { ...currentSession, forceKnowledgeRetrieval: next };
    setCurrentSession(updated);
    updateSession(updated);
  };

  return (
    <Tooltip
      title={enabled ? 'Data Lakes on - grounding across your lakes' : 'Ground this chat in your Data Lakes'}
      disableInteractive
    >
      <Button
        size="sm"
        variant={enabled ? 'solid' : 'outlined'}
        color={enabled ? 'primary' : 'neutral'}
        startDecorator={<WaterOutlinedIcon sx={{ fontSize: 18 }} />}
        onClick={handleToggle}
        data-testid="datalake-mode-toggle"
        aria-pressed={enabled}
      >
        Data Lakes
      </Button>
    </Tooltip>
  );
}
