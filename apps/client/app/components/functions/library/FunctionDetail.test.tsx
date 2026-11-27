import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { FunctionContract, ICallableFunctionPublic, ICallableFunctionShared } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  enabled: true,
  mine: { data: [] as unknown[] | undefined, isPending: false, error: null as unknown },
  shared: { data: [] as unknown[] | undefined, isPending: false, error: null as unknown },
  detail: { data: undefined as unknown, isPending: false },
  detailFor: vi.fn(),
  callsFor: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/hooks/data/callableFunctions', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/callableFunctions')>()),
  useCallableFunctionsEnabled: () => h.enabled,
  useCallableFunctionList: () => h.mine,
  useSharedCallableFunctions: () => h.shared,
  useCallableFunctionDetail: (id: string | null) => {
    h.detailFor(id);
    return h.detail;
  },
  useCallableFunctionCalls: (id: string) => {
    h.callsFor(id);
    return { data: { total: 0, outcomes: {}, recent: [] }, isError: false };
  },
  useReviewSharedCallableFunction: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSharedCallableFunctionReview: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/components/Knowledge/ShareFunctionDialog', () => ({ default: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: function Link({ to, children, ...rest }: { to: string; children?: React.ReactNode }) {
    return (
      <a href={to} {...rest}>
        {children}
      </a>
    );
  },
}));

import { FunctionDetail } from './FunctionDetail';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderDetail = (id: string) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <FunctionDetail id={id} />
    </CssVarsProvider>
  );

const CONTRACT: FunctionContract = {
  name: 'beam_deflection',
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

const OWN = {
  id: 'fn-own',
  slug: 'beam_deflection',
  description: CONTRACT.description,
  status: 'live',
  state: 'live',
  trustLabel: 'platform',
  pin: { artifactId: 'artifact-1', version: 3, contentHash: 'a'.repeat(64), pinnedAt: new Date(), seq: 2 },
  dataPins: [{ name: 'loads.csv', sha256: 'b'.repeat(64), bytes: 46, pinnedAt: new Date() }],
  sources: [{ name: 'rates.csv', url: 'https://data.example.com/rates.csv', mode: 'live' }],
} as unknown as ICallableFunctionPublic;

const SHARED = {
  id: 'fn-shared',
  slug: 'pipe_flow',
  description: 'Pressure drop along a pipe.',
  status: 'pending_review',
  sharedVia: 'person',
  pin: { version: 5, seq: 2, pinnedAt: new Date() },
  trustLabel: 'verified',
  ownerName: 'Avery Owner',
  inputs: CONTRACT.inputs,
  outputs: CONTRACT.outputs,
  reviewHash: 'd'.repeat(64),
  review: null,
  dataPins: ['loads.csv'],
  sources: ['rates.csv'],
  updatedAt: new Date(),
} as ICallableFunctionShared;

beforeEach(() => {
  h.enabled = true;
  h.mine = { data: [OWN], isPending: false, error: null };
  h.shared = { data: [SHARED], isPending: false, error: null };
  h.detail = {
    data: { ...OWN, contract: CONTRACT, source: 'def run():\n    return {}', lastServerRun: null },
    isPending: false,
  };
  h.detailFor.mockReset();
  h.callsFor.mockReset();
});

describe('FunctionDetail', () => {
  it("shows the owner the contract, label, owner, data, calls, and a link to the function's artifact", () => {
    renderDetail('fn-own');
    const view = screen.getByTestId('function-detail-own');
    expect(within(view).getByText('beam_deflection')).toBeTruthy();
    expect(within(screen.getByTestId('function-detail-inputs')).getByText('span')).toBeTruthy();
    expect(within(screen.getByTestId('function-detail-outputs')).getByText('deflection')).toBeTruthy();
    expect(screen.getByTestId('function-detail-label').textContent).toContain(
      'Platform: curated and checked by Bike4Mind.'
    );
    expect(screen.getByTestId('function-detail-owner').textContent).toBe('You');
    expect(screen.getByTestId('function-detail-data').textContent).toContain('Data file: loads.csv');
    expect(screen.getByTestId('function-detail-data').textContent).toContain(
      'Source: rates.csv (https://data.example.com/rates.csv)'
    );
    expect(screen.getByTestId('python-function-calls')).toBeTruthy();
    expect(h.callsFor).toHaveBeenCalledWith('fn-own');
    expect(screen.getByTestId('function-detail-artifact-link').getAttribute('href')).toBe('/artifacts/artifact-1');
    expect(screen.getByTestId('function-detail-artifact-note').textContent).toBe(
      'To edit, promote, or share it, open the artifact in the chat it was made in.'
    );
  });

  it('shows a recipient the review, never the source, the artifact, or a data or source link', () => {
    renderDetail('fn-shared');
    expect(screen.queryByTestId('function-detail-own')).toBeNull();
    const card = screen.getByTestId('shared-function-review-card');
    expect(within(screen.getByTestId('shared-function-inputs')).getByText('span')).toBeTruthy();
    expect(screen.getByTestId('shared-function-label').textContent).toMatch(/^Verified/);
    expect(screen.getByTestId('shared-function-owner').textContent).toBe('Avery Owner');
    expect(screen.getAllByTestId('shared-function-data-item').map(item => item.textContent)).toEqual([
      'Data file: loads.csv',
      'Source: rates.csv',
    ]);
    expect(screen.getByTestId('shared-function-review-btn').textContent).toBe('Allow calls');
    expect(card.querySelectorAll('a')).toHaveLength(0);
    expect(screen.queryByTestId('function-detail-artifact-link')).toBeNull();
    expect(screen.queryByTestId('python-function-calls')).toBeNull();
    expect(document.body.textContent).not.toContain('def run');
    expect(document.body.textContent).not.toContain('https://');
    expect(h.detailFor).not.toHaveBeenCalled();
  });

  it('says so for a function the person neither owns nor received', () => {
    renderDetail('fn-elsewhere');
    expect(screen.getByTestId('function-detail-not-found')).toBeTruthy();
  });

  it('shows nothing while callable functions are off', () => {
    h.enabled = false;
    renderDetail('fn-own');
    expect(screen.getByTestId('function-detail-off')).toBeTruthy();
  });

  it('says the load failed, not that the function is missing, when the lists fail to load', () => {
    h.mine = { data: undefined, isPending: false, error: new Error('boom') };
    renderDetail('fn-own');
    expect(screen.getByTestId('function-detail-error')).toBeTruthy();
    expect(screen.queryByTestId('function-detail-not-found')).toBeNull();
  });

  it('shows an error when the owner detail fails to load', () => {
    h.mine = { data: [OWN], isPending: false, error: null };
    h.detail = { data: undefined, isPending: false };
    renderDetail('fn-own');
    expect(screen.getByTestId('function-detail-contract-error').textContent).toBe(
      'Could not load its inputs and outputs.'
    );
  });
});
