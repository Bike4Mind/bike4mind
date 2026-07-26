import Button from '@mui/joy/Button';
import Tooltip from '@mui/joy/Tooltip';
import WaterOutlinedIcon from '@mui/icons-material/WaterOutlined';
import { toast } from 'sonner';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useUpdateSession } from '@client/app/hooks/data/sessions';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';

/**
 * Header toggle that grounds the current chat in the user's Data Lakes. It flips
 * `forceKnowledgeRetrieval` on the session (never `surface`, so the chat stays in the
 * sidebar list) and drives the tree-left/chat-right surface via useDataLakeMode.
 * On /new (no session yet) it flips only the store; the first send then creates the
 * grounded session (see useSendMessage).
 */
export default function DataLakeToggle() {
  const { isFeatureEnabled } = useAdminSettingsCache();
  const { currentSession, setCurrentSession } = useSessions();
  const enabled = useDataLakeMode(s => s.enabled);
  const setEnabled = useDataLakeMode(s => s.setEnabled);
  const { mutate: updateSession } = useUpdateSession();

  if (!isFeatureEnabled('EnableDataLakes')) return null;

  const handleToggle = () => {
    const next = !enabled;
    setEnabled(next);
    // /new: no session yet - hold the intent in the store; the first send creates
    // the grounded session (see useSendMessage). Persist only when one exists.
    if (!currentSession) return;
    const updated = { ...currentSession, forceKnowledgeRetrieval: next };
    setCurrentSession(updated);
    updateSession(updated, {
      onError: () => {
        // Persist failed: roll back so the UI matches the server (grounding really off/on).
        setEnabled(!next);
        setCurrentSession(currentSession);
        toast.error('Could not update Data Lake mode - please try again.');
      },
    });
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
