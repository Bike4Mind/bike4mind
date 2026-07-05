// KEEP IN SYNC with the inline HeartbeatAction/HeartbeatLogEntry in
// packages/premium/tavern/src/client/stores/useHeartbeatStore.ts. This core copy
// exists only so the retained TavernArtifactRenderer chat seam can type its props
// without importing the premium-tavern package. The package intentionally
// duplicates these definitions to stay self-contained.

/** All possible heartbeat log action types */
export type HeartbeatAction =
  | 'idle'
  | 'speech'
  | 'thought'
  | 'memory'
  | 'move'
  | 'reply'
  | 'post_quest'
  | 'claim_quest'
  | 'complete_quest'
  | 'tool_use'
  | 'email'
  | 'move_decoration'
  | 'gate_paused'
  | 'gate_timed'
  | 'gate_proceed'
  | 'yolo_override'
  | 'intent'
  | 'report'
  | 'credits';

export interface HeartbeatLogEntry {
  id: string;
  agentId: string;
  agentName: string;
  action: HeartbeatAction;
  text?: string;
  toolOutput?: string;
  targetAgentName?: string;
  threadId?: string;
  timestamp: Date;
  burstId?: string;
  stepIndex?: number;
  totalSteps?: number;
  confidence?: number;
  confidenceSource?: string;
  creditsUsed?: number;
  energy?: number;
  curiosity?: number;
  artifact?: {
    type: 'mermaid' | 'recharts' | 'image';
    data: string;
    title?: string;
    description?: string;
  };
}
