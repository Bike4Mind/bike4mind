import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IDataLakeResearchConfigResponse, IDataLakeResearchRunDocument } from '@bike4mind/common';
import {
  ChatModels,
  emptyResearchRunTotals,
  RESEARCH_COST_CEILING_MICRO_USD_DEFAULT,
  RESEARCH_ITEM_RULE_CONDITION_MAX_CHARS,
  RESEARCH_ITEM_RULES_MAX,
  RESEARCH_MAX_RESULTS_LIMIT,
  RESEARCH_MIN_RELEVANCE_DEFAULT,
  RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT,
  RESEARCH_RUN_STALE_AFTER_MS,
} from '@bike4mind/common';
import { DataLakeResearchPanel, formatWhen } from './DataLakeResearchPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const config = (overrides: Partial<IDataLakeResearchConfigResponse> = {}) =>
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
    trustedDomains: [],
    reviewDomains: ['example.com'],
    unlistedSources: 'drop',
    allowedDomains: ['example.com'],
    blockedDomains: ['spam.net'],
    minRelevance: 0.6,
    costCeilingMicroUsd: 50_000,
    proposedTags: ['research'],
    lastRunAt: null,
    ...overrides,
  }) as IDataLakeResearchConfigResponse;

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
      trustedDomains: [],
      reviewDomains: [],
      unlistedSources: 'review',
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
  onCreate: vi.fn().mockResolvedValue(undefined),
  onUpdate: vi.fn().mockResolvedValue(undefined),
  onDelete: vi.fn(),
  onStartRun: vi.fn(),
});

const renderPanel = (props: Partial<React.ComponentProps<typeof DataLakeResearchPanel>> = {}) => {
  const spies = handlers();
  const panel = (overrides: Partial<React.ComponentProps<typeof DataLakeResearchPanel>>) => (
    <Wrapper>
      <DataLakeResearchPanel
        configs={[]}
        runs={[]}
        isLoading={false}
        error={null}
        modelOptions={[{ id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' }]}
        {...spies}
        {...props}
        {...overrides}
      />
    </Wrapper>
  );
  const { unmount, rerender } = render(panel({}));
  return {
    ...spies,
    unmount,
    rerender: (overrides: Partial<React.ComponentProps<typeof DataLakeResearchPanel>>) => rerender(panel(overrides)),
  };
};

beforeEach(() => vi.clearAllMocks());

describe('DataLakeResearchPanel', () => {
  it('says up front that only a trusted site can skip review, never a score', () => {
    renderPanel();
    const text = screen.getByTestId('datalake-research-help').textContent ?? '';
    expect(text).toMatch(/wait there for your approval/i);
    expect(text).toMatch(/ever added because of a relevance score/i);
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

  describe('opening the form', () => {
    let scrollIntoView: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    });
    afterEach(() => {
      scrollIntoView.mockRestore();
    });

    it('scrolls the edit form into view and focuses its first field', () => {
      renderPanel({ configs: [config()] });
      expect(scrollIntoView).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByTestId('datalake-research-form'));
      expect(document.activeElement).toBe(screen.getByTestId('datalake-research-name-input'));
    });

    it('scrolls and focuses again when Edit is pressed on the config whose form is already open', () => {
      renderPanel({ configs: [config()] });

      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      (document.activeElement as HTMLElement).blur();
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(document.activeElement).toBe(screen.getByTestId('datalake-research-name-input'));
    });

    it('does the same for a new configuration', () => {
      renderPanel();

      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(screen.getByTestId('datalake-research-name-input'));
    });
  });

  it('starts a run for the configuration whose button was pressed', () => {
    const spies = renderPanel({ configs: [config({ id: 'config-a' }), config({ id: 'config-b', name: 'Other' })] });

    fireEvent.click(screen.getByTestId('datalake-research-run-btn-config-b'));

    expect(spies.onStartRun).toHaveBeenCalledWith('config-b');
  });

  it('disables Run while a run is still in flight', () => {
    renderPanel({ configs: [config()], runs: [run({ status: 'running', startedAt: new Date() })] });

    const button = screen.getByTestId('datalake-research-run-btn-config-1') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/in progress/i);
  });

  it('says which card owns the active run and marks the others as another run', () => {
    renderPanel({
      configs: [config({ id: 'config-a' }), config({ id: 'config-b', name: 'Other' })],
      runs: [run({ configId: 'config-b', status: 'running', startedAt: new Date() })],
    });
    expect(screen.getByTestId('datalake-research-run-btn-config-b').textContent).toBe('Run in progress');
    expect(screen.getByTestId('datalake-research-run-btn-config-a').textContent).toBe('Another run in progress');
  });

  it('re-enables Run once every run has settled', () => {
    renderPanel({ configs: [config()], runs: [run({ status: 'completed' })] });
    expect((screen.getByTestId('datalake-research-run-btn-config-1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('re-enables Run once a running row has aged past the stale bound', () => {
    const abandoned = run({
      status: 'running',
      startedAt: new Date(Date.now() - (RESEARCH_RUN_STALE_AFTER_MS + 60_000)),
      completedAt: null,
    });
    renderPanel({ configs: [config()], runs: [abandoned] });

    const button = screen.getByTestId('datalake-research-run-btn-config-1') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toMatch(/run now/i);
  });

  describe('item rules', () => {
    const openNewForm = () => {
      const spies = renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      return spies;
    };

    it('sends no rules by default', () => {
      const spies = openNewForm();
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onCreate).toHaveBeenCalledWith(expect.objectContaining({ itemRules: [] }));
    });

    it('adds, edits and submits rules with their actions', () => {
      const spies = openNewForm();
      fireEvent.click(screen.getByTestId('datalake-research-rule-add'));
      fireEvent.change(screen.getByTestId('datalake-research-rule-condition-0'), {
        target: { value: '  the author works for a named company  ' },
      });
      fireEvent.click(screen.getByTestId('datalake-research-rule-add'));
      fireEvent.change(screen.getByTestId('datalake-research-rule-condition-1'), {
        target: { value: 'it is a press release' },
      });
      fireEvent.click(screen.getByTestId('datalake-research-rule-action-1'));
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Block' }));
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          itemRules: [
            { condition: 'the author works for a named company', action: 'review' },
            { condition: 'it is a press release', action: 'block' },
          ],
        })
      );
    });

    it('removes the rule whose button was pressed', () => {
      const spies = openNewForm();
      fireEvent.click(screen.getByTestId('datalake-research-rule-add'));
      fireEvent.click(screen.getByTestId('datalake-research-rule-add'));
      fireEvent.change(screen.getByTestId('datalake-research-rule-condition-0'), { target: { value: 'first' } });
      fireEvent.change(screen.getByTestId('datalake-research-rule-condition-1'), { target: { value: 'second' } });
      fireEvent.click(screen.getByTestId('datalake-research-rule-remove-0'));
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ itemRules: [{ condition: 'second', action: 'review' }] })
      );
    });

    const addRules = (conditions: string[]) => {
      conditions.forEach((value, i) => {
        fireEvent.click(screen.getByTestId('datalake-research-rule-add'));
        fireEvent.change(screen.getByTestId(`datalake-research-rule-condition-${i}`), { target: { value } });
      });
    };

    // Seeded through Edit rather than N add-clicks: each click re-renders the whole panel.
    const editWithRules = (conditions: string[]) => {
      renderPanel({ configs: [config({ itemRules: conditions.map(condition => ({ condition, action: 'review' })) })] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
    };

    it('disables adding at the maximum', () => {
      editWithRules(Array.from({ length: RESEARCH_ITEM_RULES_MAX - 1 }, (_, i) => `rule ${i}`));
      expect(screen.getByTestId('datalake-research-rule-add')).not.toBeDisabled();
      fireEvent.click(screen.getByTestId('datalake-research-rule-add'));
      fireEvent.change(screen.getByTestId(`datalake-research-rule-condition-${RESEARCH_ITEM_RULES_MAX - 1}`), {
        target: { value: 'last rule' },
      });
      expect(screen.getByTestId('datalake-research-rule-add')).toBeDisabled();
    });

    it('does not count an invisible-only row toward the maximum', () => {
      editWithRules(['\u200B\u200B', ...Array.from({ length: RESEARCH_ITEM_RULES_MAX - 1 }, (_, i) => `rule ${i}`)]);
      expect(screen.getByTestId('datalake-research-rule-add')).not.toBeDisabled();
    });

    it('flags a repeated rule, names the earlier row and blocks saving', () => {
      openNewForm();
      addRules(['it is a press release', 'other', 'It is a  press release\u200B']);
      expect(screen.getByTestId('datalake-research-rule-error-2').textContent).toBe('Same as rule 1');
      expect(screen.queryByTestId('datalake-research-rule-error-0')).toBeNull();
      expect(screen.getByTestId('datalake-research-save-btn')).toBeDisabled();
    });

    it('blocks saving a rule over the length limit', () => {
      openNewForm();
      fireEvent.click(screen.getByTestId('datalake-research-rule-add'));
      fireEvent.change(screen.getByTestId('datalake-research-rule-condition-0'), {
        target: { value: 'x'.repeat(RESEARCH_ITEM_RULE_CONDITION_MAX_CHARS + 1) },
      });
      expect(screen.getByTestId('datalake-research-save-btn')).toBeDisabled();
      expect(screen.getByTestId('datalake-research-rules-error').textContent).toMatch(/300 characters/);
    });

    it('round-trips a saved rule through edit and save', () => {
      const spies = renderPanel({
        configs: [config({ itemRules: [{ condition: 'it is a press release', action: 'block' }] })],
      });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      expect((screen.getByTestId('datalake-research-rule-condition-0') as HTMLInputElement).value).toBe(
        'it is a press release'
      );
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onUpdate).toHaveBeenCalledWith(
        'config-1',
        expect.objectContaining({ itemRules: [{ condition: 'it is a press release', action: 'block' }] })
      );
    });

    it('shows a rule count on the config row only when there are rules', () => {
      const { unmount } = render(
        <Wrapper>
          <DataLakeResearchPanel
            configs={[config()]}
            runs={[]}
            isLoading={false}
            error={null}
            modelOptions={[]}
            {...handlers()}
          />
        </Wrapper>
      );
      expect(screen.queryByTestId('datalake-research-config-rules')).toBeNull();
      unmount();

      renderPanel({
        configs: [
          config({
            itemRules: [
              { condition: 'a', action: 'block' },
              { condition: 'b', action: 'review' },
            ],
          }),
        ],
      });
      expect(screen.getByTestId('datalake-research-config-rules').textContent).toBe('2 item rules');
    });
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
      fireEvent.change(screen.getByTestId('datalake-research-review-input'), {
        target: { value: 'example.com\ndocs.example.com' },
      });
      fireEvent.click(screen.getByTestId('datalake-research-unlisted-select'));
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Ignore' }));
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
          reviewDomains: ['example.com', 'docs.example.com'],
          unlistedSources: 'drop',
          proposedTags: ['research', 'weekly'],
        })
      );
      const sent = spies.onCreate.mock.calls[0][0];
      expect(sent).not.toHaveProperty('allowedDomains');
      expect(sent).toMatchObject({ trustedDomains: [], autoAdmitTrusted: false });
    });

    it('sends other sites to review by default', () => {
      const spies = renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ reviewDomains: [], unlistedSources: 'review' })
      );
    });

    it('blocks saving when other sites are ignored and no site is listed', () => {
      const spies = renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.click(screen.getByTestId('datalake-research-unlisted-select'));
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Ignore' }));

      expect(screen.getByTestId('datalake-research-unlisted-error')).toBeInTheDocument();
      expect(screen.getByTestId('datalake-research-save-btn')).toBeDisabled();

      fireEvent.change(screen.getByTestId('datalake-research-review-input'), { target: { value: 'example.com' } });
      expect(screen.queryByTestId('datalake-research-unlisted-error')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onCreate).toHaveBeenCalled();
    });

    describe('trusted sites and auto-admit', () => {
      const openForm = () => {
        const spies = renderPanel();
        fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
        fireEvent.click(screen.getByTestId('datalake-research-advanced-toggle'));
        fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
        fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
        return spies;
      };
      const toggle = () => screen.getByTestId('datalake-research-auto-admit-toggle');

      it('round-trips the trusted list, the switch and the cap on create', () => {
        const spies = openForm();
        fireEvent.change(screen.getByTestId('datalake-research-trusted-input'), {
          target: { value: 'example.com\ndocs.example.org' },
        });
        fireEvent.click(toggle());
        fireEvent.change(screen.getByTestId('datalake-research-auto-admit-cap'), { target: { value: '4' } });
        fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

        expect(spies.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            trustedDomains: ['example.com', 'docs.example.org'],
            autoAdmitTrusted: true,
            maxAutoAdmits: 4,
          })
        );
      });

      it('disables the switch while the trusted list is empty and hides the cap', () => {
        openForm();
        expect(toggle()).toBeDisabled();
        expect(screen.queryByTestId('datalake-research-auto-admit-cap')).not.toBeInTheDocument();
      });

      it('never sends the switch on with an empty list', () => {
        const spies = openForm();
        fireEvent.change(screen.getByTestId('datalake-research-trusted-input'), { target: { value: 'example.com' } });
        fireEvent.click(toggle());
        fireEvent.change(screen.getByTestId('datalake-research-trusted-input'), { target: { value: '' } });
        fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
        expect(spies.onCreate).toHaveBeenCalledWith(expect.objectContaining({ autoAdmitTrusted: false }));
      });

      it('shows the effective limit when the cap exceeds the proposal limit', () => {
        openForm();
        fireEvent.change(screen.getByTestId('datalake-research-trusted-input'), { target: { value: 'example.com' } });
        fireEvent.click(toggle());
        fireEvent.change(screen.getByTestId('datalake-research-max-proposals-input'), { target: { value: '2' } });
        fireEvent.change(screen.getByTestId('datalake-research-auto-admit-cap'), { target: { value: '9' } });
        expect(screen.getByText(/Up to 2 per run; the proposal limit applies/)).toBeInTheDocument();
      });

      it('loads a saved configuration with the switch on', () => {
        renderPanel({
          configs: [config({ trustedDomains: ['example.com'], autoAdmitTrusted: true, maxAutoAdmits: 6 })],
        });
        expect(screen.getByTestId('datalake-research-config-auto-admit').textContent).toMatch(/up to 6 per run/);
        fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
        expect(screen.getByTestId('datalake-research-trusted-input')).toHaveValue('example.com');
        expect(screen.getByTestId('datalake-research-auto-admit-cap')).toHaveValue(6);
      });

      it('explains what applies to a run in progress and what waits for the next run', () => {
        openForm();
        expect(screen.getByTestId('datalake-research-auto-admit-timing-help').textContent).toMatch(
          /stops a run already in progress.*applies from the next run/
        );
      });

      it('tells the user a save that turned auto-admit off takes effect now', async () => {
        const onUpdate = vi.fn().mockResolvedValue(undefined);
        renderPanel({
          configs: [config({ trustedDomains: ['example.com'], autoAdmitTrusted: true, maxAutoAdmits: 6 })],
          onUpdate,
        });
        fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
        fireEvent.click(screen.getByTestId('datalake-research-advanced-toggle'));
        fireEvent.click(toggle());
        fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

        const notice = await screen.findByTestId('datalake-research-save-timing-notice');
        expect(notice.textContent).toBe(
          'Saved. Runs in progress stop adding results from removed or disabled sites now.'
        );
      });

      it('tells the user a save that turned auto-admit on applies from the next run', async () => {
        renderPanel({ configs: [config({ trustedDomains: ['example.com'], autoAdmitTrusted: false })] });
        fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
        fireEvent.click(screen.getByTestId('datalake-research-advanced-toggle'));
        fireEvent.click(toggle());
        fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

        const notice = await screen.findByTestId('datalake-research-save-timing-notice');
        expect(notice.textContent).toBe('Saved. This applies from the next run.');
      });

      describe('notice only when the save changes what a run does', () => {
        const saveWith = async (
          stored: Parameters<typeof config>[0],
          field: string,
          value: string,
          onUpdate = vi.fn().mockResolvedValue(undefined)
        ) => {
          renderPanel({ configs: [config(stored)], onUpdate });
          fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
          fireEvent.click(screen.getByTestId('datalake-research-advanced-toggle'));
          fireEvent.change(screen.getByTestId(field), { target: { value } });
          fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
          await waitFor(() => expect(onUpdate).toHaveBeenCalled());
        };
        const noNotice = () =>
          expect(screen.queryByTestId('datalake-research-save-timing-notice')).not.toBeInTheDocument();

        it('shows none when a site is retyped in another spelling', async () => {
          await saveWith(
            { trustedDomains: ['example.com'], autoAdmitTrusted: true },
            'datalake-research-trusted-input',
            'www.example.com'
          );
          noNotice();
        });

        it('shows none when a site is removed while auto-admit is off', async () => {
          await saveWith(
            { trustedDomains: ['example.com', 'other.org'], autoAdmitTrusted: false },
            'datalake-research-trusted-input',
            'example.com'
          );
          noNotice();
        });

        it('shows none when a site is added while auto-admit is off', async () => {
          await saveWith(
            { trustedDomains: ['example.com'], autoAdmitTrusted: false },
            'datalake-research-trusted-input',
            'example.com\nother.org'
          );
          noNotice();
        });

        it('says it stops now when a site is blocked while auto-admit stays on', async () => {
          await saveWith(
            { trustedDomains: ['example.com'], autoAdmitTrusted: true },
            'datalake-research-blocked-input',
            'example.com'
          );
          expect((await screen.findByTestId('datalake-research-save-timing-notice')).textContent).toMatch(/now\.$/);
        });
      });

      it('shows no timing notice when the save leaves auto-admit untouched', async () => {
        const onUpdate = vi.fn().mockResolvedValue(undefined);
        renderPanel({ configs: [config()], onUpdate });
        fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
        fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

        await waitFor(() => expect(onUpdate).toHaveBeenCalled());
        expect(screen.queryByTestId('datalake-research-save-timing-notice')).not.toBeInTheDocument();
      });
    });

    it('sends a null judge model when the Default option is left alone', () => {
      const spies = renderPanel();

      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledWith(expect.objectContaining({ model: null }));
    });

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

    it('prefills a migrated config with the same restriction as before', () => {
      renderPanel({ configs: [config()] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

      expect((screen.getByTestId('datalake-research-review-input') as HTMLTextAreaElement).value).toBe('example.com');
      expect(screen.getByTestId('datalake-research-unlisted-select').textContent).toBe('Ignore');
    });

    it('prefills from a response that carries only allowedDomains (an older server)', () => {
      const legacy = config({
        allowedDomains: ['example.com', 'docs.example.com'],
      }) as Partial<IDataLakeResearchConfigResponse>;
      delete legacy.trustedDomains;
      delete legacy.reviewDomains;
      delete legacy.unlistedSources;
      renderPanel({ configs: [legacy as IDataLakeResearchConfigResponse] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

      expect((screen.getByTestId('datalake-research-review-input') as HTMLTextAreaElement).value).toBe(
        'example.com\ndocs.example.com'
      );
      expect(screen.getByTestId('datalake-research-unlisted-select').textContent).toBe('Ignore');
    });

    it('prefills an older server response with no allow list as other sites to review', () => {
      const legacy = config({ allowedDomains: [] }) as Partial<IDataLakeResearchConfigResponse>;
      delete legacy.trustedDomains;
      delete legacy.reviewDomains;
      delete legacy.unlistedSources;
      renderPanel({ configs: [legacy as IDataLakeResearchConfigResponse] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

      expect(screen.getByTestId('datalake-research-unlisted-select').textContent).toBe('Send to review');
    });

    it('loads the stored levers when editing, and routes the save to that configuration', () => {
      const spies = renderPanel({ configs: [config()] });

      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

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

    it('round-trips a sub-cent cost ceiling through Edit and Save unchanged', () => {
      const spies = renderPanel({ configs: [config({ costCeilingMicroUsd: 4_000 })] });

      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      expect((screen.getByTestId('datalake-research-cost-ceiling-input') as HTMLInputElement).value).toBe('0.004');
      expect(screen.getByTestId('datalake-research-save-btn')).not.toBeDisabled();

      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onUpdate).toHaveBeenCalledWith('config-1', expect.objectContaining({ costCeilingMicroUsd: 4_000 }));
    });

    it('sends null for a cleared recency, so clearing it actually clears it', () => {
      const spies = renderPanel({ configs: [config()] });

      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      fireEvent.change(screen.getByTestId('datalake-research-recency-input'), { target: { value: '' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onUpdate.mock.calls[0][1].recencyDays).toBeNull();
    });

    it('closes the form once a save succeeds', async () => {
      const spies = renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByTestId('datalake-research-form')).toBeNull());
    });

    it('keeps a new draft on screen when the create is refused, so Save can be retried', async () => {
      const onCreate = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
      renderPanel({ onCreate });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.change(screen.getByTestId('datalake-research-recency-input'), { target: { value: '45' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(screen.getByTestId('datalake-research-form')).toBeInTheDocument();
      expect((screen.getByTestId('datalake-research-name-input') as HTMLInputElement).value).toBe('Weekly');
      expect((screen.getByTestId('datalake-research-query-input') as HTMLTextAreaElement).value).toBe('erosion');
      expect((screen.getByTestId('datalake-research-recency-input') as HTMLInputElement).value).toBe('45');

      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Weekly', recencyDays: 45 }));
      await waitFor(() => expect(screen.queryByTestId('datalake-research-form')).toBeNull());
    });

    it('keeps edits on screen when the update is refused', async () => {
      const onUpdate = vi.fn().mockRejectedValue(new Error('forbidden'));
      renderPanel({ configs: [config()], onUpdate });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'dune erosion' } });
      fireEvent.change(screen.getByTestId('datalake-research-recency-input'), { target: { value: '7' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('config-1', expect.anything()));
      await Promise.resolve();
      expect(screen.getByTestId('datalake-research-form')).toBeInTheDocument();
      expect((screen.getByTestId('datalake-research-query-input') as HTMLTextAreaElement).value).toBe('dune erosion');
      expect((screen.getByTestId('datalake-research-recency-input') as HTMLInputElement).value).toBe('7');
    });

    it('leaves a newer form open when an earlier save settles', async () => {
      let resolveCreate: () => void = () => {};
      const onCreate = vi.fn(() => new Promise<void>(resolve => (resolveCreate = resolve)));
      renderPanel({ configs: [config()], onCreate });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-cancel-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

      resolveCreate();
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(screen.getByTestId('datalake-research-form')).toBeInTheDocument();
      expect((screen.getByTestId('datalake-research-name-input') as HTMLInputElement).value).toBe('Weekly sweep');
    });

    it('leaves a second new-configuration draft open when the first create settles', async () => {
      let resolveCreate: () => void = () => {};
      const onCreate = vi.fn(() => new Promise<void>(resolve => (resolveCreate = resolve)));
      renderPanel({ onCreate });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-cancel-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Monthly' } });

      resolveCreate();
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(screen.getByTestId('datalake-research-form')).toBeInTheDocument();
      expect((screen.getByTestId('datalake-research-name-input') as HTMLInputElement).value).toBe('Monthly');
    });

    it('leaves a reopened edit of the same configuration open when the earlier update settles', async () => {
      let resolveUpdate: () => void = () => {};
      const onUpdate = vi.fn(() => new Promise<void>(resolve => (resolveUpdate = resolve)));
      renderPanel({ configs: [config()], onUpdate });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-cancel-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'dune erosion' } });

      resolveUpdate();
      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(screen.getByTestId('datalake-research-form')).toBeInTheDocument();
      expect((screen.getByTestId('datalake-research-query-input') as HTMLTextAreaElement).value).toBe('dune erosion');
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
    fireEvent.click(screen.getByTestId('datalake-research-delete-btn-config-a'));
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

    it('names the configuration a run came from', () => {
      renderPanel({ configs: [config({ id: 'config-1', name: 'Weekly sweep' })], runs: [run()] });
      expect(screen.getByTestId('datalake-research-run-config').textContent).toBe('Weekly sweep');
    });

    it('falls back to the query the run actually executed when its config is gone', () => {
      renderPanel({ configs: [], runs: [run({ configId: 'deleted-config' })] });
      expect(screen.getByTestId('datalake-research-run-config').textContent).toBe('coastal erosion in Cornwall');
    });

    it('reports what the trusted-site rule did, without counting it as a drop', () => {
      renderPanel({
        runs: [
          run({
            totals: { ...emptyResearchRunTotals(), searchHits: 6, proposed: 4, autoAdmitted: 3, autoAdmitSkipped: 1 },
          }),
        ],
      });
      const summary = screen.getByTestId('datalake-research-run-totals').textContent ?? '';
      expect(summary).toMatch(/4 proposed/);
      expect(summary).toMatch(/3 added automatically/);
      expect(summary).toMatch(/1 trusted, not added automatically/);
    });

    it('counts items blocked by a rule as a drop and rule reviews as a sub-count of proposed', () => {
      renderPanel({
        runs: [
          run({
            totals: { ...emptyResearchRunTotals(), searchHits: 8, proposed: 4, reviewedByRule: 2, blockedByRule: 3 },
          }),
        ],
      });
      const summary = screen.getByTestId('datalake-research-run-totals').textContent ?? '';
      expect(summary).toMatch(/4 proposed/);
      expect(summary).toMatch(/2 sent to review by a rule/);
      expect(summary).toMatch(/3 blocked by an item rule/);
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

    it('shows the judge error on a completed run alongside its totals', () => {
      renderPanel({
        runs: [
          run({
            error: 'The relevance judge (some-model) failed on 1 candidate: rate limited',
            totals: { ...run().totals, searchHits: 2, judgeFailed: 1, proposed: 1 },
          }),
        ],
      });
      expect(screen.getByTestId('datalake-research-run-error').textContent).toMatch(/rate limited/);
      expect(screen.getByTestId('datalake-research-run-totals').textContent).toMatch(/1 could not be judged/);
    });

    it('shows where the hits went on a run the judge breaker stopped', () => {
      renderPanel({
        runs: [
          run({
            status: 'failed',
            stopReason: 'judge_unavailable',
            error:
              'The relevance judge (some-model) failed on every candidate it tried (3), so nothing was proposed: model access denied',
            totals: { ...emptyResearchRunTotals(), searchHits: 10, judgeFailed: 3, notJudged: 7 },
          }),
        ],
      });
      expect(screen.getByTestId('datalake-research-run-stop-reason').textContent).toMatch(
        /^Stopped because the relevance judge was unavailable\./
      );
      const summary = screen.getByTestId('datalake-research-run-totals').textContent ?? '';
      expect(summary).toMatch(/3 could not be judged/);
      expect(summary).toMatch(/7 not judged \(the judge was unavailable, so the run stopped\)/);
    });

    it('shows totals on a failed run that stopped for another reason after a judge failure', () => {
      renderPanel({
        runs: [
          run({
            status: 'failed',
            stopReason: 'exhausted',
            totals: { ...emptyResearchRunTotals(), searchHits: 10, filteredBySource: 8, judgeFailed: 2 },
          }),
        ],
      });
      expect(screen.getByTestId('datalake-research-run-totals').textContent).toMatch(/2 could not be judged/);
    });

    it('labels hits whose search link could not be resolved as skipped', () => {
      renderPanel({
        runs: [run({ totals: { ...emptyResearchRunTotals(), searchHits: 4, unresolvedRedirect: 3, proposed: 1 } })],
      });
      expect(screen.getByTestId('datalake-research-run-totals').textContent).toMatch(
        /3 search link never revealed its site \(skipped; usually clears on the next run\)/
      );
    });

    it('labels the two source-rule drops apart on a run that stored both', () => {
      renderPanel({
        runs: [
          run({ totals: { ...emptyResearchRunTotals(), searchHits: 6, filteredBySource: 2, unlistedDropped: 4 } }),
        ],
      });
      const summary = screen.getByTestId('datalake-research-run-totals').textContent ?? '';
      expect(summary).toMatch(/2 on your Never these sites list/);
      expect(summary).toMatch(/4 from sites not on your lists \(Other sites: Ignore\)/);
    });

    it('keeps the combined label for a run stored before the split', () => {
      const { unlistedDropped: _omitted, ...legacyTotals } = emptyResearchRunTotals();
      renderPanel({
        runs: [run({ totals: { ...legacyTotals, searchHits: 6, filteredBySource: 6 } })],
      });
      const summary = screen.getByTestId('datalake-research-run-totals').textContent ?? '';
      expect(summary).toMatch(/6 blocked by your site lists/);
      expect(summary).not.toMatch(/Never these sites/);
    });

    it('does not report a judge when a run only dropped hits by source', () => {
      renderPanel({
        runs: [
          run({
            judgeModel: 'gpt-4.1-mini',
            totals: { ...emptyResearchRunTotals(), searchHits: 4, unlistedDropped: 4 },
          }),
        ],
      });
      expect(screen.queryByText(/judged by gpt-4\.1-mini/)).toBeNull();
    });

    it('names the model that judged a run', () => {
      renderPanel({
        runs: [run({ judgeModel: 'gpt-4.1-mini', totals: { ...emptyResearchRunTotals(), proposed: 1 } })],
      });
      expect(screen.getByText(/judged by gpt-4\.1-mini/)).toBeTruthy();
    });

    it('names the judge on a run still in flight when judgments are happening', () => {
      renderPanel({
        runs: [
          run({
            status: 'running',
            startedAt: new Date(),
            completedAt: null,
            judgeModel: 'gpt-4.1-mini',
            totals: { ...emptyResearchRunTotals(), proposed: 1 },
          }),
        ],
      });
      expect(screen.getByText(/judged by gpt-4\.1-mini/)).toBeTruthy();
    });

    it('does not show a judge label when nothing was judged and nothing was proposed', () => {
      renderPanel({ runs: [run({ status: 'failed', judgeModel: 'gpt-4.1-mini', totals: emptyResearchRunTotals() })] });
      expect(screen.queryByText(/judged by gpt-4\.1-mini/)).toBeNull();
      expect(screen.queryByText(/judge gpt-4\.1-mini unavailable/)).toBeNull();
    });

    it('names the judge on a run the judge breaker stopped', () => {
      renderPanel({
        runs: [
          run({
            status: 'failed',
            stopReason: 'judge_unavailable',
            judgeModel: 'gpt-4.1-mini',
            totals: { ...emptyResearchRunTotals(), searchHits: 10, judgeFailed: 3, notJudged: 7 },
          }),
        ],
      });
      expect(
        within(screen.getByTestId('datalake-research-run-when')).getByText(/judge gpt-4\.1-mini unavailable/)
      ).toBeTruthy();
      expect(screen.queryByText(/judged by/)).toBeNull();
    });

    it('names the judge on a run whose judged hits were all deduplicated', () => {
      renderPanel({
        runs: [
          run({
            judgeModel: 'gpt-4.1-mini',
            totals: { ...emptyResearchRunTotals(), searchHits: 3, alreadyInLake: 2, duplicatePending: 1 },
          }),
        ],
      });
      expect(
        within(screen.getByTestId('datalake-research-run-when')).getByText(/judged by gpt-4\.1-mini/)
      ).toBeTruthy();
    });

    it('says judged by, not unavailable, when some judgments succeeded', () => {
      renderPanel({
        runs: [
          run({
            judgeModel: 'gpt-4.1-mini',
            totals: { ...emptyResearchRunTotals(), searchHits: 2, judgeFailed: 1, proposed: 1 },
          }),
        ],
      });
      expect(
        within(screen.getByTestId('datalake-research-run-when')).getByText(/judged by gpt-4\.1-mini/)
      ).toBeTruthy();
      expect(screen.queryByText(/judge gpt-4\.1-mini unavailable/)).toBeNull();
    });

    it('shows what a run spent, at a resolution a fraction of a cent survives', () => {
      renderPanel({ runs: [run({ spentMicroUsd: 300 })] });
      expect(screen.getByTestId('datalake-research-run-row').textContent).toMatch(/\$0\.0003/);
    });

    it('still says running for a run that started moments ago', () => {
      renderPanel({ runs: [run({ status: 'running', startedAt: new Date(), completedAt: null })] });
      expect(screen.getByTestId('datalake-research-run-status').textContent).toBe('Running');
    });

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
      expect(screen.getByTestId('datalake-research-run-status').textContent).toBe('Did not finish');
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
      ['min-relevance', '101'],
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

    it.each([
      ['max-results', String(RESEARCH_MAX_RESULTS_LIMIT + 1), 'max-proposals'],
      ['max-proposals', '-3', 'max-results'],
      ['recency', '-7', 'max-results'],
      ['min-relevance', '101', 'max-results'],
      ['cost-ceiling', '99', 'max-results'],
    ])('marks %s as an error when it is %s, and leaves %s alone', (field, value, sibling) => {
      openFilledForm();
      fireEvent.change(screen.getByTestId(`datalake-research-${field}-input`), { target: { value } });
      expect(screen.getByTestId(`datalake-research-${field}-input`).closest('.MuiFormControl-root')).toHaveClass(
        'Mui-error'
      );
      expect(screen.getByTestId(`datalake-research-${sibling}-input`).closest('.MuiFormControl-root')).not.toHaveClass(
        'Mui-error'
      );
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

    it('reports the last run at the time its history row shows', () => {
      const startedAt = new Date('2026-03-01T12:00:00.000Z');
      renderPanel({
        configs: [config({ lastRunAt: new Date('2026-03-01T11:00:00.000Z') })],
        runs: [run({ startedAt })],
      });
      // Anchored to the fixture, not just row-vs-card: both read `runStartedAt`, so they would drift together.
      const expected = formatWhen(startedAt);
      expect(screen.getByTestId('datalake-research-run-when').textContent?.split(' \u00b7 ')[0]).toBe(expected);
      expect(screen.getByTestId('datalake-research-config-last-run').textContent).toBe(`Last run ${expected}`);
    });

    it('keeps a saved model the picker no longer lists visible as the selection', () => {
      renderPanel({ configs: [config({ model: 'o3-deep-research' })] });
      expect(screen.getByTestId('datalake-research-config-model').textContent).toBe('Model: o3-deep-research');
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      expect(screen.getByTestId('datalake-research-model-select').textContent).toBe(
        'o3-deep-research (not offered for research)'
      );
    });

    it('will not run a config while its edit form holds unsaved changes', () => {
      const spies = renderPanel({ configs: [config()] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      expect(screen.getByTestId('datalake-research-run-btn-config-1')).not.toBeDisabled();

      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'something else' } });
      const runButton = screen.getByTestId('datalake-research-run-btn-config-1');
      expect(runButton).toBeDisabled();
      expect(runButton.textContent).toBe('Save changes to run');
      fireEvent.click(runButton);
      expect(spies.onStartRun).not.toHaveBeenCalled();
    });
  });

  describe('scheduling (#3292)', () => {
    it('sends the chosen cadence and review backlog limit on create', () => {
      const spies = renderPanel();

      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.click(screen.getByTestId('datalake-research-cadence-select'));
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Daily' }));
      fireEvent.change(screen.getByTestId('datalake-research-review-backlog-input'), { target: { value: '10' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ cadence: 'daily', reviewBacklogLimit: 10 })
      );
    });

    it('hides the review backlog field while the schedule is off', () => {
      renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      expect(screen.queryByTestId('datalake-research-review-backlog-input')).toBeNull();
    });

    it('shows no schedule line on the config card when the cadence is off', () => {
      renderPanel({ configs: [config()] });
      expect(screen.queryByTestId('datalake-research-schedule')).toBeNull();
    });

    it('names the cadence, the next run time and the hold threshold on the config card', () => {
      renderPanel({
        configs: [
          config({ cadence: 'weekly', nextRunAt: new Date('2026-04-01T00:00:00.000Z'), reviewBacklogLimit: 7 }),
        ],
      });
      const line = screen.getByTestId('datalake-research-schedule').textContent ?? '';
      expect(line).toMatch(/Runs weekly/);
      expect(line).toMatch(/Next run: \w{3}.*\b(31|Apr)/);
      expect(line).toMatch(/Held while 7 or more proposals are waiting\./);
    });

    it('shows the held line once pending proposals reach the limit, and not one below it', () => {
      const scheduled = config({ cadence: 'daily', reviewBacklogLimit: 10 });
      const { unmount } = renderPanel({ configs: [scheduled], pendingProposals: 9 });
      expect(screen.queryByTestId('datalake-research-schedule-held')).toBeNull();
      unmount();

      renderPanel({ configs: [scheduled], pendingProposals: 10 });
      expect(screen.getByTestId('datalake-research-schedule-held').textContent).toMatch(
        /^Held: 10 proposals are waiting\./
      );
    });

    it('says why the last scheduled tick did not start a run', () => {
      const at = new Date('2026-03-02T00:00:00Z');
      const { unmount } = renderPanel({
        configs: [config({ cadence: 'daily', lastScheduledOutcome: { outcome: 'skipped', at, reason: 'daily_cap' } })],
      });
      expect(screen.getByTestId('datalake-research-schedule-outcome').textContent).toMatch(/daily run limit/);
      unmount();

      renderPanel({
        configs: [
          config({ cadence: 'daily', lastScheduledOutcome: { outcome: 'failed', at, error: 'Could not start.' } }),
        ],
      });
      expect(screen.getByTestId('datalake-research-schedule-outcome').textContent).toBe('Could not start.');
    });

    it('adds no outcome line for a backlog skip or a started run', () => {
      const at = new Date('2026-03-02T00:00:00Z');
      renderPanel({
        configs: [
          config({
            id: 'a',
            cadence: 'daily',
            lastScheduledOutcome: { outcome: 'skipped', at, reason: 'review_backlog' },
          }),
          config({ id: 'b', cadence: 'daily', lastScheduledOutcome: { outcome: 'started', at, runId: 'run-1' } }),
        ],
      });
      expect(screen.queryByTestId('datalake-research-schedule-outcome')).toBeNull();
    });

    it('counts the leading run of scheduled failures, newest first', () => {
      renderPanel({
        configs: [config({ cadence: 'daily' })],
        runs: [
          run({ id: 'run-old', trigger: 'periodic', status: 'failed', startedAt: new Date('2026-03-01T00:00:00Z') }),
          run({ id: 'run-new', trigger: 'periodic', status: 'failed', startedAt: new Date('2026-03-02T00:00:00Z') }),
        ],
      });
      expect(screen.getByTestId('datalake-research-schedule-failures').textContent).toBe(
        'Last 2 scheduled runs failed'
      );
    });

    it('warns near Run now when the backlog is already at the limit, without disabling it', () => {
      renderPanel({ configs: [config()], pendingProposals: RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT });

      expect(screen.getByTestId('research-config-run-backlog-warning').textContent).toMatch(
        /already waiting for review/
      );
      expect(screen.getByTestId('datalake-research-run-btn-config-1')).not.toBeDisabled();
    });

    describe('pause and resume', () => {
      const at = new Date('2026-03-02T00:00:00Z');
      const pauseBtn = (id = 'config-1') => screen.getByTestId(`datalake-research-pause-btn-${id}`);

      it('offers Pause on a scheduled config and sends only the flag', () => {
        const spies = renderPanel({ configs: [config({ id: 'config-1', cadence: 'weekly' })] });
        expect(pauseBtn().textContent).toBe('Pause schedule');
        fireEvent.click(pauseBtn());
        expect(spies.onUpdate).toHaveBeenCalledWith('config-1', { schedulePaused: true });
      });

      it('offers Resume on a paused config and sends schedulePaused false', () => {
        const spies = renderPanel({ configs: [config({ id: 'config-1', cadence: 'weekly', schedulePaused: true })] });
        expect(pauseBtn().textContent).toBe('Resume schedule');
        fireEvent.click(pauseBtn());
        expect(spies.onUpdate).toHaveBeenCalledWith('config-1', { schedulePaused: false });
      });

      it('has no pause button when the cadence is off', () => {
        renderPanel({ configs: [config({ id: 'config-1' })] });
        expect(screen.queryByTestId('datalake-research-pause-btn-config-1')).toBeNull();
      });

      it('shows the Paused line and hides the held and outcome lines', () => {
        renderPanel({
          configs: [
            config({
              cadence: 'weekly',
              schedulePaused: true,
              reviewBacklogLimit: 5,
              lastScheduledOutcome: { outcome: 'skipped', at, reason: 'daily_cap' },
            }),
          ],
          pendingProposals: 9,
        });
        expect(screen.getByTestId('datalake-research-schedule').textContent).toBe('Paused. Runs weekly when resumed.');
        expect(screen.queryByTestId('datalake-research-schedule-held')).toBeNull();
        expect(screen.queryByTestId('datalake-research-schedule-outcome')).toBeNull();
      });

      it('shows held, not paused, for an unpaused config at its limit', () => {
        renderPanel({ configs: [config({ cadence: 'weekly', reviewBacklogLimit: 5 })], pendingProposals: 9 });
        expect(screen.getByTestId('datalake-research-schedule').textContent).toMatch(/^Runs weekly/);
        expect(screen.getByTestId('datalake-research-schedule-held')).toBeTruthy();
      });

      it('shows the normal line for an unpaused config under its limit', () => {
        renderPanel({ configs: [config({ cadence: 'weekly', reviewBacklogLimit: 5 })], pendingProposals: 1 });
        expect(screen.getByTestId('datalake-research-schedule').textContent).toMatch(/^Runs weekly/);
        expect(screen.queryByTestId('datalake-research-schedule-held')).toBeNull();
      });

      it('adds no outcome line for a schedule_paused skip, and never prints undefined', () => {
        renderPanel({
          configs: [
            config({
              cadence: 'weekly',
              lastScheduledOutcome: { outcome: 'skipped', at, reason: 'schedule_paused' },
            }),
          ],
        });
        expect(screen.queryByTestId('datalake-research-schedule-outcome')).toBeNull();
        expect(screen.getByTestId('datalake-research-panel').textContent).not.toContain('undefined');
      });
    });

    it('marks a periodic run as Scheduled in the run history', () => {
      renderPanel({ runs: [run({ trigger: 'periodic' })] });
      expect(screen.getByTestId('research-run-trigger-scheduled')).toBeTruthy();
    });

    it('does not mark an on-demand run as Scheduled', () => {
      renderPanel({ runs: [run({ trigger: 'on_demand' })] });
      expect(screen.queryByTestId('research-run-trigger-scheduled')).toBeNull();
    });
  });

  describe('quick-pick presets', () => {
    const offered = [
      { id: ChatModels.GPT4_1_MINI, label: 'GPT-4.1 mini' },
      { id: ChatModels.GPT4_1, label: 'GPT-4.1' },
    ];
    const pressed = (id: string) => screen.getByTestId(`datalake-research-preset-${id}`).getAttribute('aria-pressed');
    const advanced = () => screen.getByTestId('datalake-research-advanced');
    const noPresetPressed = () => ['quick', 'standard', 'deep'].every(id => pressed(id) !== 'true');
    const deepConfig = (overrides: Partial<IDataLakeResearchConfigResponse> = {}) =>
      config({
        model: ChatModels.GPT4_1,
        maxResults: 50,
        maxProposals: 25,
        costCeilingMicroUsd: 1_000_000,
        minRelevance: RESEARCH_MIN_RELEVANCE_DEFAULT,
        recencyDays: undefined,
        trustedDomains: [],
        reviewDomains: [],
        unlistedSources: 'review',
        allowedDomains: [],
        blockedDomains: [],
        proposedTags: [],
        ...overrides,
      });
    const fillRequired = () => {
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Weekly' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
    };

    it('opens a new configuration on Quick with the advanced levers folded away', () => {
      const spies = renderPanel({ modelOptions: offered });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));

      expect(pressed('quick')).toBe('true');
      expect(advanced()).not.toBeVisible();
      expect(screen.getByTestId('datalake-research-advanced-toggle').getAttribute('aria-expanded')).toBe('false');

      fillRequired();
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      // Quick is today's defaults, so a manager who never opens Advanced saves what they always did.
      expect(spies.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: null, maxResults: 10, maxProposals: 5, costCeilingMicroUsd: 50_000 })
      );
    });

    it('applies Standard as one choice', () => {
      const spies = renderPanel({ modelOptions: offered });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fillRequired();
      fireEvent.click(screen.getByTestId('datalake-research-preset-standard'));

      expect(pressed('standard')).toBe('true');
      expect(screen.getByTestId('datalake-research-preset-summary').textContent).toMatch(/25 search results/);
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: null, maxResults: 25, maxProposals: 10, costCeilingMicroUsd: 250_000 })
      );
    });

    it('applies Deep with its stronger judge model', () => {
      const spies = renderPanel({ modelOptions: offered });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fillRequired();
      fireEvent.click(screen.getByTestId('datalake-research-preset-deep'));

      expect(screen.getByTestId('datalake-research-max-results-input')).toHaveValue(50);
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: ChatModels.GPT4_1,
          maxResults: 50,
          maxProposals: 25,
          costCeilingMicroUsd: 1_000_000,
        })
      );
    });

    it('keeps the default judge for Deep when this deployment does not offer its model', () => {
      const spies = renderPanel({ modelOptions: [offered[0]] });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fillRequired();
      fireEvent.click(screen.getByTestId('datalake-research-preset-deep'));

      expect(pressed('deep')).toBe('true');
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onCreate).toHaveBeenCalledWith(expect.objectContaining({ model: null, maxResults: 50 }));
    });

    it('switches the picker to Custom when a lever a preset sets is edited', () => {
      renderPanel({ modelOptions: offered });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-advanced-toggle'));
      expect(advanced()).toBeVisible();

      fireEvent.change(screen.getByTestId('datalake-research-max-results-input'), { target: { value: '12' } });

      expect(noPresetPressed()).toBe(true);
      expect(screen.getByTestId('datalake-research-preset-summary').textContent).toMatch(/^Custom settings/);
    });

    it('unfolds the advanced levers from the Customize button', () => {
      renderPanel({ modelOptions: offered });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-customize-btn'));

      expect(advanced()).toBeVisible();
      expect(screen.getByTestId('datalake-research-advanced-toggle').getAttribute('aria-expanded')).toBe('true');
    });

    it('opens a saved configuration that matches a preset on that preset, folded', () => {
      renderPanel({
        modelOptions: offered,
        configs: [
          config({
            model: undefined,
            maxResults: 25,
            maxProposals: 10,
            costCeilingMicroUsd: 250_000,
            recencyDays: undefined,
            trustedDomains: [],
            reviewDomains: [],
            unlistedSources: 'review',
            allowedDomains: [],
            blockedDomains: [],
            proposedTags: [],
          }),
        ],
      });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

      expect(pressed('standard')).toBe('true');
      expect(advanced()).not.toBeVisible();
    });

    it('opens a saved configuration that matches no preset as Custom, with Advanced expanded', () => {
      renderPanel({ modelOptions: offered, configs: [config({ maxResults: 12 })] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

      expect(noPresetPressed()).toBe(true);
      expect(advanced()).toBeVisible();
    });

    it('expands Advanced for a preset-matching configuration that sets another lever', () => {
      renderPanel({
        modelOptions: offered,
        configs: [
          config({ model: ChatModels.GPT4_1_MINI, maxResults: 10, maxProposals: 5, costCeilingMicroUsd: 50_000 }),
        ],
      });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

      expect(pressed('quick')).toBe('true');
      expect(advanced()).toBeVisible();
    });

    it('does not report unsaved edits after returning to the preset a saved config already uses', () => {
      renderPanel({
        modelOptions: offered,
        configs: [
          config({ model: ChatModels.GPT4_1, maxResults: 50, maxProposals: 25, costCeilingMicroUsd: 1_000_000 }),
        ],
      });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      fireEvent.click(screen.getByTestId('datalake-research-preset-quick'));
      expect(screen.getByTestId('datalake-research-run-btn-config-1').textContent).toBe('Save changes to run');

      fireEvent.click(screen.getByTestId('datalake-research-preset-deep'));
      expect(screen.getByTestId('datalake-research-run-btn-config-1').textContent).toBe('Run now');
    });

    it('keeps Deep on its own judge while the model catalog is still loading', () => {
      const spies = renderPanel({ modelOptions: [], modelsLoading: true });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fillRequired();
      fireEvent.click(screen.getByTestId('datalake-research-preset-deep'));
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledWith(expect.objectContaining({ model: ChatModels.GPT4_1 }));
    });

    it('falls back to the default judge for Deep when the loaded catalog is empty', () => {
      const spies = renderPanel({ modelOptions: [], modelsLoading: false });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fillRequired();
      fireEvent.click(screen.getByTestId('datalake-research-preset-deep'));
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));

      expect(spies.onCreate).toHaveBeenCalledWith(expect.objectContaining({ model: null, maxResults: 50 }));
    });

    it('shows Custom with Advanced open when the catalog loads without the saved model', () => {
      const { rerender } = renderPanel({ modelOptions: [], modelsLoading: true, configs: [deepConfig()] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      expect(pressed('deep')).toBe('true');
      expect(advanced()).not.toBeVisible();

      rerender({ modelOptions: [offered[0]], modelsLoading: false, configs: [deepConfig()] });

      expect(noPresetPressed()).toBe(true);
      expect(advanced()).toBeVisible();
    });

    it('leaves Advanced folded when only the schedule changes', () => {
      renderPanel({ modelOptions: offered });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-cadence-select'));
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Weekly' }));

      expect(screen.getByTestId('datalake-research-cadence-select').textContent).toBe('Weekly');
      expect(advanced()).not.toBeVisible();
    });

    it('opens folded when the only non-default lever is a backlog limit that is not in use', () => {
      renderPanel({
        modelOptions: offered,
        configs: [
          config({
            model: undefined,
            maxResults: 10,
            maxProposals: 5,
            costCeilingMicroUsd: 50_000,
            recencyDays: undefined,
            trustedDomains: [],
            reviewDomains: [],
            unlistedSources: 'review',
            allowedDomains: [],
            blockedDomains: [],
            proposedTags: [],
            minRelevance: RESEARCH_MIN_RELEVANCE_DEFAULT,
            cadence: 'off',
            reviewBacklogLimit: RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT + 7,
          }),
        ],
      });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));

      expect(pressed('quick')).toBe('true');
      expect(advanced()).not.toBeVisible();
    });

    it('reads a default-judge config at Deep levers as Deep only when GPT-4.1 is not offered', () => {
      const { unmount } = renderPanel({ modelOptions: [offered[0]], configs: [deepConfig({ model: undefined })] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      expect(pressed('deep')).toBe('true');
      unmount();

      renderPanel({ modelOptions: offered, configs: [deepConfig({ model: undefined })] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      expect(noPresetPressed()).toBe(true);
    });

    it('keeps the advanced toggle focusable but inert while a field is invalid', () => {
      renderPanel({ modelOptions: offered });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-max-results-input'), { target: { value: '999' } });
      const toggle = screen.getByTestId('datalake-research-advanced-toggle');

      expect(toggle.getAttribute('aria-disabled')).toBe('true');
      expect(toggle).not.toBeDisabled();
      fireEvent.click(toggle);
      expect(advanced()).toBeVisible();
    });

    it('keeps an invalid advanced field in view even when folded', () => {
      renderPanel({ modelOptions: offered });
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-max-results-input'), { target: { value: '999' } });

      expect(advanced()).toBeVisible();
    });
  });

  describe('feed source', () => {
    const FEED = 'https://example.com/news/feed.xml?token=secret';
    const openCreate = () => {
      renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
    };
    const pickSource = (name: string) => {
      fireEvent.click(screen.getByTestId('datalake-research-source-select'));
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name }));
    };

    it('shows the feed address and the topic wording only once Feed is chosen', () => {
      openCreate();
      expect(screen.getByTestId('datalake-research-source-select').textContent).toBe('Web search');
      expect(screen.queryByTestId('datalake-research-feed-url-input')).toBeNull();
      expect(screen.getByText('What to look for')).toBeTruthy();

      pickSource('Feed');
      expect(screen.getByTestId('datalake-research-feed-url-input')).toBeTruthy();
      expect(screen.getByText('Topic')).toBeTruthy();
      expect(screen.getByTestId('datalake-research-query-count').textContent).toContain(
        'Each new feed item is judged against this.'
      );

      pickSource('Web search');
      expect(screen.queryByTestId('datalake-research-feed-url-input')).toBeNull();
    });

    it('requires a feed address before Save, and sends source and address once given', () => {
      const spies = renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      pickSource('Feed');
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Feed sweep' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      expect(screen.getByTestId('datalake-research-save-btn')).toBeDisabled();

      fireEvent.change(screen.getByTestId('datalake-research-feed-url-input'), { target: { value: 'not a url' } });
      expect(screen.getByTestId('datalake-research-save-btn')).toBeDisabled();

      fireEvent.change(screen.getByTestId('datalake-research-feed-url-input'), { target: { value: FEED } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onCreate).toHaveBeenCalledWith(expect.objectContaining({ source: 'feed', feedUrl: FEED }));
    });

    it('sends a null feed address for a search config', () => {
      const spies = renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.change(screen.getByTestId('datalake-research-name-input'), { target: { value: 'Sweep' } });
      fireEvent.change(screen.getByTestId('datalake-research-query-input'), { target: { value: 'erosion' } });
      fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
      expect(spies.onCreate).toHaveBeenCalledWith(expect.objectContaining({ source: 'search', feedUrl: null }));
    });

    it('loads a stored feed config into the form on Edit', () => {
      renderPanel({ configs: [config({ source: 'feed', feedUrl: FEED })] });
      fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-1'));
      expect(screen.getByTestId('datalake-research-source-select').textContent).toBe('Feed');
      expect((screen.getByTestId('datalake-research-feed-url-input') as HTMLInputElement).value).toBe(FEED);
    });

    it('shows origin and path on the config row, never the query string', () => {
      renderPanel({
        configs: [
          config({
            source: 'feed',
            feedUrl: FEED,
            feedStatus: { newestPublishedAt: new Date('2026-03-01T12:00:00.000Z'), current: true },
          }),
        ],
      });
      const row = screen.getByTestId('datalake-research-config-feed').textContent ?? '';
      expect(row).toContain('https://example.com/news/feed.xml');
      expect(row).not.toContain('token');
      expect(screen.getByTestId('datalake-research-config-feed-newest').textContent).toBe(
        `Newest item seen ${formatWhen(new Date('2026-03-01T12:00:00.000Z'))}`
      );
    });

    it('hides the newest-item line when the stored cursor is not current', () => {
      renderPanel({
        configs: [
          config({
            source: 'feed',
            feedUrl: FEED,
            feedStatus: { newestPublishedAt: new Date('2026-03-01T12:00:00.000Z'), current: false },
          }),
        ],
      });
      expect(screen.queryByTestId('datalake-research-config-feed-newest')).toBeNull();
    });

    it('shows no feed line on a search config row', () => {
      renderPanel({ configs: [config()] });
      expect(screen.queryByTestId('datalake-research-config-feed')).toBeNull();
    });

    it('words a feed run as new items, with how many are waiting', () => {
      const feedRun = run({
        levers: { ...run().levers, source: 'feed', feedUrl: FEED },
        totals: { ...emptyResearchRunTotals(), searchHits: 12, proposed: 3 },
        feedBacklog: 7,
      });
      renderPanel({ configs: [config()], runs: [feedRun] });
      const text = screen.getByTestId('datalake-research-run-totals').textContent ?? '';
      expect(text).toContain('12 new items');
      expect(text).toContain('7 waiting');
      expect(text).not.toContain('found');
    });

    it('omits "waiting" when nothing is left over, and keeps "found" for a search run', () => {
      const feedRun = run({
        levers: { ...run().levers, source: 'feed', feedUrl: FEED },
        totals: { ...emptyResearchRunTotals(), searchHits: 1 },
        feedBacklog: 0,
      });
      const { unmount } = render(
        <Wrapper>
          <DataLakeResearchPanel
            configs={[config()]}
            runs={[feedRun]}
            isLoading={false}
            error={null}
            modelOptions={[]}
            {...handlers()}
          />
        </Wrapper>
      );
      const text = screen.getByTestId('datalake-research-run-totals').textContent ?? '';
      expect(text).toContain('1 new item');
      expect(text).not.toContain('waiting');
      unmount();

      renderPanel({
        configs: [config()],
        runs: [run({ totals: { ...emptyResearchRunTotals(), searchHits: 4 } })],
      });
      expect(screen.getByTestId('datalake-research-run-totals').textContent).toContain('4 found');
    });
  });
});

describe('DataLakeResearchPanel run fix hints', () => {
  const quickConfig = (overrides: Partial<IDataLakeResearchConfigResponse> = {}) =>
    config({
      model: undefined,
      recencyDays: undefined,
      trustedDomains: [],
      reviewDomains: [],
      unlistedSources: 'review',
      allowedDomains: [],
      blockedDomains: [],
      proposedTags: [],
      ...overrides,
    });
  const totalsWith = (overrides: Partial<ReturnType<typeof emptyResearchRunTotals>>) => ({
    ...emptyResearchRunTotals(),
    searchHits: 10,
    ...overrides,
  });

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
  });

  it('opens the run config with Advanced expanded from Adjust settings', () => {
    const configs = [quickConfig({ id: 'config-a', name: 'A' }), quickConfig({ id: 'config-b', name: 'B' })];
    const first = renderPanel({ configs });
    fireEvent.click(screen.getByTestId('datalake-research-edit-btn-config-b'));
    expect(screen.getByTestId('datalake-research-advanced')).not.toBeVisible();
    first.unmount();

    renderPanel({ configs, runs: [run({ id: 'run-9', configId: 'config-b' })] });
    fireEvent.click(screen.getByTestId('datalake-research-run-adjust-run-9'));
    expect(screen.getByTestId('datalake-research-advanced')).toBeVisible();
    expect((screen.getByTestId('datalake-research-name-input') as HTMLInputElement).value).toBe('B');
  });

  it.each([
    ['belowRelevance', {}, 'datalake-research-min-relevance-input'],
    ['filteredBySource', { blockedDomains: ['spam.net'] }, 'datalake-research-blocked-input'],
    ['unlistedDropped', {}, 'datalake-research-unlisted-select'],
    ['blockedByRule', {}, 'datalake-research-rule-add'],
  ] as const)('focuses the field the %s hint names from Adjust settings', (bucket, levers, testId) => {
    renderPanel({
      configs: [quickConfig({ id: 'config-b', name: 'B' })],
      runs: [
        run({
          id: 'run-9',
          configId: 'config-b',
          levers: { ...run().levers, ...levers },
          totals: totalsWith({ filteredBySource: 1, unlistedDropped: 1, [bucket]: 6 }),
        }),
      ],
    });
    fireEvent.click(screen.getByTestId('datalake-research-run-adjust-run-9'));
    expect(document.activeElement).toBe(screen.getByTestId(testId));
  });

  it.each([
    ['cost_ceiling', 'datalake-research-cost-ceiling-input'],
    ['proposal_limit', 'datalake-research-max-proposals-input'],
  ] as const)('focuses the %s lever from Adjust settings when there is no hint', (stopReason, testId) => {
    renderPanel({
      configs: [quickConfig({ id: 'config-b', name: 'B' })],
      runs: [run({ id: 'run-9', configId: 'config-b', stopReason })],
    });
    fireEvent.click(screen.getByTestId('datalake-research-run-adjust-run-9'));
    expect(document.activeElement).toBe(screen.getByTestId(testId));
  });

  it('focuses the first rule from Adjust settings when Add rule is disabled at the cap', () => {
    renderPanel({
      configs: [
        quickConfig({
          id: 'config-b',
          name: 'B',
          itemRules: Array.from({ length: RESEARCH_ITEM_RULES_MAX }, (_, i) => ({
            condition: `rule ${i}`,
            action: 'review' as const,
          })),
        }),
      ],
      runs: [run({ id: 'run-9', configId: 'config-b', totals: totalsWith({ blockedByRule: 6 }) })],
    });
    fireEvent.click(screen.getByTestId('datalake-research-run-adjust-run-9'));
    expect(screen.getByTestId('datalake-research-rule-add')).toBeDisabled();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId('datalake-research-rule-condition-0'));
  });

  it('focuses Name from Adjust settings when the run has no lever to point at', () => {
    renderPanel({
      configs: [quickConfig({ id: 'config-b', name: 'B' })],
      runs: [run({ id: 'run-9', configId: 'config-b' })],
    });
    fireEvent.click(screen.getByTestId('datalake-research-run-adjust-run-9'));
    expect(document.activeElement).toBe(screen.getByTestId('datalake-research-name-input'));
  });

  it('hides Adjust settings when the config was deleted', () => {
    renderPanel({ configs: [quickConfig()], runs: [run({ id: 'run-9', configId: 'gone' })] });
    expect(screen.queryByTestId('datalake-research-run-adjust-run-9')).toBeNull();
  });

  it.each([
    [
      'belowRelevance',
      { minRelevance: 0.7 },
      'The largest group scored below the minimum relevance. Lower Minimum relevance (70%) in Advanced settings to keep more.',
    ],
    [
      'filteredBySource',
      { blockedDomains: ['spam.net'] },
      'The largest group came from sites on the never list, or had no usable web address. Check Never these sites in Advanced settings.',
    ],
    [
      'unlistedDropped',
      { unlistedSources: 'drop' },
      'The largest group came from sites on none of your lists, which are ignored. Check Other sites (Ignore) in Advanced settings.',
    ],
    ['blockedByRule', {}, 'The largest group was blocked by an item rule. Check Item rules in Advanced settings.'],
  ] as const)('renders a hint for the %s bucket from the run levers', (bucket, levers, expected) => {
    renderPanel({
      runs: [
        run({
          levers: { ...run().levers, ...levers },
          totals: totalsWith({ filteredBySource: 1, unlistedDropped: 1, [bucket]: 6 }),
        }),
      ],
    });
    expect(screen.getByTestId('datalake-research-run-hint').textContent).toBe(expected);
  });

  it.each(['unresolvedRedirect', 'judgeFailed', 'fetchFailed', 'alreadyInLake', 'notJudged'] as const)(
    'renders no hint when the largest bucket (%s) has no setting',
    bucket => {
      renderPanel({ runs: [run({ totals: totalsWith({ belowRelevance: 1, [bucket]: 6 }) })] });
      expect(screen.queryByTestId('datalake-research-run-hint')).toBeNull();
    }
  );

  it('renders no hint for a run with no drops', () => {
    renderPanel({ runs: [run({ totals: totalsWith({ proposed: 4 }) })] });
    expect(screen.queryByTestId('datalake-research-run-hint')).toBeNull();
  });

  it('renders no hint when the largest bucket is filteredBySource but the Never list is empty', () => {
    renderPanel({
      runs: [
        run({
          levers: { ...run().levers, blockedDomains: [] },
          totals: totalsWith({ filteredBySource: 6, unlistedDropped: 1 }),
        }),
      ],
    });
    expect(screen.queryByTestId('datalake-research-run-hint')).toBeNull();
  });

  it('renders no hint on a judge-outage run even when source drops are the largest bucket', () => {
    renderPanel({
      runs: [
        run({
          status: 'failed',
          stopReason: 'judge_unavailable',
          levers: { ...run().levers, unlistedSources: 'drop' },
          totals: totalsWith({ unlistedDropped: 7, judgeFailed: 3 }),
        }),
      ],
    });
    expect(screen.queryByTestId('datalake-research-run-hint')).toBeNull();
  });

  it.each([
    ['saving', { savingConfigId: 'config-b' }],
    ['deleting', { deletingConfigId: 'config-b' }],
  ] as const)('disables Adjust settings while its config is %s', (_label, busyProps) => {
    renderPanel({
      configs: [quickConfig({ id: 'config-a', name: 'A' }), quickConfig({ id: 'config-b', name: 'B' })],
      runs: [run({ id: 'run-9', configId: 'config-b' }), run({ id: 'run-8', configId: 'config-a' })],
      ...busyProps,
    });
    expect((screen.getByTestId('datalake-research-run-adjust-run-9') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('datalake-research-run-adjust-run-8') as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders no hint when a run stored before the split cannot say which list dropped hits', () => {
    const { unlistedDropped: _omitted, ...legacy } = totalsWith({ filteredBySource: 6 });
    renderPanel({ runs: [run({ totals: legacy })] });
    expect(screen.queryByTestId('datalake-research-run-hint')).toBeNull();
  });

  it.each([
    ['cost_ceiling', /^Stopped at the cost ceiling for one run\. Raise Cost ceiling in Advanced settings/],
    ['proposal_limit', /^Reached the proposals limit for one run\. Raise Proposals per run in Advanced settings/],
    ['time_budget', /^Stopped at the time limit for one run\. The rest are checked next run\.$/],
    ['judge_unavailable', /No setting applies/],
  ] as const)('words the %s stop reason as a setting or as no setting', (stopReason, expected) => {
    renderPanel({ runs: [run({ stopReason })] });
    expect(screen.getByTestId('datalake-research-run-stop-reason').textContent).toMatch(expected);
  });
});

describe('DataLakeResearchPanel usability copy', () => {
  const editConfig = (id = 'config-1') => fireEvent.click(screen.getByTestId(`datalake-research-edit-btn-${id}`));
  const saveEdit = () => fireEvent.click(screen.getByTestId('datalake-research-save-btn'));
  const relevanceInput = () => screen.getByTestId('datalake-research-min-relevance-input') as HTMLInputElement;

  describe('relevance as a percent', () => {
    it('shows the stored value at one decimal of a percent', () => {
      renderPanel({ configs: [config({ minRelevance: 0.637 })] });
      editConfig();
      expect(relevanceInput().value).toBe('63.7');
    });

    it('saves an unedited stored value unchanged', () => {
      const spies = renderPanel({ configs: [config({ minRelevance: 0.123456 })] });
      editConfig();
      saveEdit();
      expect(spies.onUpdate).toHaveBeenCalledWith('config-1', expect.objectContaining({ minRelevance: 0.123456 }));
    });

    it('saves an edited percent as a fraction', () => {
      const spies = renderPanel({ configs: [config({ minRelevance: 0.637 })] });
      editConfig();
      fireEvent.change(relevanceInput(), { target: { value: '61.5' } });
      saveEdit();
      expect(spies.onUpdate).toHaveBeenCalledWith('config-1', expect.objectContaining({ minRelevance: 0.615 }));
    });

    it('rejects an old-scale fraction and tells the user what to type', () => {
      const spies = renderPanel({ configs: [config()] });
      editConfig();
      fireEvent.change(relevanceInput(), { target: { value: '0.6' } });
      expect(screen.getByText('Enter a percent, for example 60')).toBeTruthy();
      expect(screen.getByTestId('datalake-research-save-btn')).toBeDisabled();
      saveEdit();
      expect(spies.onUpdate).not.toHaveBeenCalled();
    });

    it('accepts zero and rejects a value above 100', () => {
      renderPanel({ configs: [config()] });
      editConfig();
      fireEvent.change(relevanceInput(), { target: { value: '0' } });
      expect(screen.getByTestId('datalake-research-save-btn')).not.toBeDisabled();
      fireEvent.change(relevanceInput(), { target: { value: '101' } });
      expect(screen.getByText('Enter a percent from 0 to 100.')).toBeTruthy();
    });
  });

  describe('schedule line', () => {
    const at = new Date('2026-03-02T00:00:00Z');
    const line = () => screen.getByTestId('datalake-research-schedule').textContent;

    it('reads the normal state with the next day and the hold threshold', () => {
      renderPanel({
        configs: [config({ cadence: 'weekly', nextRunAt: new Date('2026-12-03T12:00:00Z'), reviewBacklogLimit: 25 })],
        pendingProposals: 1,
      });
      expect(line()).toMatch(/^Runs weekly\. Next run: .*3.*\. Held while 25 or more proposals are waiting\.$/);
      expect(screen.queryByTestId('datalake-research-review-proposals-link')).toBeNull();
    });

    it('says when the next run is not set yet', () => {
      renderPanel({ configs: [config({ cadence: 'daily', nextRunAt: null })] });
      expect(line()).toMatch(/^Runs daily\. Next run: when you save a schedule\./);
    });

    it('reads the held state with a link that opens the proposals', () => {
      const onReviewProposals = vi.fn();
      renderPanel({
        configs: [config({ cadence: 'weekly', reviewBacklogLimit: 25 })],
        pendingProposals: 30,
        onReviewProposals,
      });
      expect(screen.getByTestId('datalake-research-schedule-held').textContent).toBe(
        'Held: 30 proposals are waiting. Scheduled runs resume when fewer than 25 are waiting. Review proposals'
      );
      fireEvent.click(screen.getByTestId('datalake-research-review-proposals-link'));
      expect(onReviewProposals).toHaveBeenCalledTimes(1);
    });

    it('shows no link when the host cannot open the proposals', () => {
      renderPanel({ configs: [config({ cadence: 'weekly', reviewBacklogLimit: 5 })], pendingProposals: 9 });
      expect(screen.getByTestId('datalake-research-schedule-held')).toBeTruthy();
      expect(screen.queryByTestId('datalake-research-review-proposals-link')).toBeNull();
    });

    it('reads the paused state, which hides the held line and its link', () => {
      renderPanel({
        configs: [config({ cadence: 'weekly', schedulePaused: true, reviewBacklogLimit: 5 })],
        pendingProposals: 9,
        onReviewProposals: vi.fn(),
      });
      expect(line()).toBe('Paused. Runs weekly when resumed.');
      expect(screen.queryByTestId('datalake-research-review-proposals-link')).toBeNull();
    });

    it('names the last failure reason of a scheduled run', () => {
      renderPanel({
        configs: [config({ cadence: 'daily', lastScheduledOutcome: { outcome: 'started', at, runId: 'run-1' } })],
        runs: [
          run({
            id: 'a',
            trigger: 'periodic',
            status: 'failed',
            error: 'Old reason',
            startedAt: new Date('2026-03-01'),
          }),
          run({ id: 'b', trigger: 'periodic', status: 'failed', error: 'Feed was unreachable', startedAt: at }),
        ],
      });
      expect(screen.getByTestId('datalake-research-schedule-failures').textContent).toBe(
        'Last 2 scheduled runs failed. The latest: Feed was unreachable'
      );
    });

    it('names the reason for a single failure and omits it when the run has none', () => {
      const { unmount } = renderPanel({
        configs: [config({ cadence: 'daily' })],
        runs: [run({ trigger: 'periodic', status: 'failed', error: 'Feed was unreachable' })],
      });
      expect(screen.getByTestId('datalake-research-schedule-failures').textContent).toBe(
        'Last scheduled run failed: Feed was unreachable'
      );
      unmount();
      renderPanel({
        configs: [config({ cadence: 'daily' })],
        runs: [run({ trigger: 'periodic', status: 'failed', error: null })],
      });
      expect(screen.getByTestId('datalake-research-schedule-failures').textContent).toBe('Last scheduled run failed');
    });
  });

  describe('run status chip', () => {
    it.each([
      ['a run that covered everything', { stopReason: 'exhausted' as const }, 'Finished'],
      ['a run that hit its cost ceiling', { stopReason: 'cost_ceiling' as const }, 'Stopped early'],
      ['a run that failed', { status: 'failed' as const }, 'Failed'],
      ['a queued run', { status: 'queued' as const, startedAt: undefined, createdAt: new Date() }, 'Queued'],
    ])('says %s in words', (_label, overrides, expected) => {
      renderPanel({ runs: [run(overrides)] });
      expect(screen.getByTestId('datalake-research-run-status').textContent).toBe(expected);
    });
  });

  describe('cost helper', () => {
    const openNew = () => {
      renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
    };

    it('names who pays and that approving a proposal also costs indexing', () => {
      openNew();
      const text = screen
        .getByTestId('datalake-research-cost-ceiling-input')
        .closest('.MuiFormControl-root')?.textContent;
      expect(text).toContain("paid from the lake owner's credits (their organization's pool if they belong to one)");
      expect(text).toContain('Approving a proposal also costs indexing.');
    });

    it('shows no monthly figure without a schedule', () => {
      openNew();
      expect(screen.queryByTestId('datalake-research-monthly-cost')).toBeNull();
    });

    it.each([
      ['Daily', '$7.75'],
      ['Weekly', '$1.25'],
      ['Monthly', '$0.25'],
    ] as const)('shows roughly the most a %s schedule can cost in a month', (label, amount) => {
      openNew();
      fireEvent.change(screen.getByTestId('datalake-research-cost-ceiling-input'), { target: { value: '0.25' } });
      fireEvent.click(screen.getByTestId('datalake-research-cadence-select'));
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: label }));
      expect(screen.getByTestId('datalake-research-monthly-cost').textContent).toBe(
        `Roughly up to ${amount} a month at this schedule.`
      );
    });
  });

  describe('site lists', () => {
    it('orders trusted sites, the auto-add switch, sites to review, never, then other sites in one group', () => {
      renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      const group = screen.getByTestId('datalake-research-sites-group');
      expect(within(group).getByText('Which sites to use')).toBeTruthy();
      const order = [
        'datalake-research-trusted-input',
        'datalake-research-auto-admit-toggle',
        'datalake-research-review-input',
        'datalake-research-blocked-input',
        'datalake-research-unlisted-select',
      ].map(id => within(group).getByTestId(id));
      order.slice(1).forEach((el, i) => {
        expect(order[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      });
    });

    it('says why the auto-add switch is disabled until a trusted site is listed', () => {
      renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      expect(screen.getByTestId('datalake-research-auto-admit-toggle')).toBeDisabled();
      expect(screen.getByTestId('datalake-research-auto-admit-disabled-reason').textContent).toBe(
        'Add a trusted site above to turn this on.'
      );
      fireEvent.change(screen.getByTestId('datalake-research-trusted-input'), { target: { value: 'example.com' } });
      expect(screen.queryByTestId('datalake-research-auto-admit-disabled-reason')).toBeNull();
    });
  });

  describe('phone width and test ids', () => {
    it('lets the item-rule row wrap', () => {
      renderPanel();
      fireEvent.click(screen.getByTestId('datalake-research-new-btn'));
      fireEvent.click(screen.getByTestId('datalake-research-rule-add'));
      expect(screen.getByTestId('datalake-research-rule-row-0')).toHaveStyle({ flexWrap: 'wrap' });
    });

    it('suffixes the card buttons with the config id so each card has its own', () => {
      renderPanel({ configs: [config({ id: 'a' }), config({ id: 'b', name: 'Other' })] });
      for (const kind of ['run', 'edit', 'delete']) {
        expect(screen.getByTestId(`datalake-research-${kind}-btn-a`)).toBeTruthy();
        expect(screen.getByTestId(`datalake-research-${kind}-btn-b`)).toBeTruthy();
      }
    });
  });
});
