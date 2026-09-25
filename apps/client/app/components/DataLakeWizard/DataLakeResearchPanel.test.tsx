import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IDataLakeResearchConfigDocument, IDataLakeResearchRunDocument } from '@bike4mind/common';
import {
  emptyResearchRunTotals,
  RESEARCH_COST_CEILING_MICRO_USD_DEFAULT,
  RESEARCH_MIN_RELEVANCE_DEFAULT,
  RESEARCH_RUN_STALE_AFTER_MS,
} from '@bike4mind/common';
import { DataLakeResearchPanel } from './DataLakeResearchPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const config = (overrides: Partial<IDataLakeResearchConfigDocument> = {}) =>
  ({
    id: 'config-1',
    dataLakeId: 'lake-1',
    name: 'Weekly sweep',
    trigger: 'on_demand',
    createdByUserId: 'user-1',
    query: 'coastal erosion in Cornwall',
    model: 'gpt-4.1-mini',
    maxResults: 10,
    maxProposals: 5,
    recencyDays: 30,
    allowedDomains: ['example.com'],
    blockedDomains: ['spam.net'],
    minRelevance: 0.6,
    costCeilingMicroUsd: 50_000,
    proposedTags: ['research'],
    lastRunAt: null,
    ...overrides,
  }) as IDataLakeResearchConfigDocument;

const run = (overrides: Partial<IDataLakeResearchRunDocument> = {}) =>
  ({
    id: 'run-1',
    dataLakeId: 'lake-1',
    configId: 'config-1',
    trigger: 'on_demand',
    // The levers AS EXECUTED, which is what the history renders from - a config is editable and
    // deletable, so reading the live one would attribute a run to settings it never ran with.
    levers: {
      query: 'coastal erosion in Cornwall',
      maxResults: 10,
      maxProposals: 5,
      minRelevance: 0.6,
      costCeilingMicroUsd: 50_000,
      allowedDomains: [],
      blockedDomains: [],
      proposedTags: [],
    },
    status: 'completed',
    spentMicroUsd: 1_234,
    totals: emptyResearchRunTotals(),
    startedAt: new Date('2026-03-01T12:00:00.000Z'),
    completedAt: new Date('2026-03-01T12:05:00.000Z'),
    stopReason: null,
    error: null,
    ...overrides,
  }) as IDataLakeResearchRunDocument;

const handlers = () => ({
  onCreate: vi.fn(),
  onUpdate: vi.fn(),
  onDelete: vi.fn(),
  onStartRun: vi.fn(),
});

const renderPanel = (props: Partial<React.ComponentProps<typeof DataLakeResearchPanel>> = {}) => {
  const spies = handlers();
  render(
    <Wrapper>
      <DataLakeResearchPanel
        configs={[]}
        runs={[]}
        isLoading={false}
        error={null}
        modelOptions={[{ id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' }]}
        {...spies}
        {...props}
      />
    </Wrapper>
  );
  return spies;
};

beforeEach(() => vi.clearAllMocks());

describe('DataLakeResearchPanel', () => {
  it('says up front that nothing reaches the lake without a human', () => {
    renderPanel();
    expect(screen.getByTestId('datalake-research-help').textContent).toMatch(/until you approve/i);
  });

  it('shows a spinner while loading and an error when the read failed', () => {
    const { unmount } = render(
      <Wrapper>
        <DataLakeResearchPanel
          configs={undefined}
          runs={undefined}
          isLoading
          error={null}
          modelOptions={[]}
          {...handlers()}
        />
      </Wrapper>
    );
    expect(screen.getByTestId('datalake-research-loading')).toBeTruthy();
    unmount();

    renderPanel({ configs: undefined, error: new Error('boom') });
    expect(screen.getByTestId('datalake-research-error')).toBeTruthy();
  });

  // Unlike the Proposals tab, this one is where a configuration is CREATED - hiding it while there
  // are none would hide the only way to make one.
  it('offers a way in when the lake has no configurations yet', () => {
    renderPanel();
    expect(screen.getByTestId('datalake-research-empty')).toBeTruthy();
    expect(screen.getByTestId('datalake-research-new-btn')).toBeTruthy();
  });

  it('lists a saved configuration with its query and its two spend-shaped limits', () => {
    renderPanel({ configs: [config()] });

    expect(screen.getByTestId('datalake-research-config-query').textContent).toBe('coastal erosion in Cornwall');
    expect(screen.getByTestId('datalake-research-config-limits').textContent).toMatch(/Up to 5 proposals/);
    expect(screen.getByTestId('datalake-research-config-limits').textContent).toMatch(/\$0\.05 ceiling/);
  });

  it('starts a run for the configuration whose button was pressed', () => {
    const spies = renderPanel({ configs: [config({ id: 'config-a' }), config({ id: 'config-b', name: 'Other' })] });

    fireEvent.click(screen.getAllByTestId('datalake-research-run-btn')[1]);

    expect(spies.onStartRun).toHaveBeenCalledWith('config-b');
  });

  // A lake runs one at a time; the server refuses a second. Saying so beats earning a refusal toast.
  // `startedAt` has to be recent: in-flight is age-bounded, so a fixture's fixed date would age out.
  it('disables Run while a run is still in flight', () => {
    renderPanel({ configs: [config()], runs: [run({ status: 'running', startedAt: new Date() })] });

    const button = screen.getByTestId('datalake-research-run-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/in progress/i);
  });

  it('re-enables Run once every run has settled', () => {
    renderPanel({ configs: [config()], runs: [run({ status: 'completed' })] });
    expect((screen.getByTestId('datalake-research-run-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  // The lockout this closes: a hard-killed run keeps `running` forever because its catch never ran.
  // The server already ignores such a row when it counts active runs, so a status-only button would
  // refuse a run the server would accept - for every config in the lake, not just that one.
  it('re-enables Run once a running row has aged past the stale bound', () => {
    const abandoned = run({
      status: 'running',
      startedAt: new Date(Date.now() - (RESEARCH_RUN_STALE_AFTER_MS + 60_000)),
      completedAt: null,
    });
    renderPanel({ configs: [config()], runs: [abandoned] });

    const button = screen.getByTestId('datalake-research-run-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toMatch(/run now/i);
  });

  describe('the configuration form', () => {
    it('submits a new configuration with every lever the form holds', () => {
      const spies = renderPanel();

      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.change(screen.getByTestId('datalake-research-max-results-input'), { target: { value: '12' } });
      fireEvent.change(screen.getByTestId('datalake-research-recency-input'), { target: { value: '45' } });
      fireEvent.change(screen.getByTestId('datalake-research-cost-ceiling-input'), { target: { value: '0.25' } });
      fireEvent.change(screen.getByTestId('datalake-research-allowed-input'), {
        target: { value: 'example.com\ndocs.example.com' },
      });
      fireEvent.change(screen.getByTestId('datalake-research-tags-input'), { target: { value: 'research, weekly' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Weekly',
          query: 'erosion',
          maxResults: 12,
          recencyDays: 45,
          // Entered in dollars, sent in micro-USD - the unit the server stores.
          costCeilingMicroUsd: 250_000,
          allowedDomains: ['example.com', 'docs.example.com'],
          proposedTags: ['research', 'weekly'],
        })
      );
    });

    // The default state of a new configuration, and the one the wire schema used to reject: the
    // Default option's value is '', which `draftToInput` sends as null.
    it('sends a null judge model when the Default option is left alone', () => {
      const spies = renderPanel();

      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledWith(expect.objectContaining({ model: null }));
    });

    // Blank is "use the default", not 0: the server clamps rather than rejects, so a 0 here would
    // silently mean "propose everything" on the relevance floor and 1 micro-USD on the ceiling.
    it('falls back to the shared defaults when a numeric lever is cleared', () => {
      const spies = renderPanel();

      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.change(screen.getByTestId('datalake-research-min-relevance-input'), { target: { value: '' } });
      fireEvent.change(screen.getByTestId('datalake-research-cost-ceiling-input'), { target: { value: '' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          minRelevance: RESEARCH_MIN_RELEVANCE_DEFAULT,
          costCeilingMicroUsd: RESEARCH_COST_CEILING_MICRO_USD_DEFAULT,
        })
      );
    });

    it('will not submit without a name and a question', () => {
      renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));

      expect((screen.getByTestId('datalake-research-save-btn') as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'n' } });
      expect((screen.getByTestId('datalake-research-save-btn') as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'q' } });
      expect((screen.getByTestId('datalake-research-save-btn') as HTMLButtonElement).disabled).toBe(false);
    });

    it('loads the stored levers when editing, and routes the save to that configuration', () => {
      const spies = renderPanel({ configs: [config()] });

      fireEvent.click(screen.getByTestId('datalake-research-edit-btn'));

      expect((screen.getByTestId('datalake-research-query-input') as HTMLTextAreaElement).value).toBe(
        'coastal erosion in Cornwall'
      );
      expect((screen.getByTestId('datalake-research-recency-input') as HTMLInputElement).value).toBe('30');
      // Micro-USD on the wire, dollars in the field.
      expect((screen.getByTestId('datalake-research-cost-ceiling-input') as HTMLInputElement).value).toBe('0.05');
      expect((screen.getByTestId('datalake-research-blocked-input') as HTMLTextAreaElement).value).toBe('spam.net');

      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      // `model` included: a stored judge model has to survive an edit that never touches the Select,
      // which is the other half of the null-model case above.
      expect(spies.onUpdate).toHaveBeenCalledWith(
        'config-1',
        expect.objectContaining({ name: 'Weekly sweep', model: 'gpt-4.1-mini' })
      );
      expect(spies.onCreate).not.toHaveBeenCalled();
    });

    // toFixed(2) would seed this field with "0.00", which fails the "above $0" check and blocks
    // Save, or rounds up and saves a ceiling other than the one that was loaded.
    it('round-trips a sub-cent cost ceiling through Edit and Save unchanged', () => {
      const spies = renderPanel({ configs: [config({ costCeilingMicroUsd: 4_000 })] });

      fireEvent.click(screen.getByTestId('datalake-research-edit-btn'));
      expect((screen.getByTestId('datalake-research-cost-ceiling-input') as HTMLInputElement).value).toBe('0.004');
      expect(screen.getByTestId('datalake-research-save-btn')).not.toBeDisabled();

      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onUpdate).toHaveBeenCalledWith('config-1', expect.objectContaining({ costCeilingMicroUsd: 4_000 }));
    });

    // undefined would mean "unchanged" and the stored value would come straight back.
    it('sends null for a cleared recency, so clearing it actually clears it', () => {
      const spies = renderPanel({ configs: [config()] });

      fireEvent.click(screen.getByTestId('datalake-research-edit-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-recency-input'), { target: { value: '' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onUpdate.mock.calls[0][1].recencyDays).toBeNull();
    });

    it('closes without saving on cancel', () => {
      const spies = renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-cancel-btn'));

      expect(screen.queryByTestId('datalake-research-form')).toBeNull();
      expect(spies.onCreate).not.toHaveBeenCalled();
    });
  });

  it('deletes the configuration whose button was pressed', () => {
    const spies = renderPanel({ configs: [config({ id: 'config-a' })] });
    fireEvent.click(screen.getByTestId('datalake-research-delete-btn'));
    expect(spies.onDelete).toHaveBeenCalledWith('config-a');
  });

  describe('run history', () => {
    it('names which filter ate the hits that were not proposed, and skips the empty buckets', () => {
      renderPanel({
        runs: [
          run({
            totals: { ...emptyResearchRunTotals(), searchHits: 10, proposed: 3, belowRelevance: 5, fetchFailed: 2 },
          }),
        ],
      });

      const summary = screen.getByTestId('datalake-research-run-totals').textContent ?? '';
      expect(summary).toMatch(/10 found/);
      expect(summary).toMatch(/3 proposed/);
      expect(summary).toMatch(/5 below the relevance floor/);
      expect(summary).toMatch(/2 could not be fetched/);
      expect(summary).not.toMatch(/already in the lake/);
    });

    // Twenty configurations per lake are allowed, so a history that only says "completed" is
    // unreadable.
    it('names the configuration a run came from', () => {
      renderPanel({ configs: [config({ id: 'config-1', name: 'Weekly sweep' })], runs: [run()] });
      expect(screen.getByTestId('datalake-research-run-config').textContent).toBe('Weekly sweep');
    });

    // A run outlives the config it came from: the history is the record of what actually ran, so
    // deleting the config must not blank the row.
    it('falls back to the query the run actually executed when its config is gone', () => {
      renderPanel({ configs: [], runs: [run({ configId: 'deleted-config' })] });
      expect(screen.getByTestId('datalake-research-run-config').textContent).toBe('coastal erosion in Cornwall');
    });

    it('names the lever that stopped a run early', () => {
      renderPanel({ runs: [run({ stopReason: 'cost_ceiling' })] });
      expect(screen.getByTestId('datalake-research-run-stop-reason').textContent).toMatch(/cost ceiling/i);
    });

    it('shows the failure message on a failed run', () => {
      renderPanel({ runs: [run({ status: 'failed', error: 'No web search provider is configured' })] });
      expect(screen.getByTestId('datalake-research-run-error').textContent).toMatch(/No web search provider/);
      expect(screen.queryByTestId('datalake-research-run-totals')).toBeNull();
    });

    it('shows what a run spent, at a resolution a fraction of a cent survives', () => {
      renderPanel({ runs: [run({ spentMicroUsd: 300 })] });
      expect(screen.getByTestId('datalake-research-run-row').textContent).toMatch(/\$0\.0003/);
    });

    it('still says running for a run that started moments ago', () => {
      renderPanel({ runs: [run({ status: 'running', startedAt: new Date(), completedAt: null })] });
      expect(screen.getByTestId('datalake-research-run-status').textContent).toBe('running');
    });

    // Nothing will ever settle this row, so reporting it as `running` promises work that is not
    // happening - and it is the same row the server has already stopped counting as active.
    it('calls a non-terminal run past the stale bound abandoned, not running', () => {
      renderPanel({
        runs: [
          run({
            status: 'running',
            startedAt: new Date(Date.now() - (RESEARCH_RUN_STALE_AFTER_MS + 60_000)),
            completedAt: null,
          }),
        ],
      });
      expect(screen.getByTestId('datalake-research-run-status').textContent).toBe('abandoned');
    });
  });

  describe('form validation', () => {
    const openFilledForm = () => {
      const spies = renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      return spies;
    };

    // The server clamps instead of refusing, so each of these used to save a config other than the
    // one on screen: 999 results stored as 50, a $99 ceiling as $5.00, -7 days as "no limit".
    it.each([
      ['max-results', '999'],
      ['max-results', '2.5'],
      ['max-proposals', '-3'],
      ['recency', '-7'],
      ['min-relevance', '5'],
      ['cost-ceiling', '99'],
      ['cost-ceiling', '0'],
    ])('disables Save when %s is %s', (field, value) => {
      const spies = openFilledForm();
      fireEvent.change(screen.getByTestId(`datalake-research-${field}-input`), { target: { value } });

      expect(screen.getByTestId('datalake-research-save-btn')).toBeDisabled();
      expect(screen.getByTestId('datalake-research-save-hint').textContent).toMatch(/highlighted fields/i);
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onCreate).not.toHaveBeenCalled();
    });

    it('shows the range as the error in place of the help text', () => {
      openFilledForm();
      fireEvent.change(screen.getByTestId('datalake-research-max-proposals-input'), { target: { value: '-3' } });
      expect(screen.getByText('Enter a whole number from 1 to 25.')).toBeTruthy();
    });

    it('explains a Save disabled for a missing name or question', () => {
      renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      expect(screen.getByTestId('datalake-research-save-hint').textContent).toMatch(/name and what to look for/i);
    });

    it('counts the name and question against their limits', () => {
      openFilledForm();
      expect(screen.getByTestId('datalake-research-name-count').textContent).toBe('6/120');
      expect(screen.getByTestId('datalake-research-query-count').textContent).toMatch(/7\/500$/);
    });
  });

  describe('config card', () => {
    it('pluralizes the proposal limit and shows a whole-cent ceiling as money', () => {
      renderPanel({ configs: [config({ maxProposals: 1, costCeilingMicroUsd: 50_000 })] });
      expect(screen.getByTestId('datalake-research-config-limits').textContent).toBe(
        'Up to 1 proposal \u00b7 $0.05 ceiling'
      );
    });

    it('names the model and lists the tags a run proposes', () => {
      renderPanel({ configs: [config({ proposedTags: ['research', 'weekly'] })] });
      expect(screen.getByTestId('datalake-research-config-model').textContent).toBe('Model: GPT-4.1 mini');
      expect(screen.getByTestId('datalake-research-config-tags').textContent).toBe('researchweekly');
    });

    it('names the default model when the config leaves it unset', () => {
      renderPanel({ configs: [config({ model: undefined })], defaultModelLabel: 'Default (GPT-4.1 Mini)' });
      expect(screen.getByTestId('datalake-research-config-model').textContent).toBe('Model: Default (GPT-4.1 Mini)');
    });

    // `lastRunAt` is stamped at queue time; the history row shows the start time. One page, one clock.
    it('reports the last run at the time its history row shows', () => {
      const startedAt = new Date('2026-03-01T12:00:00.000Z');
      renderPanel({
        configs: [config({ lastRunAt: new Date('2026-03-01T11:00:00.000Z') })],
        runs: [run({ startedAt })],
      });
      expect(screen.getByTestId('datalake-research-config-last-run').textContent).toBe(
        `Last run ${startedAt.toLocaleString()}`
      );
    });

    // A retired or filtered model must still read as the selection, or the picker shows blank while
    // a save quietly keeps a model the manager cannot see.
    it('keeps a saved model the picker no longer lists visible as the selection', () => {
      renderPanel({ configs: [config({ model: 'o3-deep-research' })] });
      expect(screen.getByTestId('datalake-research-config-model').textContent).toBe('Model: o3-deep-research');
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn'));
      expect(screen.getByTestId('datalake-research-model-select').textContent).toBe(
        'o3-deep-research (not offered for research)'
      );
    });

    it('will not run a config while its edit form holds unsaved changes', () => {
      const spies = renderPanel({ configs: [config()] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn'));
      expect(screen.getByTestId('datalake-research-run-btn')).not.toBeDisabled();

      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'something else' } });
      const runButton = screen.getByTestId('datalake-research-run-btn');
      expect(runButton).toBeDisabled();
      expect(runButton.textContent).toBe('Save changes to run');
      fireEvent.click(runButton);
      expect(spies.onStartRun).not.toHaveBeenCalled();
    });
  });
});
