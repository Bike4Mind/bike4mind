import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Alert, Box, Button, Chip, Divider, Input, Sheet, Stack, Textarea, Typography } from '@mui/joy';
import type { ColorPaletteProp } from '@mui/joy';
import { api } from '@client/app/contexts/ApiContext';
import { useLLM } from '@client/app/contexts/LLMContext';
import { parseArtifactsWithFallback } from '@client/app/utils/artifactParser';
import ArtifactRenderer from '@client/app/components/Session/artifacts/ArtifactRenderer';
import {
  useAddQuestNode,
  useCreateQuestGraph,
  useQuestGraph,
  useQuestGraphs,
  useRunQuestNode,
  type QuestNode,
} from '@client/app/hooks/data/questGraphs';

/**
 * Phase 1 graph view: enough surface to author a small graph by hand, run a
 * single node through the agent executor, and read what came back. It is
 * deliberately a flat indented list rather than a canvas - the node model is
 * still moving, and Phase 5 replaces this with the real graph UI once the
 * scheduler and scoring have settled.
 */

const STATUS_COLORS: Record<QuestNode['status'], ColorPaletteProp> = {
  pending: 'neutral',
  ready: 'primary',
  in_progress: 'warning',
  blocked: 'neutral',
  needs_review: 'warning',
  completed: 'success',
  skipped: 'neutral',
  failed: 'danger',
};

export default function QuestGraphView() {
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [goalDraft, setGoalDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const model = useLLM(s => s.model);
  const graphs = useQuestGraphs(true);
  const detail = useQuestGraph(selectedGraphId);
  const createGraph = useCreateQuestGraph();
  const runNode = useRunQuestNode(selectedGraphId);

  const nodes = detail.data?.nodes ?? [];
  const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);

  const handleCreateGraph = async () => {
    const goal = goalDraft.trim();
    if (!goal) return;
    setError(null);
    setCreating(true);
    try {
      // Each quest gets its own session: node runs dispatch real agent
      // executions, and a session is what gives those runs a chat-history home.
      const { data: session } = await api.post<{ id: string }>('/api/sessions/create', { name: goal.slice(0, 120) });
      const { graph } = await createGraph.mutateAsync({ goal, sessionId: session.id });
      setGoalDraft('');
      setSelectedGraphId(graph.id);
      setSelectedNodeId(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not create quest'));
    } finally {
      setCreating(false);
    }
  };

  const handleRun = async (nodeId: string) => {
    setError(null);
    if (!model) {
      setError('Pick a model first - node runs use your currently selected model.');
      return;
    }
    try {
      await runNode.mutateAsync({ nodeId, model });
      setSelectedNodeId(nodeId);
    } catch (err) {
      setError(errorMessage(err, 'Could not start the node'));
    }
  };

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }} data-testid="questmaster-v5-view">
      <Sheet
        variant="soft"
        sx={{ width: 280, flexShrink: 0, p: 2, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        <Typography level="title-sm">Quests</Typography>
        <Stack direction="row" spacing={1}>
          <Input
            size="sm"
            placeholder="Goal..."
            value={goalDraft}
            onChange={e => setGoalDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreateGraph();
            }}
            data-testid="questmaster-v5-goal-input"
            sx={{ flex: 1 }}
          />
          <Button
            size="sm"
            loading={creating}
            disabled={!goalDraft.trim()}
            onClick={handleCreateGraph}
            data-testid="questmaster-v5-create-graph-btn"
          >
            New
          </Button>
        </Stack>
        <Divider />
        {(graphs.data?.graphs ?? []).map(graph => (
          <Button
            key={graph.id}
            size="sm"
            variant={graph.id === selectedGraphId ? 'solid' : 'plain'}
            onClick={() => {
              setSelectedGraphId(graph.id);
              setSelectedNodeId(null);
            }}
            data-testid="questmaster-v5-graph-btn"
            sx={{ justifyContent: 'flex-start', textAlign: 'left' }}
          >
            {graph.goal}
          </Button>
        ))}
      </Sheet>

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {error && (
          <Alert color="danger" size="sm" sx={{ m: 2 }} data-testid="questmaster-v5-error">
            {error}
          </Alert>
        )}

        {!selectedGraphId && (
          <Box sx={{ p: 4 }}>
            <Typography level="body-sm">Create or select a quest to author its nodes.</Typography>
          </Box>
        )}

        {selectedGraphId && (
          <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
            <Typography level="title-md" sx={{ mb: 1 }}>
              {detail.data?.graph.goal}
            </Typography>

            <Stack spacing={1} data-testid="questmaster-v5-node-list">
              {nodes.map(node => (
                <Sheet
                  key={node.id}
                  variant={node.id === selectedNodeId ? 'solid' : 'outlined'}
                  color={node.id === selectedNodeId ? 'primary' : 'neutral'}
                  onClick={() => setSelectedNodeId(node.id)}
                  // A Sheet is a div: without these the row is unreachable by
                  // keyboard, and selecting a node is the only way to read its
                  // result.
                  role="button"
                  tabIndex={0}
                  aria-pressed={node.id === selectedNodeId}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedNodeId(node.id);
                    }
                  }}
                  data-testid="questmaster-v5-node-row"
                  sx={{ ml: node.depth * 3, p: 1.5, borderRadius: 'sm', cursor: 'pointer' }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Chip size="sm" variant="soft" data-testid="questmaster-v5-node-kind-chip">
                      {node.kind}
                    </Chip>
                    <Typography level="body-sm" sx={{ flex: 1, minWidth: 0 }}>
                      {node.title}
                    </Typography>
                    <Chip
                      size="sm"
                      color={STATUS_COLORS[node.status]}
                      variant="soft"
                      data-testid="questmaster-v5-node-status-chip"
                    >
                      {node.status}
                    </Chip>
                    <Button
                      size="sm"
                      variant="outlined"
                      // `isRunnable`, not `isReady`: readiness is the scheduler's
                      // predicate and excludes `failed`, but a failed node IS
                      // retryable by hand - gating Run on readiness left it with
                      // no way back.
                      disabled={!node.isRunnable || node.status === 'in_progress' || runNode.isPending}
                      onClick={e => {
                        e.stopPropagation();
                        handleRun(node.id);
                      }}
                      data-testid="questmaster-v5-run-node-btn"
                    >
                      Run
                    </Button>
                  </Stack>
                </Sheet>
              ))}
              {!nodes.length && <Typography level="body-sm">No nodes yet. Add the first one below.</Typography>}
            </Stack>

            {/* Keyed by graph: without it React keeps this subtree mounted
                across a graph switch, and the draft's selected `dependsOn`
                chips would still hold node ids from the previous graph. */}
            <AddNodeForm key={selectedGraphId} graphId={selectedGraphId} nodes={nodes} onError={setError} />

            {selectedNode && <NodeResultPanel node={selectedNode} sessionId={detail.data?.graph.sessionId} />}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function AddNodeForm({
  graphId,
  nodes,
  onError,
}: {
  graphId: string;
  nodes: QuestNode[];
  onError: (message: string | null) => void;
}) {
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const addNode = useAddQuestNode(graphId);

  const submit = async () => {
    onError(null);
    try {
      await addNode.mutateAsync({
        title: title.trim(),
        task: task.trim(),
        acceptanceCriteria: acceptanceCriteria.trim() || undefined,
        dependsOn: dependsOn.length ? dependsOn : undefined,
      });
      setTitle('');
      setTask('');
      setAcceptanceCriteria('');
      setDependsOn([]);
    } catch (err) {
      onError(errorMessage(err, 'Could not add the node'));
    }
  };

  return (
    <Sheet variant="outlined" sx={{ mt: 2, p: 2, borderRadius: 'sm' }} data-testid="questmaster-v5-add-node-form">
      <Typography level="title-sm" sx={{ mb: 1 }}>
        Add node
      </Typography>
      <Stack spacing={1}>
        <Input
          size="sm"
          placeholder="Title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          data-testid="questmaster-v5-node-title-input"
        />
        <Textarea
          size="sm"
          minRows={2}
          placeholder="Task - what this node must do"
          value={task}
          onChange={e => setTask(e.target.value)}
          data-testid="questmaster-v5-node-task-input"
        />
        <Textarea
          size="sm"
          minRows={1}
          placeholder="Acceptance criteria (optional)"
          value={acceptanceCriteria}
          onChange={e => setAcceptanceCriteria(e.target.value)}
          data-testid="questmaster-v5-node-criteria-input"
        />
        {nodes.length > 0 && (
          <Box>
            <Typography level="body-xs" sx={{ mb: 0.5 }}>
              Depends on
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {nodes.map(n => (
                <Chip
                  key={n.id}
                  size="sm"
                  variant={dependsOn.includes(n.id) ? 'solid' : 'outlined'}
                  onClick={() =>
                    setDependsOn(prev => (prev.includes(n.id) ? prev.filter(id => id !== n.id) : [...prev, n.id]))
                  }
                  data-testid="questmaster-v5-dependency-chip"
                >
                  {n.title}
                </Chip>
              ))}
            </Stack>
          </Box>
        )}
        <Button
          size="sm"
          loading={addNode.isPending}
          disabled={!title.trim() || !task.trim()}
          onClick={submit}
          data-testid="questmaster-v5-add-node-btn"
        >
          Add
        </Button>
      </Stack>
    </Sheet>
  );
}

function NodeResultPanel({ node, sessionId }: { node: QuestNode; sessionId?: string }) {
  const navigate = useNavigate();
  return (
    <Sheet variant="soft" sx={{ mt: 2, p: 2, borderRadius: 'sm' }} data-testid="questmaster-v5-result-panel">
      <Typography level="title-sm">{node.title}</Typography>
      <Typography level="body-xs" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
        {node.task}
      </Typography>

      {node.run && (
        <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
          <Chip size="sm" variant="soft" data-testid="questmaster-v5-run-status-chip">
            run: {node.run.status}
          </Chip>
          {node.run.totalIterations !== null && (
            <Chip size="sm" variant="soft">
              {node.run.totalIterations} iterations
            </Chip>
          )}
          {node.run.totalCreditsUsed !== null && (
            <Chip size="sm" variant="soft">
              {node.run.totalCreditsUsed.toFixed(2)} credits
            </Chip>
          )}
        </Stack>
      )}

      {node.run?.errorMessage && (
        <Alert color="danger" size="sm" sx={{ mt: 1 }} data-testid="questmaster-v5-run-error">
          {node.run.errorMessage}
        </Alert>
      )}

      {node.artifacts.length > 0 && (
        <Box sx={{ mt: 1.5 }} data-testid="questmaster-v5-node-artifacts">
          <Typography level="body-xs" sx={{ mb: 0.5 }}>
            Artifacts from this node
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {node.artifacts.map(artifact => (
              <Chip
                key={artifact.id}
                size="sm"
                variant="outlined"
                // The notebook, not the artifact: there is no /artifacts/:id
                // route - artifacts render inline in chat via ArtifactRenderer.
                // Phase 5's graph view is where per-node inspection belongs;
                // until then this at least lands you where the artifact is.
                {...(sessionId ? { onClick: () => navigate({ to: '/notebooks/$id', params: { id: sessionId } }) } : {})}
                sx={sessionId ? { cursor: 'pointer' } : undefined}
                data-testid="questmaster-v5-artifact-chip"
              >
                {artifact.type}: {artifact.title}
              </Chip>
            ))}
          </Stack>
        </Box>
      )}

      {node.run?.answer && <NodeAnswer node={node} sessionId={sessionId} />}

      {!node.run && (
        <Typography level="body-xs" sx={{ mt: 1 }}>
          Not run yet.
        </Typography>
      )}
    </Sheet>
  );
}

/**
 * The run's reply, with any artifacts rendered rather than dumped as text.
 *
 * v5 was the one surface in the app that showed an artifact as raw source: a
 * mermaid diagram arrived as a fenced block of mermaid syntax while the notebook
 * next door rendered the same reply properly. It parses with the same
 * `parseArtifactsWithFallback` the chat path uses and hands each artifact to the
 * same `ArtifactRenderer`, so every type the app already knows how to draw is
 * free here.
 *
 * `sessionId` matters more than it looks: the resolver tries
 * `findExistingArtifactId(type, identifier, sessionId)` first, so a run whose
 * artifacts were already persisted server-side adopts those rows instead of
 * minting a second id for the same content.
 */
function NodeAnswer({ node, sessionId }: { node: QuestNode; sessionId?: string }) {
  const answer = node.run?.answer ?? '';
  // Parsing is pure and cheap, but this re-renders on every poll tick.
  const { artifacts, prose } = useMemo(() => {
    try {
      const parsed = parseArtifactsWithFallback(answer);
      return { artifacts: parsed.artifacts, prose: parsed.cleanedContent ?? answer };
    } catch {
      // A malformed reply must still be readable, so fall back to raw text.
      return { artifacts: [], prose: answer };
    }
  }, [answer]);

  return (
    <Box sx={{ mt: 1 }} data-testid="questmaster-v5-answer">
      {prose.trim() && (
        <Box sx={{ p: 1.5, borderRadius: 'sm', bgcolor: 'background.surface', whiteSpace: 'pre-wrap' }}>
          <Typography level="body-sm">{prose.trim()}</Typography>
        </Box>
      )}

      {artifacts.length > 0 && (
        <Stack spacing={2} sx={{ mt: 1.5 }} data-testid="questmaster-v5-rendered-artifacts">
          {artifacts.map((artifact, index) => (
            <ArtifactRenderer
              key={`${artifact.type}_${artifact.identifier}_${index}`}
              artifact={artifact}
              index={index}
              // Only a fallback for minting an id when nothing is persisted yet;
              // the executionId is stable per run, unlike a chat message id.
              messageId={node.run?.executionId ?? node.id}
              sessionId={sessionId}
            />
          ))}
        </Stack>
      )}

      {node.run?.answerTruncated && (
        <Typography level="body-xs" sx={{ mt: 1 }} data-testid="questmaster-v5-answer-truncated">
          Answer truncated for display. Open the run in the notebook for the full reply.
        </Typography>
      )}
    </Box>
  );
}

/** Surface the API's message when there is one; axios errors bury it in the response body. */
function errorMessage(err: unknown, fallback: string): string {
  const responseMessage = (err as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
  return responseMessage?.message || responseMessage?.error || fallback;
}
