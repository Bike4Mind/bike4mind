import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ICallableFunctionPublic, ICallableFunctionShared } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  enabled: true,
  mine: { data: [] as unknown[] | undefined, isPending: false, error: null as unknown },
  shared: { data: [] as unknown[] | undefined, isPending: false, error: null as unknown },
  listEnabled: vi.fn(),
}));

vi.mock('@client/app/hooks/data/callableFunctions', () => ({
  useCallableFunctionsEnabled: () => h.enabled,
  useCallableFunctionList: (enabled: boolean) => {
    h.listEnabled(enabled);
    return h.mine;
  },
  useSharedCallableFunctions: () => h.shared,
}));
vi.mock('@client/app/hooks/useDebouncedValue', async () => {
  const { useState } = await import('react');
  return {
    useDebounceValue: (initial: string) => {
      const [value, setValue] = useState(initial);
      return { value, debouncedValue: value, setValue };
    },
  };
});
vi.mock('@tanstack/react-router', () => ({
  Link: function Link({ to, children, ...rest }: { to: string; children?: React.ReactNode }) {
    return (
      <a href={to} {...rest}>
        {children}
      </a>
    );
  },
}));

import { FunctionLibrary } from './FunctionLibrary';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderLibrary = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <FunctionLibrary />
    </CssVarsProvider>
  );

const OWN = {
  id: 'fn-own',
  slug: 'beam_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  status: 'draft',
  state: 'draft',
  trustLabel: null,
} as ICallableFunctionPublic;

const SHARED = {
  id: 'fn-shared',
  slug: 'pipe_flow',
  description: 'Pressure drop along a pipe.',
  status: 'reviewed',
  trustLabel: 'platform',
  ownerName: 'Avery Owner',
} as ICallableFunctionShared;

const group = (key: string) => screen.getByTestId(`function-library-group-${key}`);

beforeEach(() => {
  h.enabled = true;
  h.mine = { data: [OWN], isPending: false, error: null };
  h.shared = { data: [SHARED], isPending: false, error: null };
  h.listEnabled.mockReset();
});

describe('FunctionLibrary', () => {
  it('lists Mine and Shared with me, each row linking to its page', () => {
    renderLibrary();
    expect(screen.queryByTestId('function-library-group-public')).toBeNull();

    const mine = within(group('mine'));
    expect(mine.getByText('Mine (1)')).toBeTruthy();
    expect(mine.getByText('beam_deflection')).toBeTruthy();
    expect(mine.getByText('Midspan deflection of a simply supported beam.')).toBeTruthy();
    expect(mine.getByTestId('function-library-state').textContent).toBe('Draft');
    expect(mine.queryByTestId('function-library-trust-chip')).toBeNull();
    expect(mine.getByTestId('function-library-row').getAttribute('href')).toBe('/functions/fn-own');

    const shared = within(group('shared'));
    expect(shared.getByText('Shared with me (1)')).toBeTruthy();
    expect(shared.getByTestId('function-library-state').textContent).toBe('Live');
    expect(shared.getByTestId('function-library-review').textContent).toBe('Reviewed');
    expect(shared.getByTestId('function-library-owner').textContent).toBe('By Avery Owner');
    const chip = shared.getByTestId('function-library-trust-chip');
    expect(chip.textContent).toBe('Platform');
    expect(chip.getAttribute('title')).toBe('Platform: curated and checked by Bike4Mind.');
  });

  it('says in one line when a group is empty', () => {
    h.shared = { data: [], isPending: false, error: null };
    renderLibrary();
    expect(within(group('shared')).getByTestId('function-library-empty').textContent).toBe(
      'No one has shared a function with you.'
    );
  });

  it('searches names and descriptions across both groups', () => {
    renderLibrary();
    fireEvent.change(screen.getByTestId('function-library-search-input'), { target: { value: 'pressure' } });
    expect(within(group('mine')).getByTestId('function-library-empty').textContent).toBe(
      'No functions here match your search.'
    );
    expect(within(group('shared')).getByText('pipe_flow')).toBeTruthy();
  });

  it('lists nothing while callable functions are off', () => {
    h.enabled = false;
    renderLibrary();
    expect(screen.getByTestId('function-library-off')).toBeTruthy();
    expect(screen.queryByTestId('function-library')).toBeNull();
    expect(h.listEnabled).toHaveBeenCalledWith(false);
  });
});
