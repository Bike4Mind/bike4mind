import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import StatusHeader from './StatusHeader';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

describe('StatusHeader', () => {
  it('renders its content and closes to the app home', () => {
    render(
      <StatusHeader>
        <span>QA status</span>
      </StatusHeader>,
      { wrapper: QaTestWrapper }
    );
    expect(screen.getByText('QA status')).toBeInTheDocument();
    const close = screen.getByTestId('qa-status-close-btn');
    expect(close).toHaveAccessibleName('Close');
    fireEvent.click(close);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/' });
  });
});
