import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { QuestNode } from '@client/app/hooks/data/questGraphs';

const runMutate = vi.fn();
const addMutate = vi.fn();
let nodes: QuestNode[] = [];
let currentModel = 'claude-opus-5';
let nodeAnswer: string | null = null;

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), get: vi.fn() } }));
// The real renderer drags in the whole artifact handler registry (mermaid, react
// sandbox, chess...). This suite is about WHETHER v5 routes artifacts to it.
vi.mock('@client/app/components/Session/artifacts/ArtifactRenderer', () => ({
  default: ({ artifact }: { artifact: { type: string; identifier?: string } }) => {
    // Stands in for a per-type handler blowing up on model-generated content.
    if (artifact.identifier === 'boom') throw new Error('handler exploded');
    return <div data-testid="artifact-renderer-stub">{`${artifact.type}:${artifact.identifier ?? ''}`}</div>;
  },
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
  // The reply is fetched on demand now, not carried in the graph payload.
  useQuestNodeAnswer: () => ({ data: { answer: nodeAnswer }, isLoading: false, isError: false }),
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
    nodeAnswer = null;
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
    nodeAnswer = 'The logs show 42 errors.';
    nodes = [
      makeNode({
        id: 'n1',
        status: 'completed',
        run: {
          executionId: 'exec-1',
          status: 'completed',
          hasAnswer: true,
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
          hasAnswer: true,
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
          hasAnswer: true,
          totalIterations: 1,
          totalCreditsUsed: 1,
          errorMessage: null,
        },
      }),
    ];
    nodeAnswer = reply;
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
          hasAnswer: true,
          totalIterations: 1,
          totalCreditsUsed: 1,
          errorMessage: null,
        },
      }),
    ];
    nodeAnswer = 'Just words, nothing to render.';
    renderView();
    selectGraph();
    fireEvent.click(screen.getByTestId('questmaster-v5-node-row'));

    expect(screen.getByTestId('questmaster-v5-answer')).toHaveTextContent('Just words');
    expect(screen.queryByTestId('questmaster-v5-rendered-artifacts')).not.toBeInTheDocument();
  });

  // Rendering runs per-type handlers over model-generated content. A throw
  // there is a React render error no try/catch can catch, so without a boundary
  // one malformed artifact takes down the whole node panel.
  it('contains a handler that throws instead of losing the panel', () => {
    const reply = [
      'Prose survives.',
      '<artifact identifier="boom" type="application/vnd.ant.mermaid" title="Bad">x</artifact>',
      '<artifact identifier="fine" type="application/vnd.ant.mermaid" title="Good">y</artifact>',
    ].join('\n');
    nodes = [
      makeNode({
        id: 'n1',
        status: 'completed',
        run: {
          executionId: 'exec-1',
          status: 'completed',
          hasAnswer: true,
          totalIterations: 1,
          totalCreditsUsed: 1,
          errorMessage: null,
        },
      }),
    ];
    // React logs the caught error; keep the suite output readable.
    nodeAnswer = reply;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderView();
    selectGraph();
    fireEvent.click(screen.getByTestId('questmaster-v5-node-row'));

    // The panel is still standing, the good artifact still rendered, and the
    // bad one degraded to a message rather than taking everything with it.
    expect(screen.getByTestId('questmaster-v5-result-panel')).toBeInTheDocument();
    expect(screen.getByTestId('questmaster-v5-artifact-render-error')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-renderer-stub')).toHaveTextContent('fine');
    spy.mockRestore();
  });

  // The bug this replaced: the graph payload capped each answer at 20k chars,
  // which sliced a long reply mid-<artifact>. The closing tag was lost, the
  // parser found nothing well-formed, and the panel dumped source instead of
  // rendering - the failure mode seen on staging with a large React artifact.
  it('renders an artifact far larger than the old 20k cap', () => {
    const body = 'const x = 1;\n'.repeat(4000); // ~52k chars, well past the old cap
    const reply = `Here it is.\n<artifact identifier="big" type="application/vnd.ant.react" title="Big">${body}</artifact>`;
    nodes = [
      makeNode({
        id: 'n1',
        status: 'completed',
        run: {
          executionId: 'exec-1',
          status: 'completed',
          hasAnswer: true,
          totalIterations: 1,
          totalCreditsUsed: 1,
          errorMessage: null,
        },
      }),
    ];
    nodeAnswer = reply;
    expect(reply.length).toBeGreaterThan(20_000);

    renderView();
    selectGraph();
    fireEvent.click(screen.getByTestId('questmaster-v5-node-row'));

    // Rendered as an artifact, not dumped as source.
    expect(screen.getByTestId('artifact-renderer-stub')).toHaveTextContent('big');
    expect(screen.getByTestId('questmaster-v5-answer')).not.toHaveTextContent('const x = 1;');
  });

  it('surfaces a failed run error message', () => {
    nodes = [
      makeNode({
        id: 'n1',
        status: 'failed',
        run: {
          executionId: 'exec-1',
          status: 'failed',
          hasAnswer: false,
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
