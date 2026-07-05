import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { InlineCodePlugin } from '../InlineCodePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';

// Helper component to access editor content
function EditorContent({ testId }: { testId: string }) {
  const [editor] = useLexicalComposerContext();

  const getContent = () => {
    let text = '';
    editor.getEditorState().read(() => {
      text = $getRoot().getTextContent();
    });
    return text;
  };

  return <div data-testid={testId}>{getContent()}</div>;
}

// Test editor component
function TestEditor() {
  const initialConfig = {
    namespace: 'Test',
    theme: {
      text: {
        code: 'test-inline-code',
      },
    },
    onError: (error: Error) => console.error(error),
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <RichTextPlugin
        contentEditable={<ContentEditable data-testid="editor" role="textbox" aria-label="Test editor" />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <InlineCodePlugin />
      <EditorContent testId="editor-content" />
    </LexicalComposer>
  );
}

// TODO: Fix tests - userEvent.keyboard() doesn't trigger Lexical plugins in CI
// See: https://github.com/facebook/lexical/discussions/3948
describe.skip('InlineCodePlugin', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  it('should transform backtick-wrapped text into inline code', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    // Type: `code`
    await user.click(editor);
    await user.keyboard('`code`');

    await waitFor(() => {
      const content = screen.getByTestId('editor-content');
      // The backticks should be removed, only "code" remains
      expect(content.textContent).toBe('code '); // Space added after code
    });
  });

  it('should handle multiple inline code snippets in same line', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('Use `console.log` or `print` here');

    await waitFor(() => {
      const content = screen.getByTestId('editor-content');
      // Both code snippets should be transformed
      expect(content.textContent).toContain('console.log');
      expect(content.textContent).toContain('print');
    });
  });

  it('should not transform incomplete backticks', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('`incomplete');

    await waitFor(() => {
      const content = screen.getByTestId('editor-content');
      // Should keep the backtick since it's incomplete
      expect(content.textContent).toBe('`incomplete');
    });
  });

  it('should handle backticks with newlines (should not transform)', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('`code{Shift>}{Enter}{/Shift}with{Shift>}{Enter}{/Shift}newline`');

    await waitFor(() => {
      const content = screen.getByTestId('editor-content');
      // Should NOT transform because regex excludes \n
      expect(content.textContent).toContain('`');
    });
  });

  it('should add space after inline code for continued typing', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('`test`');

    await waitFor(() => {
      const content = screen.getByTestId('editor-content');
      // Should have space after transformed code
      expect(content.textContent).toBe('test ');
    });
  });

  it('should handle empty backticks', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('``');

    await waitFor(() => {
      const content = screen.getByTestId('editor-content');
      // Empty backticks might remain or be ignored
      // The plugin checks for /`([^`\n]+)`/ which requires at least one char
      expect(content.textContent).toBe('``');
    });
  });

  it('should handle text before and after inline code', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('Before `code` after');

    await waitFor(() => {
      const content = screen.getByTestId('editor-content');
      expect(content.textContent).toContain('Before');
      expect(content.textContent).toContain('code');
      expect(content.textContent).toContain('after');
    });
  });
});
