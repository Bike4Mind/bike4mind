import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChangeRoleDialog, ManageTagsDialog, ProductAccessDialog, diffTags } from './accessDialogs';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';
import type { AdminUserProfile } from '../userProfileModel';

type ProductAccessStubProps = {
  user: { tags?: string[] };
  onFieldChange: (field: string, value: unknown) => void;
};

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  currentUser: { id: 'admin-1' } as { id: string } | null,
}));

vi.mock('./useAdminUserUpdate', () => ({ useAdminUserUpdate: () => mocks.update }));
vi.mock('./useAdminUserTagsUpdate', () => ({ useAdminUserTagsUpdate: () => mocks.update }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUserTags: () => ({ data: ['pilot', 'Developer'] }) }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('../../ProductAccess', () => ({
  default: ({ user, onFieldChange }: ProductAccessStubProps) => (
    <div>
      <span data-testid="stub-product-access-tags">{(user.tags ?? []).join('|')}</span>
      <button data-testid="stub-grant-btn" onClick={() => onFieldChange('tags', [...(user.tags ?? []), 'opti'])} />
      <button data-testid="stub-ignored-btn" onClick={() => onFieldChange('isAdmin', true)} />
    </div>
  ),
}));

const renderDialog = (
  ui: (user: AdminUserProfile, onClose: () => void) => React.ReactElement,
  user: AdminUserProfile
) => {
  const onClose = vi.fn();
  render(ui(user, onClose), { wrapper: ProfileTestWrapper });
  return { onClose };
};

const pickReason = (dialogId: string) => fireEvent.click(screen.getByTestId(`${dialogId}-reason-input-preset-0`));
const confirmButton = (dialogId: string) => screen.getByTestId(`${dialogId}-confirm-btn`);

describe('diffTags', () => {
  it('lists added and removed tags', () => {
    expect(diffTags(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
  });

  it('reports no change for identical lists, ignoring order', () => {
    expect(diffTags(['a', 'b'], ['b', 'a'])).toEqual({ added: [], removed: [] });
  });

  it('compares case-insensitively', () => {
    expect(diffTags(['Beta'], ['beta'])).toEqual({ added: [], removed: [] });
  });

  it('handles empty sides', () => {
    expect(diffTags([], ['x'])).toEqual({ added: ['x'], removed: [] });
    expect(diffTags(['x'], [])).toEqual({ added: [], removed: ['x'] });
  });
});

describe('access dialogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = { id: 'admin-1' };
    mocks.update.mockImplementation(async (input: { tags?: string[] }) => input.tags ?? []);
  });

  describe('ChangeRoleDialog', () => {
    const renderRole = (user: AdminUserProfile) =>
      renderDialog((target, close) => <ChangeRoleDialog user={target} onClose={close} />, user);

    it('blocks until a different role is picked', () => {
      renderRole(buildProfile());
      pickReason('change-role-dialog');

      expect(confirmButton('change-role-dialog')).toBeDisabled();
      expect(screen.getByTestId('change-role-dialog-hint')).toHaveTextContent('Pick a different role.');
      expect(screen.getByTestId('change-role-dialog-role-customer')).toHaveAttribute('aria-pressed', 'true');
    });

    it('promotes to Super Admin with isAdmin and a roleChangeReason, then undoes it', async () => {
      const { onClose } = renderRole(buildProfile({ tags: ['vip'] }));

      fireEvent.click(screen.getByTestId('change-role-dialog-role-super-admin'));
      expect(screen.getByTestId('change-role-dialog-preview-before')).toHaveTextContent('Customer');
      expect(screen.getByTestId('change-role-dialog-preview-after')).toHaveTextContent('Super Admin');
      expect(confirmButton('change-role-dialog')).toBeDisabled();
      pickReason('change-role-dialog');
      expect(confirmButton('change-role-dialog')).toHaveTextContent('Make Super Admin');
      fireEvent.click(confirmButton('change-role-dialog'));

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({
          isAdmin: true,
          tags: ['vip'],
          roleChangeReason: 'Joined the admin team',
        })
      );
      expect(onClose).toHaveBeenCalled();
      fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
      await waitFor(() =>
        expect(mocks.update).toHaveBeenLastCalledWith({
          isAdmin: false,
          tags: ['vip'],
          roleChangeReason: 'Undo: Joined the admin team',
        })
      );
    });

    it('makes a Developer by adding the tag, without a roleChangeReason', async () => {
      renderRole(buildProfile({ tags: ['vip'] }));

      fireEvent.click(screen.getByTestId('change-role-dialog-role-developer'));
      pickReason('change-role-dialog');
      fireEvent.click(confirmButton('change-role-dialog'));

      await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ isAdmin: false, tags: ['vip', 'Developer'] }));
    });

    it('demotes a Super Admin to Customer with a roleChangeReason', async () => {
      renderRole(buildProfile({ isAdmin: true, tags: [] }));

      fireEvent.click(screen.getByTestId('change-role-dialog-role-customer'));
      pickReason('change-role-dialog');
      fireEvent.click(confirmButton('change-role-dialog'));

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({
          isAdmin: false,
          tags: [],
          roleChangeReason: 'Joined the admin team',
        })
      );
    });

    it('is blocked for your own account whatever you pick', () => {
      mocks.currentUser = { id: buildProfile().id };
      renderRole(buildProfile());

      fireEvent.click(screen.getByTestId('change-role-dialog-role-developer'));
      pickReason('change-role-dialog');

      expect(confirmButton('change-role-dialog')).toBeDisabled();
      expect(screen.getByTestId('change-role-dialog-hint')).toHaveTextContent('You cannot change your own role.');
    });
  });

  describe('ManageTagsDialog', () => {
    const renderTags = (tags: string[]) =>
      renderDialog((target, close) => <ManageTagsDialog user={target} onClose={close} />, buildProfile({ tags }));

    it('blocks until a tag is added or removed', () => {
      renderTags(['vip']);
      pickReason('manage-tags-dialog');

      expect(confirmButton('manage-tags-dialog')).toBeDisabled();
      expect(screen.getByTestId('manage-tags-dialog-hint')).toHaveTextContent('Add or remove a tag first.');
    });

    it('adds comma-separated tags, keeping existing and managed tags', async () => {
      const { onClose } = renderTags(['Developer', 'vip']);

      fireEvent.change(screen.getByTestId('manage-tags-dialog-input'), { target: { value: 'beta, pilot ,' } });
      fireEvent.click(screen.getByTestId('manage-tags-dialog-add-btn'));
      expect(screen.getByTestId('manage-tags-dialog-preview-delta')).toHaveTextContent('+ beta, pilot');
      pickReason('manage-tags-dialog');
      fireEvent.click(confirmButton('manage-tags-dialog'));

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({
          before: ['Developer', 'vip'],
          tags: ['Developer', 'vip', 'beta', 'pilot'],
        })
      );
      expect(onClose).toHaveBeenCalled();
      fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
      await waitFor(() =>
        expect(mocks.update).toHaveBeenLastCalledWith({
          before: ['Developer', 'vip', 'beta', 'pilot'],
          tags: ['Developer', 'vip'],
        })
      );
    });

    it('adds on Enter and ignores duplicates and managed tags', async () => {
      renderTags(['Developer', 'vip']);

      const input = screen.getByTestId('manage-tags-dialog-input');
      fireEvent.change(input, { target: { value: 'VIP, developer, fresh' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      pickReason('manage-tags-dialog');
      fireEvent.click(confirmButton('manage-tags-dialog'));

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({ before: ['Developer', 'vip'], tags: ['Developer', 'vip', 'fresh'] })
      );
    });

    it('removes a free-form tag but never offers to remove a managed one', async () => {
      renderTags(['Developer', 'vip']);

      expect(screen.queryByTestId('manage-tags-dialog-remove-Developer-btn')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('manage-tags-dialog-remove-vip-btn'));
      expect(screen.getByTestId('manage-tags-dialog-preview-delta')).toHaveTextContent('\u2212 vip');
      pickReason('manage-tags-dialog');
      fireEvent.click(confirmButton('manage-tags-dialog'));

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({ before: ['Developer', 'vip'], tags: ['Developer'] })
      );
    });
    it('deduplicates comma-separated input case-insensitively before saving', async () => {
      renderTags([]);
      fireEvent.change(screen.getByTestId('manage-tags-dialog-input'), { target: { value: 'pilot,PILOT,pilot' } });
      fireEvent.click(screen.getByTestId('manage-tags-dialog-add-btn'));
      pickReason('manage-tags-dialog');
      fireEvent.click(confirmButton('manage-tags-dialog'));
      await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ before: [], tags: ['pilot'] }));
    });
    it('explains the tag length limit before submitting an invalid replacement', () => {
      renderTags([]);
      fireEvent.change(screen.getByTestId('manage-tags-dialog-input'), { target: { value: 'x'.repeat(65) } });
      fireEvent.click(screen.getByTestId('manage-tags-dialog-add-btn'));
      pickReason('manage-tags-dialog');
      expect(confirmButton('manage-tags-dialog')).toBeDisabled();
      expect(screen.getByTestId('manage-tags-dialog-hint')).toHaveTextContent('1 to 64 characters');
      expect(mocks.update).not.toHaveBeenCalled();
    });

    it('is blocked again when an added tag is removed before saving', () => {
      renderTags([]);

      fireEvent.change(screen.getByTestId('manage-tags-dialog-input'), { target: { value: 'temp' } });
      fireEvent.click(screen.getByTestId('manage-tags-dialog-add-btn'));
      fireEvent.click(screen.getByTestId('manage-tags-dialog-remove-temp-btn'));
      pickReason('manage-tags-dialog');

      expect(confirmButton('manage-tags-dialog')).toBeDisabled();
    });

    it('offers existing custom tags as autocomplete options', () => {
      renderTags([]);
      expect(screen.getByTestId('user-tags-editor')).toBeInTheDocument();
      expect(screen.getByTestId('manage-tags-dialog-input')).toHaveAttribute(
        'list',
        screen.getByTestId('user-tags-suggestions').id
      );
      expect(screen.getByTestId('user-tags-suggestions').innerHTML).toContain('pilot');
      expect(screen.getByTestId('user-tags-suggestions').innerHTML).not.toContain('Developer');
    });
    it('keeps the original conflict snapshot when the profile refetches during a draft', async () => {
      const props = { onClose: vi.fn(), user: buildProfile({ tags: ['original'] }) };
      const view = render(<ManageTagsDialog {...props} />, { wrapper: ProfileTestWrapper });
      fireEvent.change(screen.getByTestId('manage-tags-dialog-input'), { target: { value: 'draft' } });
      fireEvent.click(screen.getByTestId('manage-tags-dialog-add-btn'));
      view.rerender(<ManageTagsDialog {...props} user={buildProfile({ tags: ['concurrent'] })} />);
      pickReason('manage-tags-dialog');
      fireEvent.click(confirmButton('manage-tags-dialog'));
      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({ before: ['original'], tags: ['original', 'draft'] })
      );
    });
    it('uses the persisted normalized snapshot when undoing a tag edit', async () => {
      mocks.update.mockResolvedValueOnce(['legacy', 'pilot']);
      renderTags([' legacy ']);
      fireEvent.change(screen.getByTestId('manage-tags-dialog-input'), { target: { value: 'pilot' } });
      fireEvent.click(screen.getByTestId('manage-tags-dialog-add-btn'));
      pickReason('manage-tags-dialog');
      fireEvent.click(confirmButton('manage-tags-dialog'));
      fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
      await waitFor(() =>
        expect(mocks.update).toHaveBeenLastCalledWith({ before: ['legacy', 'pilot'], tags: [' legacy '] })
      );
    });
  });

  describe('ProductAccessDialog', () => {
    it('blocks until the panel changes the tags, then saves the draft tags', async () => {
      const { onClose } = renderDialog(
        (target, close) => <ProductAccessDialog user={target} onClose={close} />,
        buildProfile({ tags: ['vip'] })
      );
      pickReason('product-access-dialog');
      expect(confirmButton('product-access-dialog')).toBeDisabled();
      expect(screen.getByTestId('product-access-dialog-hint')).toHaveTextContent('Grant or revoke a product first.');

      fireEvent.click(screen.getByTestId('stub-ignored-btn'));
      expect(confirmButton('product-access-dialog')).toBeDisabled();

      fireEvent.click(screen.getByTestId('stub-grant-btn'));
      expect(screen.getByTestId('stub-product-access-tags')).toHaveTextContent('vip|opti');
      expect(screen.getByTestId('product-access-dialog-preview-before')).toHaveTextContent('1 tags');
      expect(screen.getByTestId('product-access-dialog-preview-after')).toHaveTextContent('2 tags');
      fireEvent.click(confirmButton('product-access-dialog'));

      await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ tags: ['vip', 'opti'] }));
      expect(onClose).toHaveBeenCalled();
      fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
      await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith({ tags: ['vip'] }));
    });
  });
});
