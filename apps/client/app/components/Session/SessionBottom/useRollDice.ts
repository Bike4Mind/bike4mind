import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { MiscEvents } from '@bike4mind/common';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { useCreateNewSession } from '@client/app/hooks/data/sessions';
import { RollCommandArgs, handleRollCommand } from '@client/app/components/commands/RollCommand';

export function useRollDice(): { rollRandomDice: () => Promise<void> } {
  const {
    currentSession,
    currentSessionId,
    setCurrentSession,
    workBenchAgents,
    setWorkBenchAgents,
    setCurrentSessionId,
  } = useSessions();
  const createNewSession = useCreateNewSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logEvent = useLogEvent();

  const rollRandomDice = async (): Promise<void> => {
    logEvent.mutate({ type: MiscEvents.ROLLED_DICE });

    let session = currentSession;
    if (!session) {
      session = await createNewSession.mutateAsync();

      // Clear workBench agents since they're now attached to the session during creation
      if (workBenchAgents.length > 0) {
        setWorkBenchAgents([]);
        console.log(`🤖 Cleared ${workBenchAgents.length} workBench agents after session creation`);
      }

      // Immediately update the currentSessionId to prepare WebSocket subscriptions
      if (session) {
        setCurrentSessionId(session.id);
        setCurrentSession(session);
      }
    }
    if (!session) {
      console.error('Error creating new session');
      return;
    }

    const args: RollCommandArgs = {
      params: '', // No params provided, it will be generated inside handleRollCommand
      currentSession: session,
      queryClient,
    };
    handleRollCommand(args);
    if (currentSessionId === null) {
      navigate({ to: `/notebooks/${session.id}` });
    }
  };

  return { rollRandomDice };
}
