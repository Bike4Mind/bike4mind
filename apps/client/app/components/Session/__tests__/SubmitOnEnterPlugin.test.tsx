import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { SubmitOnEnterPlugin } from '../SubmitOnEnterPlugin';
import { CodeNode } from '@lexical/code-core';
import { ListNode, ListItemNode } from '@lexical/list';

// Test editor component
function TestEditor({ onSubmit }: { onSubmit: () => void }) {
  const initialConfig = {
    namespace: 'Test',
    theme: {},
    nodes: [CodeNode, ListNode, ListItemNode],
    onError: (error: Error) => console.error(error),
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <RichTextPlugin
        contentEditable={<ContentEditable data-testid="editor" role="textbox" aria-label="Test editor" />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <ListPlugin />
      <SubmitOnEnterPlugin onSubmit={onSubmit} />
    </LexicalComposer>
  );
}

describe('SubmitOnEnterPlugin', () => {
  let user: ReturnType<typeof userEvent.setup>;
  let onSubmit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    user = userEvent.setup();
    onSubmit = vi.fn();
  });

  it('should call onSubmit when Enter is pressed', async () => {
    render(<TestEditor onSubmit={onSubmit} />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('Hello{Enter}');

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });

  it('should not call onSubmit when Shift+Enter is pressed', async () => {
    render(<TestEditor onSubmit={onSubmit} />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('Line 1{Shift>}{Enter}{/Shift}Line 2');

    // Wait a bit to ensure onSubmit is not called
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('should call onSubmit multiple times for multiple Enter presses', async () => {
    render(<TestEditor onSubmit={onSubmit} />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('First{Enter}');

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    await user.keyboard('Second{Enter}');

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });
  });

  it('should call onSubmit even with empty input', async () => {
    render(<TestEditor onSubmit={onSubmit} />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });

  it('should not call onSubmit when mentions menu is open', async () => {
    // Create a mock mentions menu
    const menu = document.createElement('div');
    menu.className = 'beautiful-mentions-menu';
    document.body.appendChild(menu);

    render(<TestEditor onSubmit={onSubmit} />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('Test{Enter}');

    // Wait a bit to ensure onSubmit is not called when menu is visible
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(onSubmit).not.toHaveBeenCalled();

    document.body.removeChild(menu);
  });

  it('should handle rapid Enter presses', async () => {
    render(<TestEditor onSubmit={onSubmit} />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);

    await user.keyboard('{Enter}{Enter}{Enter}');

    await waitFor(() => {
      // Should have called onSubmit for each Enter
      expect(onSubmit).toHaveBeenCalledTimes(3);
    });
  });

  it('should differentiate Enter from Shift+Enter in multiline input', async () => {
    render(<TestEditor onSubmit={onSubmit} />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('Line 1{Shift>}{Enter}{/Shift}Line 2{Shift>}{Enter}{/Shift}Line 3{Enter}');

    await waitFor(() => {
      // Only the final Enter (without Shift) should call onSubmit
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });
});
