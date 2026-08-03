import { getThemeConfig } from '@client/app/utils/themes';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UserIdChip, { truncateUserId } from './UserIdChip';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

describe('truncateUserId', () => {
  it('keeps the head and tail of a Mongo object id', () => {
    const truncated = truncateUserId('6900781a8c1b76a684f80001');
    expect(truncated.startsWith('690078')).toBe(true);
    expect(truncated.endsWith('0001')).toBe(true);
    expect(truncated).toHaveLength(11); // 6 head + 1 ellipsis + 4 tail
  });

  it('leaves short ids untouched', () => {
    expect(truncateUserId('abc123')).toBe('abc123');
  });
});

describe('UserIdChip', () => {
  it('renders the truncated id and copies the full id on click', async () => {
    const fullId = '6900781a8c1b76a684f80001';
    render(<UserIdChip userId={fullId} />, { wrapper: TestWrapper });

    const chip = screen.getByTestId('admin-user-id-chip');
    expect(chip).toHaveTextContent(truncateUserId(fullId));
    expect(chip).not.toHaveTextContent(fullId);

    // Joy renders the clickable surface as a button nested inside the chip root.
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(fullId));
  });
});
