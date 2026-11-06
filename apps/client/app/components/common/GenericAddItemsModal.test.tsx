import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import GenericAddItemsModal from './GenericAddItemsModal';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const selectionChanged = vi.fn();
const submitted = vi.fn();
const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;
const items = [
  { id: 'pending', disabled: true },
  { id: 'available', disabled: false },
];

function Picker({ initiallySelected = [] }: { initiallySelected?: string[] }) {
  const [selectedIds, setSelectedIds] = useState(initiallySelected);
  return (
    <GenericAddItemsModal
      title="Add members"
      buttonLabel="Open"
      triggerTestId="picker-open"
      items={items}
      selectedIds={selectedIds}
      onSelectIds={ids => {
        selectionChanged(ids);
        setSelectedIds(ids);
      }}
      getItemId={item => item.id}
      isItemDisabled={item => item.disabled}
      onAdd={submitted}
      renderItem={item => <span data-testid={`item-${item.id}`}>{item.id}</span>}
    />
  );
}

describe('GenericAddItemsModal disabled items', () => {
  beforeEach(() => {
    selectionChanged.mockClear();
    submitted.mockClear();
  });

  it('ignores disabled row clicks while allowing an available row to be selected', () => {
    render(<Picker />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('picker-open'));
    fireEvent.click(screen.getByTestId('item-pending'));
    expect(selectionChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('item-available'));
    expect(selectionChanged).toHaveBeenLastCalledWith(['available']);
    fireEvent.click(screen.getByTestId('generic-add-items-submit-btn'));
    expect(submitted).toHaveBeenCalledWith(['available']);
  });

  it('selects only available items with select all', () => {
    render(<Picker />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('picker-open'));
    fireEvent.click(screen.getByTestId('generic-add-items-select-all-btn'));
    expect(selectionChanged).toHaveBeenLastCalledWith(['available']);
    fireEvent.click(screen.getByTestId('generic-add-items-submit-btn'));
    expect(submitted).toHaveBeenCalledWith(['available']);
  });

  it('drops a stale disabled selection before notifying the parent about a new selection', () => {
    render(<Picker initiallySelected={['pending']} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('picker-open'));
    fireEvent.click(screen.getByTestId('item-available'));
    expect(selectionChanged).toHaveBeenLastCalledWith(['available']);
  });

  it('does not submit an empty effective selection', () => {
    render(<Picker initiallySelected={['pending']} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('picker-open'));
    const submit = screen.getByTestId('generic-add-items-submit-btn');
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(submitted).not.toHaveBeenCalled();
  });

  it('excludes an item disabled after it was selected from submission', () => {
    render(<Picker initiallySelected={['pending', 'available']} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('picker-open'));
    fireEvent.click(screen.getByTestId('generic-add-items-submit-btn'));
    expect(submitted).toHaveBeenCalledWith(['available']);
  });
});
