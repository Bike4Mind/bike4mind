import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { MetadataFilterPanel } from './MetadataFilterPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderPanel = (props: Partial<React.ComponentProps<typeof MetadataFilterPanel>> = {}) =>
  render(
    <TestWrapper>
      {/* initialFilters is always passed a stable array in production (the store's state);
          omitting it here would feed the component's own default-parameter `[]`, which is a
          fresh reference on every re-render. */}
      <MetadataFilterPanel onApplyFilters={vi.fn()} metadataFields={[]} initialFilters={[]} {...props} />
    </TestWrapper>
  );

describe('MetadataFilterPanel - contains hint', () => {
  it('shows the text-only hint when a row uses Contains', () => {
    renderPanel({ initialFilters: [{ field: 'title', operator: 'contains', value: '' }] });

    expect(screen.getByTestId('metadata-filter-contains-hint')).toBeTruthy();
  });

  it('hides the hint when the row uses Equals', () => {
    renderPanel({ initialFilters: [{ field: 'title', operator: 'equals', value: '' }] });

    expect(screen.queryByTestId('metadata-filter-contains-hint')).toBeNull();
  });
});

describe('MetadataFilterPanel - field allowlist', () => {
  const typeField = (value: string) => {
    fireEvent.change(screen.getByPlaceholderText('Enter field name'), { target: { value } });
  };

  it.each(['_id', '2fa', 'a b', 'a.b.c.d.e.f'])('rejects the disallowed field name %j', rejected => {
    renderPanel();
    fireEvent.click(screen.getByText('Add Filter'));

    typeField(rejected);

    expect(screen.getByTestId('metadata-filter-field-error')).toBeTruthy();
    expect(screen.getByText('Apply Filters').closest('button')).toBeDisabled();
  });

  it('clears the error and re-enables Apply once the field name is valid', () => {
    renderPanel();
    fireEvent.click(screen.getByText('Add Filter'));

    typeField('_id');
    expect(screen.getByTestId('metadata-filter-field-error')).toBeTruthy();

    typeField('model.name');

    expect(screen.queryByTestId('metadata-filter-field-error')).toBeNull();
    expect(screen.getByText('Apply Filters').closest('button')).not.toBeDisabled();
  });

  it('does not treat a freshly added blank field as invalid', () => {
    renderPanel();
    fireEvent.click(screen.getByText('Add Filter'));

    expect(screen.queryByTestId('metadata-filter-field-error')).toBeNull();
  });
});
