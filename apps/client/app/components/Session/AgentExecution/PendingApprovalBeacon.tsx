import { Box, Button } from '@mui/joy';
import { keyframes } from '@mui/system';
import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import WarningRoundedIcon from '@mui/icons-material/WarningRounded';
import { useAgentExecutionStore, selectPendingApprovalForSession } from '@client/app/stores/useAgentExecutionStore';
import { humanizeToolName } from './PermissionCard';

// Local keyframe - there is no global `bounce` keyframe in the app, so referencing the bare name
// `'bounce'` (as some older call sites do) is a silent no-op. Define it here so the pill actually
// animates and draws the eye to a pending approval.
const bounce = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
`;

interface PendingApprovalBeaconProps {
  sessionId: string;
  scrollerRef: React.RefObject<HTMLElement | null>;
}

/**
 * Bottom-anchored beacon that surfaces a pending agent permission request where the user's
 * attention actually is (next to the composer). The `PermissionCard` itself renders inline at the
 * end of the scroll content; in a long or actively-streaming transcript it scrolls out of view, so
 * the run looks frozen when it is really waiting on an Approve click far above. This pill makes the
 * pending decision visible and jumps the user straight to the card.
 *
 * Reuses the existing pending-approval store state (`selectPendingApprovalForSession`) and the same
 * scroller-ref scroll mechanism the ScrollToBottomButton uses - no new server/WS plumbing.
 */
const PendingApprovalBeacon = memo(({ sessionId, scrollerRef }: PendingApprovalBeaconProps) => {
  // Memoize the selector factory so zustand doesn't re-run the scan on every store event
  // (mirrors ActiveAgentExecutions); useShallow keeps the {executionId,toolName} output stable.
  const selector = useMemo(() => selectPendingApprovalForSession(sessionId), [sessionId]);
  const pending = useAgentExecutionStore(useShallow(selector));

  if (!pending) return null;

  const handleClick = () => {
    // The PermissionCard is always mounted in the (non-virtualized) footer, so its element exists
    // even when off-screen - scroll directly to it. Fall back to the scroll container's bottom.
    const card = document.querySelector(`[data-testid="permission-card-${pending.executionId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  };

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1200, // above the generic ScrollToBottomButton (1100) - approval is the priority signal
        pointerEvents: 'none',
        maxWidth: '100%',
      }}
    >
      <Button
        size="sm"
        color="warning"
        variant="solid"
        startDecorator={<WarningRoundedIcon />}
        data-testid="pending-approval-beacon"
        onClick={handleClick}
        sx={{
          pointerEvents: 'auto',
          px: 1.5, // 12px sides
          py: 1, // 8px top/bottom
          borderRadius: 'xl',
          boxShadow: 'md',
          whiteSpace: 'nowrap',
          transition: 'background-color 0.25s ease', // smooth hover fade
          animation: `${bounce} 4s ease-in-out infinite`,
          '&:hover': { animation: 'none' },
        }}
      >
        Approval needed: {humanizeToolName(pending.toolName)} — tap to review
      </Button>
    </Box>
  );
});

PendingApprovalBeacon.displayName = 'PendingApprovalBeacon';

export default PendingApprovalBeacon;
