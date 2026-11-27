import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { FunctionContract, ICallableFunctionPublic } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  promote: { mutate: vi.fn(), isPending: false },
  setExamples: { mutate: vi.fn(), isPending: false },
  calls: { data: undefined as unknown, isError: false },
  callsFor: vi.fn(),
  stopSharing: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/hooks/data/callableFunctions', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/callableFunctions')>()),
  usePromoteCallableFunction: () => h.promote,
  useSetCallableFunctionExamples: () => h.setExamples,
  useCallableFunctionCalls: (id: string) => {
    h.callsFor(id);
    return h.calls;
  },
  useStopSharingCallableFunction: () => h.stopSharing,
}));
vi.mock('../ShareFunctionDialog', () => ({
  default: ({ tool, dataPins, sources }: { tool: { slug: string }; dataPins: string[]; sources: string[] }) => (
    <div
      data-testid="python-function-share-dialog"
      data-data-pins={dataPins.join(',')}
      data-sources={sources.join(',')}
    >
      {tool.slug}
    </div>
  ),
}));

import PromoteFunctionSection from '../PromoteFunctionSection';

const appTheme = extendTheme({ ...getThemeConfig() });

const CONTRACT: FunctionContract = {
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['span'],
    properties: { span: { type: 'number', unit: 'm' } },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
};

const EXAMPLE = {
  name: 'handbook case',
  input: { span: 3 },
  expected: { deflection: 6 },
  tolerance: { rel: 1e-9 },
  citation: 'https://data.example.com/beams/table-3',
};

const tool = (overrides: Partial<ICallableFunctionPublic> = {}): ICallableFunctionPublic =>
  ({
    id: 'fn-1',
    slug: CONTRACT.name,
    description: CONTRACT.description,
    status: 'draft',
    state: 'draft',
    enabled: true,
    pin: { artifactId: 'artifact-1', version: 3, contentHash: 'a'.repeat(64), pinnedAt: new Date() },
    latestVersion: 3,
    updateAvailable: false,
    trustLabel: null,
    examples: [],
    dataPins: [],
    grants: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ICallableFunctionPublic;

const live = (trustLabel: 'platform' | 'verified' | 'unverified', seq = 2) =>
  tool({
    state: 'live',
    status: 'live',
    trustLabel,
    pin: { artifactId: 'artifact-1', version: 3, contentHash: 'a'.repeat(64), pinnedAt: new Date(), seq },
  });

const renderSection = (view: ICallableFunctionPublic, blocked: string | null = null) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <PromoteFunctionSection tool={view} contract={CONTRACT} blocked={blocked} />
    </CssVarsProvider>
  );

const axiosError = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

beforeEach(() => {
  h.promote = { mutate: vi.fn(), isPending: false };
  h.setExamples = { mutate: vi.fn(), isPending: false };
  h.calls = { data: { since: new Date(), total: 0, outcomes: {}, recent: [] }, isError: false };
  h.callsFor.mockReset();
  h.stopSharing = { mutate: vi.fn(), isPending: false };
});

describe('sharing', () => {
  it('a draft cannot be shared', () => {
    renderSection(tool());
    expect(screen.getByTestId('python-function-share-btn')).toBeDisabled();
    expect(screen.getByTestId('python-function-share-status').textContent).toContain('Promote the tool to share it.');
  });

  it('a live tool opens the share dialog', () => {
    renderSection(live('verified'));
    expect(screen.getByTestId('python-function-share-status').textContent).toBe('Not shared.');
    expect(screen.queryByTestId('python-function-share-stop-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('python-function-share-btn'));
    expect(screen.getByTestId('python-function-share-dialog').textContent).toBe(CONTRACT.name);
  });

  it('hands the share dialog the names of the data files and the live and pinned sources', () => {
    renderSection({
      ...live('verified'),
      dataPins: [{ name: 'factors.csv', sha256: 'b'.repeat(64), bytes: 46, pinnedAt: new Date() }],
      sources: [
        { name: 'rates.csv', url: 'https://data.example.com/rates.csv', mode: 'live' },
        { name: 'base.csv', url: 'https://data.example.com/base.csv', mode: 'pinned' },
      ],
    });
    fireEvent.click(screen.getByTestId('python-function-share-btn'));
    const dialog = screen.getByTestId('python-function-share-dialog');
    expect(dialog.getAttribute('data-data-pins')).toBe('factors.csv');
    expect(dialog.getAttribute('data-sources')).toBe('rates.csv,base.csv');
  });

  it('a shared tool says with whom and stops sharing', () => {
    renderSection({
      ...live('unverified'),
      grants: { visibility: 'organization', organizationId: 'org-1', userIds: ['p-1', 'p-2'] },
    });
    expect(screen.getByTestId('python-function-share-status').textContent).toBe(
      'Shared with 2 people and the members of an organization.'
    );
    fireEvent.click(screen.getByTestId('python-function-share-stop-btn'));
    expect(h.stopSharing.mutate).toHaveBeenCalledWith('fn-1', expect.anything());
    expect(screen.queryByTestId('python-function-share-stop-error')).toBeNull();
  });

  it("shows why Stop sharing failed, in the server's words", () => {
    h.stopSharing.mutate.mockImplementation((_id: string, handlers: { onError: (error: unknown) => void }) =>
      handlers.onError(axiosError(404, { error: 'Tool not found', code: 'not_found' }))
    );
    renderSection({ ...live('verified'), grants: { visibility: 'private', userIds: ['p-1'] } });
    fireEvent.click(screen.getByTestId('python-function-share-stop-btn'));
    expect(screen.getByTestId('python-function-share-stop-error').textContent).toContain('Tool not found');
  });

  it('a private share whose people were all erased reads as not shared', () => {
    renderSection({ ...live('verified'), grants: { visibility: 'private', userIds: [] } });
    expect(screen.getByTestId('python-function-share-status').textContent).toBe('Not shared.');
    expect(screen.getByTestId('python-function-share-btn').textContent).toBe('Share');
    expect(screen.queryByTestId('python-function-share-stop-btn')).toBeNull();
  });

  it('a repinned draft that still has a share says promoting shares it again', () => {
    renderSection(tool({ grants: { visibility: 'private', userIds: ['p-1'] } }));
    expect(screen.getByTestId('python-function-share-status').textContent).toBe(
      'Paused until the next promotion, which shares it again.'
    );
  });

  it('a draft with no share keeps the promote line', () => {
    renderSection(tool({ grants: null }));
    expect(screen.getByTestId('python-function-share-status').textContent).toBe(
      'Promote the tool to share it. A share covers the live version.'
    );
  });
});

describe('PromoteFunctionSection', () => {
  it('a draft shows Promote and no label; Promote promotes this tool', () => {
    renderSection(tool());
    expect(screen.queryByTestId('python-function-trust-chip')).toBeNull();
    expect(screen.getByTestId('python-function-promote-status').textContent).toContain('A draft.');
    const promote = screen.getByTestId('python-function-promote-btn');
    expect(promote.textContent).toBe('Promote');
    fireEvent.click(promote);
    expect(h.promote.mutate).toHaveBeenCalledWith('fn-1', expect.anything());
  });

  it("shows a refusal's reason, naming the field", () => {
    h.promote.mutate.mockImplementation((_id: string, handlers: { onError: (error: unknown) => void }) =>
      handlers.onError(
        axiosError(409, {
          error:
            'Output stress was removed since promotion 1, which could break callers of the tool. Save this version as a new tool instead.',
          code: 'breaking_change',
        })
      )
    );
    renderSection(tool());
    fireEvent.click(screen.getByTestId('python-function-promote-btn'));
    const refusal = screen.getByTestId('python-function-promote-refusal');
    expect(refusal.textContent).toContain('Not promoted');
    expect(refusal.textContent).toContain('Output stress was removed since promotion 1');
  });

  it.each([
    ['platform', 'Platform: curated and checked by Bike4Mind.'],
    ['verified', 'A cited worked example passed on the server.'],
    ['unverified', 'Only declared tests ran on the server.'],
  ] as const)('a live tool shows the %s chip and its promotion', (label, help) => {
    renderSection(live(label));
    expect(screen.getByTestId('python-function-trust-chip').textContent).toBe(label);
    const status = screen.getByTestId('python-function-promote-status').textContent;
    expect(status).toContain('Live at promotion 2.');
    expect(status).toContain(help);
    expect(screen.getByTestId('python-function-promote-btn').textContent).toBe('Promote again');
  });

  it('a blocked tool keeps Promote disabled and says why', () => {
    renderSection(tool(), 'Turn the tool on to promote it.');
    expect((screen.getByTestId('python-function-promote-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('python-function-promote-blocked').textContent).toBe('Turn the tool on to promote it.');
  });

  it("lists the function's calls of the last 30 days: the count, the outcomes, and the latest with time, outcome, and caller", () => {
    h.calls = {
      isError: false,
      data: {
        since: new Date(),
        total: 3,
        outcomes: { ok: 2, timeout: 1 },
        recent: [
          { id: 'c1', startedAt: '2026-11-23T10:00:00.000Z', outcome: 'ok', surface: 'test', byRecipient: true },
          { id: 'c2', startedAt: '2026-11-22T10:00:00.000Z', outcome: 'timeout', surface: 'test', byRecipient: false },
        ],
      },
    };
    renderSection(live('verified'));
    expect(h.callsFor).toHaveBeenCalledWith('fn-1');
    expect(screen.getByTestId('python-function-calls-total').textContent).toBe('3 calls: Returned 2, Timed out 1.');
    const rows = screen.getAllByTestId('python-function-call-row');
    expect(rows.map(row => within(row).getAllByRole('cell')[1]!.textContent)).toEqual(['Returned', 'Timed out']);
    expect(rows.map(row => within(row).getAllByRole('cell')[2]!.textContent)).toEqual([
      'A recipient',
      'You, a test on the server',
    ]);
    expect(rows[0]!.textContent).toContain('2026');
    expect(screen.getByTestId('python-function-calls-note').textContent).toBe(
      'Call function on the Function tab runs in your browser and is not listed here.'
    );
  });

  it('shows the promotion that ran, how long it took, and the API key the owner called with, never a recipient', () => {
    const at = '2026-11-23T10:00:00.000Z';
    h.calls = {
      isError: false,
      data: {
        since: new Date(),
        total: 6,
        outcomes: { ok: 4, cancelled: 1, refused: 1 },
        recent: [
          {
            id: 'c1',
            startedAt: at,
            outcome: 'ok',
            surface: 'rest',
            byRecipient: false,
            pinSeq: 3,
            durationMs: 42,
            apiKey: { name: 'nightly-batch' },
          },
          { id: 'c2', startedAt: at, outcome: 'ok', surface: 'mcp', byRecipient: true, pinSeq: 3, durationMs: 2300 },
          {
            id: 'c3',
            startedAt: at,
            outcome: 'ok',
            surface: 'rest',
            byRecipient: false,
            pinSeq: 2,
            durationMs: 125_000,
            apiKey: { name: null },
          },
          { id: 'c4', startedAt: at, outcome: 'ok', surface: 'chat', byRecipient: false, pinSeq: 2, durationMs: 900 },
          { id: 'c5', startedAt: at, outcome: 'cancelled', surface: 'rest', byRecipient: false, durationMs: 4 },
          { id: 'c6', startedAt: at, outcome: 'refused', surface: 'rest', byRecipient: false, durationMs: 1 },
        ],
      },
    };
    renderSection(live('verified'));
    expect(screen.getByTestId('python-function-calls-total').textContent).toBe(
      '6 calls: Returned 4, Cancelled 1, Refused 1.'
    );
    const cells = screen.getAllByTestId('python-function-call-row').map(row =>
      within(row)
        .getAllByRole('cell')
        .map(cell => cell.textContent)
    );
    expect(cells.map(([, outcome, by, promotion, duration]) => [outcome, by, promotion, duration])).toEqual([
      ['Returned', 'You, with API key "nightly-batch"', '3', '42 ms'],
      ['Returned', 'A recipient', '3', '2.3 s'],
      ['Returned', 'You, with a deleted API key', '2', '2 min 5 s'],
      ['Returned', 'You', '2', '900 ms'],
      ['Cancelled', 'You', '-', '-'],
      ['Refused', 'You', '-', '1 ms'],
    ]);
  });

  it('rounds a call duration before choosing its unit, so just under a minute shows as 1 min 0 s, never 60.0 s', () => {
    const durations = [999, 1000, 59_940, 59_949, 59_950, 59_960, 60_000, 60_499, 60_500];
    h.calls = {
      isError: false,
      data: {
        since: new Date(),
        total: durations.length,
        outcomes: { ok: durations.length },
        recent: durations.map((durationMs, i) => ({
          id: `c${i}`,
          startedAt: '2026-11-23T10:00:00.000Z',
          outcome: 'ok',
          surface: 'rest',
          byRecipient: false,
          pinSeq: 1,
          durationMs,
        })),
      },
    };
    renderSection(live('verified'));
    const shown = screen
      .getAllByTestId('python-function-call-row')
      .map(row => within(row).getAllByRole('cell')[4]!.textContent);
    expect(shown).toEqual([
      '999 ms',
      '1.0 s',
      '59.9 s',
      '59.9 s',
      '1 min 0 s',
      '1 min 0 s',
      '1 min 0 s',
      '1 min 0 s',
      '1 min 1 s',
    ]);
  });

  it('says so when there are no calls', () => {
    renderSection(tool());
    expect(screen.getByTestId('python-function-calls-total').textContent).toBe('No calls.');
    expect(screen.queryByTestId('python-function-calls-recent')).toBeNull();
  });

  it('adds a cited worked example to the ones already saved', () => {
    renderSection(tool({ examples: [EXAMPLE] }));
    fireEvent.click(screen.getByTestId('python-function-example-add-btn'));
    type('python-function-example-name', '4 m beam');
    type('python-function-example-input', '{"span": 4}');
    type('python-function-example-expected', '{"deflection": 8}');
    type('python-function-example-rel', '0.001');
    type('python-function-example-citation', 'https://data.example.com/beams/table-4');
    fireEvent.click(screen.getByTestId('python-function-example-save-btn'));
    expect(h.setExamples.mutate).toHaveBeenCalledWith(
      {
        id: 'fn-1',
        examples: [
          EXAMPLE,
          {
            name: '4 m beam',
            input: { span: 4 },
            expected: { deflection: 8 },
            tolerance: { rel: 0.001 },
            citation: 'https://data.example.com/beams/table-4',
          },
        ],
      },
      expect.anything()
    );
  });

  it('will not save an example without a citation', () => {
    renderSection(tool());
    fireEvent.click(screen.getByTestId('python-function-example-add-btn'));
    type('python-function-example-name', '4 m beam');
    fireEvent.click(screen.getByTestId('python-function-example-save-btn'));
    expect(screen.getByTestId('python-function-example-problem').textContent).toBe(
      'Cite a source a reader can check the expected output against.'
    );
    expect(h.setExamples.mutate).not.toHaveBeenCalled();
  });

  it('edits and removes a saved example', () => {
    renderSection(tool({ examples: [EXAMPLE] }));
    expect(screen.getByTestId('python-function-example-citation-text').textContent).toBe(EXAMPLE.citation);
    fireEvent.click(screen.getByTestId('python-function-example-edit-btn'));
    type('python-function-example-expected', '{"deflection": 6.5}');
    fireEvent.click(screen.getByTestId('python-function-example-save-btn'));
    expect(h.setExamples.mutate).toHaveBeenLastCalledWith(
      { id: 'fn-1', examples: [{ ...EXAMPLE, expected: { deflection: 6.5 } }] },
      expect.anything()
    );
    fireEvent.click(screen.getByTestId('python-function-example-remove-btn'));
    expect(h.setExamples.mutate).toHaveBeenLastCalledWith({ id: 'fn-1', examples: [] }, expect.anything());
  });

  it('keeps an absolute tolerance the form does not show when an example is edited', () => {
    const both = { ...EXAMPLE, tolerance: { abs: 0.001, rel: 1e-9 } };
    renderSection(tool({ examples: [both] }));
    fireEvent.click(screen.getByTestId('python-function-example-edit-btn'));
    type('python-function-example-rel', '');
    fireEvent.click(screen.getByTestId('python-function-example-save-btn'));
    expect(h.setExamples.mutate).toHaveBeenLastCalledWith(
      { id: 'fn-1', examples: [{ ...both, tolerance: { abs: 0.001 } }] },
      expect.anything()
    );
  });

  it('says how many cases have passed and which are left when the budget ran out, asking to promote again', () => {
    h.promote.mutate.mockImplementation((_id: string, handlers: { onError: (error: unknown) => void }) =>
      handlers.onError(
        axiosError(409, {
          error: '2 of 3 cases have passed on the server for this version. Promote again to run the other 1.',
          code: 'cases_left',
          passed: 2,
          total: 3,
          left: [
            { kind: 'test', name: 'long span' },
            { kind: 'example', name: 'second case' },
          ],
        })
      )
    );
    renderSection(tool());
    fireEvent.click(screen.getByTestId('python-function-promote-btn'));
    expect(screen.queryByTestId('python-function-promote-refusal')).toBeNull();
    const left = screen.getByTestId('python-function-promote-cases-left');
    expect(left.textContent).toContain('Not promoted yet');
    expect(left.textContent).toContain('2 of 3 cases have passed on the server for this version.');
    expect(left.textContent).toContain('Promote again to run the other 1.');
    expect(left.textContent).toContain('Still to run: long span, second case (worked example)');
  });

  it("lists the server's problems with an example", () => {
    h.setExamples.mutate.mockImplementation((_body: unknown, handlers: { onError: (error: unknown) => void }) =>
      handlers.onError(
        axiosError(400, {
          error: 'The worked examples have problems.',
          code: 'invalid_examples',
          problems: [{ path: 'examples.0.expected.peak', message: 'is not an output of the contract' }],
        })
      )
    );
    renderSection(tool({ examples: [EXAMPLE] }));
    fireEvent.click(screen.getByTestId('python-function-example-remove-btn'));
    expect(screen.getByText(/examples\.0\.expected\.peak/)).toBeTruthy();
  });
});
