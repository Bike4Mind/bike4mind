import { useAgentExecutionSubscriptions } from '@client/app/hooks/useAgentExecution';

/**
 * Mounts the agent-execution WS listeners at the WebsocketProvider scope so
 * they survive route navigation. Putting them inside SessionContainer caused
 * the listeners to be torn down during the `/new -> /notebooks/$id` swap,
 * dropping the first `execution_started` / `iteration_step` events.
 */
const AgentExecutionSubscriber = () => {
  useAgentExecutionSubscriptions();
  return null;
};

export default AgentExecutionSubscriber;
