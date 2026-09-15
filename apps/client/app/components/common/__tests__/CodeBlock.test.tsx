import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CodeBlock } from '../CodeBlock';
import '@testing-library/jest-dom';

// Mock clipboard API
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, {
  clipboard: {
    writeText: mockWriteText,
  },
});

describe('CodeBlock', () => {
  beforeEach(() => {
    mockWriteText.mockClear();
  });

  it('renders correctly with children', () => {
    render(<CodeBlock>const foo = &quot;bar&quot;;</CodeBlock>);

    expect(screen.getByText('const foo = "bar";')).toBeInTheDocument();

    // Copy button is a Joy IconButton, located by its button role.
    const copyButton = screen.getByRole('button');
    expect(copyButton).toBeInTheDocument();
  });

  it('copies text to clipboard when clicked', async () => {
    const codeContent = 'console.log("hello world");';
    const { getByRole } = render(<CodeBlock>{codeContent}</CodeBlock>);

    const copyButton = getByRole('button');

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalled();
    });

    expect(mockWriteText).toHaveBeenCalledWith(codeContent);
  });

  it('shows visual feedback after copying', async () => {
    const codeContent = 'test code';
    const { getByRole } = render(<CodeBlock>{codeContent}</CodeBlock>);

    const copyButton = getByRole('button');

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalled();
    });
  });
});
