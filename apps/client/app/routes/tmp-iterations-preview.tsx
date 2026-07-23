/**
 * TEMP DEV HARNESS - multi-iteration preview. NOT for commit.
 *
 * Seeds a mock 3-iteration agent execution into the store and mounts the REAL
 * <IterationStream> against it, so the multi-iteration layout (spacing,
 * dividers, collapse/expand, credits header) can be eyeballed without a live
 * run. Visit /tmp-iterations-preview while logged in.
 *
 * Delete this file (and its route registration in router.tsx) before committing.
 */
import { useEffect, useState } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import type { IAgentStep } from '@bike4mind/common';
import IterationStream from '@client/app/components/Session/AgentExecution/IterationStream';
import {
  useAgentExecutionStore,
  type ParentExecution,
  type IterationStep,
} from '@client/app/stores/useAgentExecutionStore';

const NOW = Date.now();
const MOCK_ID = 'tmp-iterations-preview-exec';

const step = (
  iteration: number,
  type: IAgentStep['type'],
  content: string,
  extra: { toolName?: string } = {}
): IterationStep => ({
  iteration,
  isComplete: true,
  receivedAt: NOW + iteration,
  step: { type, content, metadata: { timestamp: NOW + iteration, iteration, ...extra } },
});

const ITERATIONS: IterationStep[] = [
  step(0, 'thought', 'Work out a plan for answering the question.'),
  step(0, 'action', 'Using tool: web_search', { toolName: 'web_search' }),
  step(0, 'observation', 'Found several relevant results about the topic.'),
  step(1, 'thought', 'The second result looks promising - read the document.'),
  step(1, 'action', 'Using tool: retrieve_knowledge_content', { toolName: 'retrieve_knowledge_content' }),
  step(
    1,
    'observation',
    'Retrieved content from 1 of 1 document(s):\n\n### Operations Agenda Week of April 15, 2026.docx\nTags: none\nChunks: 2 | Characters: 8000 (truncated from 30634)\n---\nBody line one\nBody line two\nBody line three\nBody line four\nBody line five\nBody line six\nBody line seven (hidden behind Show full result)'
  ),
  step(2, 'thought', 'I have enough to answer now.'),
  step(2, 'action', 'Using tool: web_search', { toolName: 'web_search' }),
  step(2, 'observation', 'Confirmed the figures across two sources.'),
];

const makeExecution = (status: ParentExecution['status']): ParentExecution => ({
  executionId: MOCK_ID,
  sessionId: 'tmp-session',
  status,
  totalCreditsUsed: 42,
  childExecutions: {},
  startedAt: NOW - 95_000,
  lastEventAt: NOW,
  lastKnownIteration: 2,
  iterations: ITERATIONS,
  answer: status === 'completed' ? 'Here is the final synthesized answer to the question.' : undefined,
});

export default function TmpIterationsPreviewPage() {
  const [status, setStatus] = useState<ParentExecution['status']>('completed');

  useEffect(() => {
    useAgentExecutionStore.setState(s => ({ executions: { ...s.executions, [MOCK_ID]: makeExecution(status) } }));
    return () => {
      useAgentExecutionStore.setState(s => {
        const next = { ...s.executions };
        delete next[MOCK_ID];
        return { executions: next };
      });
    };
  }, [status]);

  return (
    <Box sx={{ maxWidth: 820, mx: 'auto', p: 3 }}>
      <Typography level="h4" sx={{ mb: 0.5 }}>
        TEMP - Multi-iteration preview
      </Typography>
      <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 2 }}>
        Real IterationStream, seeded 3-iteration run. Toggle status to compare.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
        {(['completed', 'running', 'awaiting_permission'] as const).map(s => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? 'solid' : 'outlined'}
            color="neutral"
            onClick={() => setStatus(s)}
          >
            {s}
          </Button>
        ))}
      </Box>
      <IterationStream executionId={MOCK_ID} />
    </Box>
  );
}
