import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { createLoop, updateLoop } = vi.hoisted(() => ({
  createLoop: { mutate: vi.fn(), isPending: false },
  updateLoop: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@client/app/hooks/data/loops', () => ({
  useCreateLoop: () => createLoop,
  useUpdateLoop: () => updateLoop,
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
vi.mock('@client/app/components/Agent/OrchestrationSection', () => ({ PICKABLE_TOOLS: ['web_search'] }));

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
});

describe('LoopFormModal', () => {
  const renderForm = (loop?: Parameters<typeof LoopFormModal>[0]['loop']) =>
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopFormModal open onClose={vi.fn()} loop={loop} />
      </CssVarsProvider>
    );

  beforeEach(() => vi.clearAllMocks());

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
    } as never);
    expect(screen.getByTestId('loop-form-interval-input')).toHaveValue(2);
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
      }),
      expect.anything()
    );
  });
});
