import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { QuestNode } from '@client/app/hooks/data/questGraphs';

const runMutate = vi.fn();
const addMutate = vi.fn();
let nodes: QuestNode[] = [];
let currentModel = 'claude-opus-5';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), get: vi.fn() } }));
// The real renderer drags in the whole artifact handler registry (mermaid, react
// sandbox, chess...). This suite is about WHETHER v5 routes artifacts to it.
vi.mock('@client/app/components/Session/artifacts/ArtifactRenderer', () => ({
  default: ({ artifact }: { artifact: { type: string; identifier?: string } }) => (
    <div data-testid="artifact-renderer-stub">{`${artifact.type}:${artifact.identifier ?? ''}`}</div>
  ),
}));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (s: { model: string }) => unknown) => selector({ model: currentModel }),
}));
vi.mock('@client/app/hooks/data/questGraphs', () => ({
  useQuestGraphs: () => ({ data: { graphs: [{ id: 'g1', goal: 'Ship it' }] } }),
  useQuestGraph: () => ({ data: { graph: { id: 'g1', goal: 'Ship it' }, nodes } }),
  useCreateQuestGraph: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddQuestNode: () => ({ mutateAsync: addMutate, isPending: false }),
  useRunQuestNode: () => ({ mutateAsync: runMutate, isPending: false }),
}));

const { default: QuestGraphView } = await import('./QuestGraphView');

const appTheme = extendTheme({ ...getThemeConfig() });
const renderView = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <QuestGraphView />
    </CssVarsProvider>
  );

const makeNode = (over: Partial<QuestNode> & { id: string }): QuestNode =>
  ({
    graphId: 'g1',
    parentId: null,
    dependsOn: [],
    order: 0,
    depth: 0,
    kind: 'task',
    title: 'A node',
    task: 'Do the thing',
    status: 'pending',
    enabledTools: [],
    artifactIds: [],
    isReady: true,
    isRunnable: true,
    artifacts: [],
    run: null,
    ...over,
  }) as QuestNode;

const selectGraph = () => fireEvent.click(screen.getAllByTestId('questmaster-v5-graph-btn')[0]);

describe('QuestGraphView', () => {
  beforeEach(() => {
    runMutate.mockReset().mockResolvedValue({ executionId: 'exec-1' });
    addMutate.mockReset().mockResolvedValue({ node: makeNode({ id: 'n2' }) });
    currentModel = 'claude-opus-5';
    nodes = [];
  });

  it('renders the graph list', () => {
    renderView();
    expect(screen.getByTestId('questmaster-v5-view')).toBeInTheDocument();
    expect(screen.getByTestId('questmaster-v5-graph-btn')).toHaveTextContent('Ship it');
  });

  it('runs a ready node with the currently selected model', async () => {
    nodes = [makeNode({ id: 'n1', isReady: true })];
    renderView();
    selectGraph();

    fireEvent.click(screen.getByTestId('questmaster-v5-run-node-btn'));

    expect(runMutate).toHaveBeenCalledWith({ nodeId: 'n1', model: 'claude-opus-5' });
  });

  // Dependency gating is enforced server-side too; this keeps the UI from
  // inviting a request that is guaranteed to 400 and cost a round trip.
  it('disables Run for a node whose dependencies are unmet', () => {
    nodes = [makeNode({ id: 'n1', isReady: false, isRunnable: false, dependsOn: ['n0'] })];
    renderView();
    selectGraph();

    expect(screen.getByTestId('questmaster-v5-run-node-btn')).toBeDisabled();
  });

  it('disables Run while the node is already in flight', () => {
    nodes = [makeNode({ id: 'n1', isReady: true, status: 'in_progress' })];
    renderView();
    selectGraph();

    expect(screen.getByTestId('questmaster-v5-run-node-btn')).toBeDisabled();
  });

  it('explains itself instead of dispatching when no model is selected', async () => {
    currentModel = '';
    nodes = [makeNode({ id: 'n1', isReady: true })];
    renderView();
    selectGraph();

    fireEvent.click(screen.getByTestId('questmaster-v5-run-node-btn'));

    expect(runMutate).not.toHaveBeenCalled();
    expect(await screen.findByTestId('questmaster-v5-error')).toHaveTextContent('Pick a model first');
  });

  // A failed node is retryable server-side (claimForRun accepts it), so the
  // button must not be gated on isReady, which excludes failed by design.
  it('still offers Run on a failed node so it can be retried', () => {
    nodes = [makeNode({ id: 'n1', status: 'failed', isReady: false, isRunnable: true })];
    renderView();
    selectGraph();

    expect(screen.getByTestId('questmaster-v5-run-node-btn')).not.toBeDisabled();
  });

  it('shows the run answer for a completed node', () => {
    nodes = [
      makeNode({
        id: 'n1',
        status: 'completed',
        run: {
          executionId: 'exec-1',
          status: 'completed',
          answer: 'The logs show 42 errors.',
          answerTruncated: false,
          totalIterations: 3,
          totalCreditsUsed: 12.5,
          errorMessage: null,
        },
      }),
    ];
    renderView();
    selectGraph();
    fireEvent.click(screen.getByTestId('questmaster-v5-node-row'));

    expect(screen.getByTestId('questmaster-v5-answer')).toHaveTextContent('The logs show 42 errors.');
    expect(screen.getByTestId('questmaster-v5-node-status-chip')).toHaveTextContent('completed');
  });

  it('says so when the displayed answer is a prefix', () => {
    nodes = [
      makeNode({
        id: 'n1',
        status: 'completed',
        run: {
          executionId: 'exec-1',
          status: 'completed',
          answer: 'a very long answer',
          answerTruncated: true,
          totalIterations: 1,
          totalCreditsUsed: 1,
          errorMessage: null,
        },
      }),
    ];
    renderView();
    selectGraph();
    fireEvent.click(screen.getByTestId('questmaster-v5-node-row'));

    expect(screen.getByTestId('questmaster-v5-answer-truncated')).toBeInTheDocument();
  });

  it('selects a node from the keyboard', () => {
    nodes = [makeNode({ id: 'n1', status: 'completed' })];
    renderView();
    selectGraph();

    fireEvent.keyDown(screen.getByTestId('questmaster-v5-node-row'), { key: 'Enter' });

    expect(screen.getByTestId('questmaster-v5-result-panel')).toBeInTheDocument();
  });

  it('renders artifact chips produced by the node', () => {
    nodes = [
      makeNode({
        id: 'n1',
        status: 'completed',
        artifactIds: ['art-1'],
        artifacts: [{ id: 'art-1', type: 'react', title: 'Counter' }],
        run: {
          executionId: 'exec-1',
          status: 'completed',
          answer: 'done',
          answerTruncated: false,
          totalIterations: 1,
          totalCreditsUsed: 1,
          errorMessage: null,
        },
      }),
    ];
    renderView();
    selectGraph();
    fireEvent.click(screen.getByTestId('questmaster-v5-node-row'));

    expect(screen.getByTestId('questmaster-v5-node-artifacts')).toBeInTheDocument();
    expect(screen.getByTestId('questmaster-v5-artifact-chip')).toHaveTextContent('Counter');
  });

  it('shows no artifact section for a node that produced none', () => {
    nodes = [makeNode({ id: 'n1', status: 'completed', artifacts: [] })];
    renderView();
    selectGraph();
    fireEvent.click(screen.getByTestId('questmaster-v5-node-row'));

    expect(screen.queryByTestId('questmaster-v5-node-artifacts')).not.toBeInTheDocument();
  });

  // The gap this fixes: v5 was the one surface showing an artifact as raw
  // source, while the notebook next door rendered the same reply properly.
  it('renders an artifact in the reply instead of dumping its source', () => {
    const reply = [
      'Here is the plan.',
      '',
      '<artifact identifier="world-plan" type="application/vnd.ant.mermaid" title="Plan">',
      'flowchart TD',
      '  A --> B',
      '</artifact>',
    ].join('\n');
    nodes = [
      makeNode({
        id: 'n1',
        status: 'completed',
        run: {
          executionId: 'exec-1',
          status: 'completed',
          answer: reply,
          answerTruncated: false,
          totalIterations: 1,
          totalCreditsUsed: 1,
          errorMessage: null,
        },
      }),
    ];
    renderView();
    selectGraph();
    fireEvent.click(screen.getByTestId('questmaster-v5-node-row'));

    expect(screen.getByTestId('questmaster-v5-rendered-artifacts')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-renderer-stub')).toHaveTextContent('mermaid');
    // The prose survives; the artifact body does not leak into it.
    expect(screen.getByTestId('questmaster-v5-answer')).toHaveTextContent('Here is the plan.');
    expect(screen.getByTestId('questmaster-v5-answer')).not.toHaveTextContent('flowchart TD');
  });

  it('renders a plain reply as prose with no artifact section', () => {
    nodes = [
      makeNode({
        id: 'n1',
        status: 'completed',
        run: {
          executionId: 'exec-1',
          status: 'completed',
          answer: 'Just words, nothing to render.',
          answerTruncated: false,
          totalIterations: 1,
          totalCreditsUsed: 1,
          errorMessage: null,
        },
      }),
    ];
    renderView();
    selectGraph();
    fireEvent.click(screen.getByTestId('questmaster-v5-node-row'));

    expect(screen.getByTestId('questmaster-v5-answer')).toHaveTextContent('Just words');
    expect(screen.queryByTestId('questmaster-v5-rendered-artifacts')).not.toBeInTheDocument();
  });

  it('surfaces a failed run error message', () => {
    nodes = [
      makeNode({
        id: 'n1',
        status: 'failed',
        run: {
          executionId: 'exec-1',
          status: 'failed',
          answer: null,
          answerTruncated: false,
          totalIterations: null,
          totalCreditsUsed: null,
          errorMessage: 'model refused',
        },
      }),
    ];
    renderView();
    selectGraph();
    fireEvent.click(screen.getByTestId('questmaster-v5-node-row'));

    expect(screen.getByTestId('questmaster-v5-run-error')).toHaveTextContent('model refused');
  });
});
