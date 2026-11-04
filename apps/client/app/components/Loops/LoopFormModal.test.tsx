import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { createLoop, updateLoop } = vi.hoisted(() => ({
  createLoop: { mutate: vi.fn(), isPending: false },
  updateLoop: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@client/app/hooks/data/loops', () => ({
  useCreateLoop: () => createLoop,
  useUpdateLoop: () => updateLoop,
  useLoops: () => ({
    data: [
      { id: 'l1', name: 'Digest' },
      { id: 'l2', name: 'Closer' },
    ],
    isSuccess: true,
  }),
}));
vi.mock('@client/app/hooks/data/mcpServers', () => ({
  useMcpServers: () => ({
    data: [
      { name: 'GitHub', enabled: true, tools: ['create_issue'] },
      { name: 'off', enabled: false, tools: ['hidden'] },
    ],
  }),
}));
vi.mock('@client/app/hooks/data/agents', () => ({ useGetAgents: () => ({ data: [{ id: 'a1', name: 'Alpha' }] }) }));
vi.mock('@client/app/components/Agent/OrchestrationSection', () => ({
  PICKABLE_TOOLS: ['web_search', 'weather_info'],
}));
vi.mock('@client/app/hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({ accessibleTextModels: [{ id: 'm2', name: 'Model Two' }] }),
}));
const config = vi.hoisted(() => ({ toolAvailability: undefined as Record<string, boolean> | undefined }));
vi.mock('@client/app/hooks/data/settings', () => ({ useConfig: () => ({ data: config }) }));

import LoopFormModal, { validateLoopForm, type LoopFormValues } from './LoopFormModal';

const appTheme = extendTheme({ ...getThemeConfig() });

const values = (overrides: Partial<LoopFormValues> = {}): LoopFormValues => ({
  name: 'Digest',
  goal: 'Summarize',
  interval: '30',
  intervalUnit: 'minutes',
  tools: [],
  stages: ['todo', 'doing', 'done'],
  agentId: '',
  oversees: [],
  budget: '',
  stageConfig: {},
  ...overrides,
});

describe('validateLoopForm', () => {
  it('requires name and goal', () => {
    const { errors, payload } = validateLoopForm(values({ name: ' ', goal: '' }), 'create');
    expect(errors.name).toBeDefined();
    expect(errors.goal).toBeDefined();
    expect(payload).toBeUndefined();
  });

  it.each([['4'], ['7.5'], [''], ['10081']])('rejects an interval of %s minutes', interval => {
    expect(validateLoopForm(values({ interval }), 'create').errors.interval).toBeDefined();
  });

  it('converts hours and days to minutes', () => {
    expect(validateLoopForm(values({ interval: '2', intervalUnit: 'hours' }), 'create').payload?.intervalMinutes).toBe(
      120
    );
    expect(validateLoopForm(values({ interval: '7', intervalUnit: 'days' }), 'create').payload?.intervalMinutes).toBe(
      10_080
    );
    expect(validateLoopForm(values({ interval: '8', intervalUnit: 'days' }), 'create').errors.interval).toBeDefined();
  });

  it.each([
    ['duplicate', ['todo', 'todo', 'done']],
    ['empty', ['todo', ' ', 'done']],
    ['too few', ['done']],
    ['too long', ['todo', 'x'.repeat(61)]],
  ])('rejects %s stages', (_, stages) => {
    expect(validateLoopForm(values({ stages }), 'create').errors.stages).toBeDefined();
  });

  it('omits no agent on create and clears it with null on edit', () => {
    expect(validateLoopForm(values(), 'create').payload).not.toHaveProperty('agentId');
    expect(validateLoopForm(values(), 'edit').payload?.agentId).toBeNull();
    expect(validateLoopForm(values({ agentId: 'a1' }), 'create').payload?.agentId).toBe('a1');
  });

  it('omits an empty oversees on create, clears it with null on edit, and caps it at 5', () => {
    expect(validateLoopForm(values(), 'create').payload).not.toHaveProperty('oversees');
    expect(validateLoopForm(values(), 'edit').payload?.oversees).toBeNull();
    expect(validateLoopForm(values({ oversees: ['l2'] }), 'create').payload?.oversees).toEqual(['l2']);
    expect(
      validateLoopForm(values({ oversees: ['1', '2', '3', '4', '5', '6'] }), 'edit').errors.oversees
    ).toBeDefined();
  });

  it.each([['0'], ['-1'], ['abc']])('rejects a budget of %s', budget => {
    expect(validateLoopForm(values({ budget }), 'create').errors.budget).toBeDefined();
  });

  it('omits no budget on create, clears it with null on edit, and sends a positive one', () => {
    expect(validateLoopForm(values(), 'create').payload).not.toHaveProperty('budgetCreditsPerDay');
    expect(validateLoopForm(values(), 'edit').payload?.budgetCreditsPerDay).toBeNull();
    expect(validateLoopForm(values({ budget: '2.5' }), 'create').payload?.budgetCreditsPerDay).toBe(2.5);
  });
});

describe('validateLoopForm stageConfig', () => {
  it('sends set fields of non-last stages only, and clears with null on edit', () => {
    const { payload } = validateLoopForm(
      values({
        stages: ['todo', 'doing', 'done'],
        stageConfig: {
          todo: { model: 'm2', tools: [], instructions: '  ' },
          doing: { runner: 'desktop', instructions: ' Review only ' },
          done: { model: 'm3' },
          removed: { model: 'm4' },
        },
      }),
      'create'
    );
    expect(payload?.stageConfig).toEqual([
      { stage: 'todo', model: 'm2' },
      { stage: 'doing', runner: 'desktop', instructions: 'Review only' },
    ]);
    expect(validateLoopForm(values(), 'create').payload).not.toHaveProperty('stageConfig');
    expect(validateLoopForm(values(), 'edit').payload?.stageConfig).toBeNull();
  });

  it('sends the desktop guards only for a desktop stage', () => {
    const guards = {
      repoHint: ' acme/app ',
      mergePolicy: 'green-ci' as const,
      deployWorkflow: 'deploy.yml',
      smoke: 'https://app.example/health',
      holdLabels: 'hold, , do-not-merge',
    };
    const { payload } = validateLoopForm(
      values({
        stages: ['todo', 'doing', 'review', 'done'],
        stageConfig: {
          todo: { model: 'm2', ...guards },
          doing: { runner: 'desktop', ...guards },
          review: { runner: 'desktop', smoke: 'pnpm smoke' },
        },
      }),
      'create'
    );
    expect(payload?.stageConfig).toEqual([
      { stage: 'todo', model: 'm2' },
      {
        stage: 'doing',
        runner: 'desktop',
        repoHint: 'acme/app',
        mergePolicy: 'green-ci',
        deployWorkflow: 'deploy.yml',
        smoke: { url: 'https://app.example/health' },
        holdLabels: ['hold', 'do-not-merge'],
      },
      { stage: 'review', runner: 'desktop', smoke: { command: 'pnpm smoke' } },
    ]);
  });

  it('caps instructions at 4000 characters and tools at 50 per stage', () => {
    expect(
      validateLoopForm(values({ stageConfig: { todo: { instructions: 'x'.repeat(4001) } } }), 'create').errors
        .stageConfig
    ).toMatch(/4000/);
    const tools = Array.from({ length: 51 }, (_, i) => `t${i}`);
    expect(validateLoopForm(values({ stageConfig: { todo: { tools } } }), 'create').errors.stageConfig).toMatch(/50/);
  });
});

describe('LoopFormModal', () => {
  const renderForm = (loop?: Parameters<typeof LoopFormModal>[0]['loop']) =>
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopFormModal open onClose={vi.fn()} loop={loop} />
      </CssVarsProvider>
    );

  beforeEach(() => {
    vi.clearAllMocks();
    config.toolAvailability = undefined;
  });

  const openTools = () => fireEvent.click(screen.getByRole('combobox', { name: /tools/i }));

  it('lists every tool while availability is loading, and hides an unavailable one once it is known', () => {
    const { unmount } = renderForm();
    openTools();
    expect(screen.getByRole('option', { name: 'Web Search' })).toBeInTheDocument();
    unmount();

    config.toolAvailability = { web_search: false, weather_info: true };
    renderForm();
    openTools();
    expect(screen.queryByRole('option', { name: /Web Search/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Weather/ })).toBeInTheDocument();
    expect(screen.queryByTestId('loop-form-tools-unavailable-warning')).not.toBeInTheDocument();
  });

  it('keeps a saved unavailable tool selected and labelled, warns about it, and clears the warning once removed', () => {
    config.toolAvailability = { web_search: false };
    renderForm({
      id: 'l1',
      name: 'Digest',
      goal: 'Summarize',
      intervalMinutes: 30,
      tools: ['web_search'],
      stages: ['todo', 'done'],
    } as never);
    expect(screen.getByTestId('loop-form-tools-unavailable-warning')).toHaveTextContent(
      "Web Search isn't available on this server, so runs skip it."
    );
    openTools();
    const option = screen.getByRole('option', { name: 'Web Search (unavailable)' });
    expect(option).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(option);
    expect(screen.queryByTestId('loop-form-tools-unavailable-warning')).not.toBeInTheDocument();
  });

  it('shows inline errors and submits nothing when invalid', () => {
    renderForm();
    fireEvent.click(screen.getByTestId('loop-form-submit-btn'));
    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(createLoop.mutate).not.toHaveBeenCalled();
  });

  it('creates with minutes, the default stages and an added stage', () => {
    renderForm();
    fireEvent.change(screen.getByTestId('loop-form-name-input'), { target: { value: 'Digest' } });
    fireEvent.change(screen.getByTestId('loop-form-goal-input'), { target: { value: 'Summarize' } });
    fireEvent.change(screen.getByTestId('loop-form-interval-input'), { target: { value: '45' } });
    fireEvent.change(screen.getByTestId('loop-form-stage-input'), { target: { value: 'review' } });
    fireEvent.click(screen.getByTestId('loop-form-stage-add-btn'));
    fireEvent.click(screen.getByTestId('loop-form-submit-btn'));
    expect(createLoop.mutate).toHaveBeenCalledWith(
      {
        name: 'Digest',
        goal: 'Summarize',
        intervalMinutes: 45,
        tools: [],
        stages: ['todo', 'doing', 'done', 'review'],
      },
      expect.anything()
    );
  });

  it('lists enabled MCP tools under the executor name <server>__<tool>', () => {
    renderForm();
    fireEvent.click(screen.getByRole('combobox', { name: /tools/i }));
    expect(screen.getByRole('option', { name: 'GitHub: create_issue' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'off: hidden' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'GitHub: create_issue' }));
    fireEvent.change(screen.getByTestId('loop-form-name-input'), { target: { value: 'Digest' } });
    fireEvent.change(screen.getByTestId('loop-form-goal-input'), { target: { value: 'Summarize' } });
    fireEvent.click(screen.getByTestId('loop-form-submit-btn'));
    expect(createLoop.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ['github__create_issue'] }),
      expect.anything()
    );
  });

  it('edits with the stored tools and warns when a stage is removed', () => {
    renderForm({
      id: 'l1',
      name: 'Digest',
      goal: 'Summarize',
      intervalMinutes: 120,
      tools: ['github__create_issue'],
      stages: ['todo', 'doing', 'done'],
      budgetCreditsPerDay: 50,
    } as never);
    expect(screen.getByTestId('loop-form-interval-input')).toHaveValue(2);
    expect(screen.getByTestId('loop-form-budget-input')).toHaveValue(50);
    fireEvent.change(screen.getByTestId('loop-form-budget-input'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('loop-form-stage-remove-1'));
    expect(screen.getByTestId('loop-form-stage-removed-warning')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('loop-form-submit-btn'));
    expect(updateLoop.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'l1',
        intervalMinutes: 120,
        tools: ['github__create_issue'],
        stages: ['todo', 'done'],
        agentId: null,
        budgetCreditsPerDay: null,
      }),
      expect.anything()
    );
  });

  it("sends the loops picked under Oversees, offering the owner's other loops only", () => {
    renderForm({
      id: 'l1',
      name: 'Digest',
      goal: 'Summarize',
      intervalMinutes: 30,
      tools: [],
      stages: ['todo', 'doing', 'done'],
    } as never);
    fireEvent.click(screen.getByRole('combobox', { name: /oversees/i }));
    expect(screen.queryByRole('option', { name: 'Digest' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Closer' }));
    fireEvent.click(screen.getByTestId('loop-form-submit-btn'));
    expect(updateLoop.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1', oversees: ['l2'] }),
      expect.anything()
    );
  });

  it('drops an oversees id whose loop was deleted, so the edit still saves', () => {
    renderForm({
      id: 'l1',
      name: 'Digest',
      goal: 'Summarize',
      intervalMinutes: 30,
      tools: [],
      stages: ['todo', 'doing', 'done'],
      oversees: ['gone', 'l2'],
    } as never);
    fireEvent.click(screen.getByTestId('loop-form-submit-btn'));
    expect(updateLoop.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1', oversees: ['l2'] }),
      expect.anything()
    );
  });
});

describe('LoopFormModal stage settings', () => {
  const renderForm = (loop?: Parameters<typeof LoopFormModal>[0]['loop']) =>
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopFormModal open onClose={vi.fn()} loop={loop} />
      </CssVarsProvider>
    );
  const pick = (testId: string, option: string) => {
    fireEvent.click(within(screen.getByTestId(testId)).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: option }));
  };
  const saved = {
    id: 'l1',
    name: 'Digest',
    goal: 'Summarize',
    intervalMinutes: 30,
    tools: [],
    stages: ['todo', 'review', 'done'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    config.toolAvailability = undefined;
  });

  it('is collapsed by default and has no panel for the last stage', () => {
    renderForm();
    const summary = within(screen.getByTestId('loop-form-stage-settings')).getByRole('button', {
      name: 'Stage settings',
    });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('loop-form-stage-panel-0')).toBeInTheDocument();
    expect(screen.getByTestId('loop-form-stage-panel-1')).toBeInTheDocument();
    expect(screen.queryByTestId('loop-form-stage-panel-2')).not.toBeInTheDocument();
  });

  it('hides an unavailable tool from the stage tools picker, keeping a saved one labelled', () => {
    config.toolAvailability = { web_search: false, weather_info: true };
    renderForm(saved as never);
    fireEvent.click(screen.getByTestId('loop-form-stage-settings-toggle'));
    fireEvent.click(within(screen.getByTestId('loop-form-stage-tools-0')).getByRole('combobox'));
    expect(screen.queryByRole('option', { name: /Web Search/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Weather/ })).toBeInTheDocument();
  });

  it('keeps a stage tool saved before it became unavailable, labelled', () => {
    config.toolAvailability = { web_search: false };
    renderForm({ ...saved, stageConfig: [{ stage: 'todo', tools: ['web_search'] }] } as never);
    fireEvent.click(screen.getByTestId('loop-form-stage-settings-toggle'));
    fireEvent.click(within(screen.getByTestId('loop-form-stage-tools-0')).getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Web Search (unavailable)' })).toHaveAttribute('aria-selected', 'true');
  });

  it("sends a stage's runner, model, tools and instructions", () => {
    renderForm(saved as never);
    fireEvent.click(screen.getByTestId('loop-form-stage-settings-toggle'));
    pick('loop-form-stage-runner-1', 'Desktop');
    expect(screen.getByText('Tickets in this stage wait for your Desktop app to pick them up.')).toBeInTheDocument();
    pick('loop-form-stage-model-1', 'Model Two');
    pick('loop-form-stage-tools-1', 'GitHub: create_issue');
    fireEvent.change(screen.getByTestId('loop-form-stage-instructions-1'), { target: { value: 'Review only' } });
    fireEvent.click(screen.getByTestId('loop-form-submit-btn'));
    expect(updateLoop.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        stageConfig: [
          {
            stage: 'review',
            runner: 'desktop',
            model: 'm2',
            tools: ['github__create_issue'],
            instructions: 'Review only',
          },
        ],
      }),
      expect.anything()
    );
  });

  it('shows the saved config and drops it when its stage is removed', () => {
    renderForm({
      ...saved,
      stageConfig: [{ stage: 'review', runner: 'desktop', instructions: 'Review only' }],
    } as never);
    fireEvent.click(screen.getByTestId('loop-form-stage-settings-toggle'));
    expect(screen.getByTestId('loop-form-stage-instructions-1')).toHaveValue('Review only');
    expect(within(screen.getByTestId('loop-form-stage-panel-1')).getByText('desktop')).toBeInTheDocument();
    expect(screen.getByTestId('loop-form-stage-repo-1')).toBeInTheDocument();
    expect(screen.queryByTestId('loop-form-stage-repo-0')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('loop-form-stage-remove-1'));
    fireEvent.click(screen.getByTestId('loop-form-submit-btn'));
    expect(updateLoop.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ stages: ['todo', 'done'], stageConfig: null }),
      expect.anything()
    );
  });
});
