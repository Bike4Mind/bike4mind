import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import UserPermissions from './UserPermissions';
import type { IUserDocument } from '@bike4mind/common';
import type { ReactNode } from 'react';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseUser = (overrides: Partial<IUserDocument> = {}): IUserDocument =>
  ({
    id: 'u1',
    isAdmin: false,
    tags: [],
    level: 'DemoUser',
    ...overrides,
  }) as IUserDocument;

const noop = () => {};

describe('UserPermissions - Role', () => {
  it('renders exactly the three Role options: Customer, Developer, Super Admin', () => {
    render(
      <UserPermissions user={baseUser()} editedFields={{}} onFieldChange={noop} handleUserLevelButtonChange={noop} />,
      { wrapper: TestWrapper }
    );
    expect(screen.getByTestId('role-radio-customer')).toBeInTheDocument();
    expect(screen.getByTestId('role-radio-developer')).toBeInTheDocument();
    expect(screen.getByTestId('role-radio-super-admin')).toBeInTheDocument();
  });

  it('selects Customer by default for a plain user', () => {
    render(
      <UserPermissions user={baseUser()} editedFields={{}} onFieldChange={noop} handleUserLevelButtonChange={noop} />,
      { wrapper: TestWrapper }
    );
    expect(screen.getByTestId('role-radio-customer').querySelector('input')).toBeChecked();
  });

  it('selects Super Admin over Developer when both apply (precedence: Super Admin > Developer > Customer)', () => {
    render(
      <UserPermissions
        user={baseUser({ isAdmin: true, tags: ['Developer'] })}
        editedFields={{}}
        onFieldChange={noop}
        handleUserLevelButtonChange={noop}
      />,
      { wrapper: TestWrapper }
    );
    expect(screen.getByTestId('role-radio-super-admin').querySelector('input')).toBeChecked();
  });

  it('switching Customer -> Super Admin sets isAdmin true and leaves tags untouched (no developer tag to strip)', () => {
    const onFieldChange = vi.fn();
    render(
      <UserPermissions
        user={baseUser({ tags: ['some-custom-tag'] })}
        editedFields={{}}
        onFieldChange={onFieldChange}
        handleUserLevelButtonChange={noop}
      />,
      { wrapper: TestWrapper }
    );
    fireEvent.click(screen.getByTestId('role-radio-super-admin').querySelector('input')!);
    expect(onFieldChange).toHaveBeenCalledWith('isAdmin', true);
    expect(onFieldChange).toHaveBeenCalledWith('tags', ['some-custom-tag']);
  });

  it('switching Customer -> Developer sets isAdmin false and adds the Developer tag', () => {
    const onFieldChange = vi.fn();
    render(
      <UserPermissions
        user={baseUser({ tags: ['some-custom-tag'] })}
        editedFields={{}}
        onFieldChange={onFieldChange}
        handleUserLevelButtonChange={noop}
      />,
      { wrapper: TestWrapper }
    );
    fireEvent.click(screen.getByTestId('role-radio-developer').querySelector('input')!);
    expect(onFieldChange).toHaveBeenCalledWith('isAdmin', false);
    expect(onFieldChange).toHaveBeenCalledWith('tags', ['some-custom-tag', 'Developer']);
  });

  it('switching Developer -> Customer strips every developer-tag casing and clears isAdmin', () => {
    const onFieldChange = vi.fn();
    render(
      <UserPermissions
        user={baseUser({ tags: ['developer', 'some-custom-tag'] })}
        editedFields={{}}
        onFieldChange={onFieldChange}
        handleUserLevelButtonChange={noop}
      />,
      { wrapper: TestWrapper }
    );
    fireEvent.click(screen.getByTestId('role-radio-customer').querySelector('input')!);
    expect(onFieldChange).toHaveBeenCalledWith('isAdmin', false);
    expect(onFieldChange).toHaveBeenCalledWith('tags', ['some-custom-tag']);
  });

  it('switching Super Admin -> Developer clears isAdmin and adds the Developer tag', () => {
    const onFieldChange = vi.fn();
    render(
      <UserPermissions
        user={baseUser({ isAdmin: true, tags: [] })}
        editedFields={{}}
        onFieldChange={onFieldChange}
        handleUserLevelButtonChange={noop}
      />,
      { wrapper: TestWrapper }
    );
    fireEvent.click(screen.getByTestId('role-radio-developer').querySelector('input')!);
    expect(onFieldChange).toHaveBeenCalledWith('isAdmin', false);
    expect(onFieldChange).toHaveBeenCalledWith('tags', ['Developer']);
  });
});

describe('UserPermissions - Custom Tags', () => {
  it('does not show a product-access comp tag (e.g. opti) in the Custom Tags list - it has its own control in Product Access', () => {
    render(
      <UserPermissions
        user={baseUser({ tags: ['opti', 'opti-compute'] })}
        editedFields={{}}
        onFieldChange={noop}
        handleUserLevelButtonChange={noop}
      />,
      { wrapper: TestWrapper }
    );
    expect(screen.queryByText('opti')).not.toBeInTheDocument();
    expect(screen.queryByText('opti-compute')).not.toBeInTheDocument();
  });

  it('does not show the Developer tag in the Custom Tags list - it is represented by the Role radio', () => {
    render(
      <UserPermissions
        user={baseUser({ tags: ['Developer'] })}
        editedFields={{}}
        onFieldChange={noop}
        handleUserLevelButtonChange={noop}
      />,
      { wrapper: TestWrapper }
    );
    // The Role radio legitimately renders a "Developer" label - assert there's no
    // SEPARATE removable custom-tag chip for it (which would be a second, redundant control).
    expect(screen.queryByTestId('remove-tag-Developer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('remove-tag-developer')).not.toBeInTheDocument();
  });

  it('shows a genuinely custom tag with a remove control', () => {
    render(
      <UserPermissions
        user={baseUser({ tags: ['vip-beta'] })}
        editedFields={{}}
        onFieldChange={noop}
        handleUserLevelButtonChange={noop}
      />,
      { wrapper: TestWrapper }
    );
    expect(screen.getByText('vip-beta')).toBeInTheDocument();
  });

  it('removing a custom tag fires onFieldChange with it excluded', () => {
    const onFieldChange = vi.fn();
    render(
      <UserPermissions
        user={baseUser({ tags: ['vip-beta', 'other-tag'] })}
        editedFields={{}}
        onFieldChange={onFieldChange}
        handleUserLevelButtonChange={noop}
      />,
      { wrapper: TestWrapper }
    );
    fireEvent.click(screen.getByTestId('remove-tag-vip-beta'));
    expect(onFieldChange).toHaveBeenCalledWith('tags', ['other-tag']);
  });

  it('adding a custom tag via the input appends it and clears the input', () => {
    const onFieldChange = vi.fn();
    render(
      <UserPermissions
        user={baseUser()}
        editedFields={{}}
        onFieldChange={onFieldChange}
        handleUserLevelButtonChange={noop}
      />,
      { wrapper: TestWrapper }
    );
    const input = screen.getByPlaceholderText('Input a custom tag');
    fireEvent.change(input, { target: { value: 'new-custom-tag' } });
    fireEvent.click(screen.getByText('Add'));
    expect(onFieldChange).toHaveBeenCalledWith('tags', ['new-custom-tag']);
    expect(input).toHaveValue('');
  });
});
