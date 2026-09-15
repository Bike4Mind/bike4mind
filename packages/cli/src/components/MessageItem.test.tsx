/** Tests for MessageItem: rendering of different message types in the CLI. */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MessageItem } from './MessageItem';
import { createMockMessage } from '../test-utils/mocks';

describe('MessageItem', () => {
  describe('user messages', () => {
    it('should render basic user message with prompt indicator', () => {
      const message = createMockMessage({
        role: 'user',
        content: 'Hello, world!',
      });

      const { lastFrame } = render(<MessageItem message={message} />);

      expect(lastFrame()).toContain('❯');
      expect(lastFrame()).toContain('Hello, world!');
    });

    it('should not render empty user messages', () => {
      const message = createMockMessage({
        role: 'user',
        content: '',
      });

      const { lastFrame } = render(<MessageItem message={message} />);

      // Empty content means the user message block is not rendered
      expect(lastFrame()).toBe('');
    });
  });

  describe('assistant messages', () => {
    it('should render basic assistant message', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: 'I can help you with that!',
      });

      const { lastFrame } = render(<MessageItem message={message} />);

      expect(lastFrame()).toContain('I can help you with that!');
    });

    it('should not render pending messages with "..."', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: '...',
      });

      const { lastFrame } = render(<MessageItem message={message} />);

      expect(lastFrame()).not.toContain('...');
    });

    it('should display permission denied messages with warning', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: 'Permission denied for this operation',
        metadata: {
          permissionDenied: true,
        },
      });

      const { lastFrame } = render(<MessageItem message={message} />);

      expect(lastFrame()).toContain('⚠️');
      expect(lastFrame()).toContain('Permission denied for this operation');
    });

    it('should display token usage when no steps', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: 'Response',
        metadata: {
          tokenUsage: {
            prompt: 100,
            completion: 50,
            total: 150,
          },
        },
      });

      const { lastFrame } = render(<MessageItem message={message} />);

      expect(lastFrame()).toContain('150 tokens');
    });
  });

  describe('messages with agent steps', () => {
    it('should display thought and tool steps inline', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: 'Found the file!',
        metadata: {
          steps: [
            {
              type: 'thought',
              content: 'I need to search for the file',
              metadata: {
                timestamp: Date.now(),
              },
            },
            {
              type: 'action',
              content: 'Searching...',
              metadata: {
                toolName: 'grep_search',
                toolInput: { pattern: 'test' },
                timestamp: Date.now(),
              },
            },
            {
              type: 'observation',
              content: 'Found 5 matches',
              metadata: {
                timestamp: Date.now(),
              },
            },
          ],
          tokenUsage: {
            prompt: 200,
            completion: 100,
            total: 300,
          },
        },
      });

      const { lastFrame } = render(<MessageItem message={message} />);
      const frame = lastFrame();

      expect(frame).toContain('💭');
      expect(frame).toContain('I need to search for the file');
      expect(frame).toContain('Grep Search');
      expect(frame).toContain('Found 5 matches');
      expect(frame).toContain('Found the file!');
    });

    it('should display token usage even when steps are present', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: 'Found the file!',
        metadata: {
          steps: [
            {
              type: 'thought',
              content: 'Thinking...',
              metadata: { timestamp: Date.now() },
            },
          ],
          tokenUsage: {
            prompt: 200,
            completion: 100,
            total: 300,
          },
        },
      });

      const { lastFrame } = render(<MessageItem message={message} />);

      // Usage metrics now display consistently after all assistant messages
      expect(lastFrame()).toContain('300 tokens');
      // Steps should appear before usage metrics
      expect(lastFrame()).toMatch(/💭[\s\S]*\(300 tokens\)/);
    });

    it('should handle empty steps array', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: 'Simple response',
        metadata: {
          steps: [],
        },
      });

      const { lastFrame } = render(<MessageItem message={message} />);

      expect(lastFrame()).not.toContain('💭 Thought:');
      expect(lastFrame()).toContain('Simple response');
    });

    it('should truncate long tool inputs and outputs', () => {
      const longInput = 'a'.repeat(200);
      const longOutput = 'b'.repeat(300);

      const message = createMockMessage({
        role: 'assistant',
        content: 'Done',
        metadata: {
          steps: [
            {
              type: 'action',
              content: 'Processing...',
              metadata: {
                toolName: 'test_tool',
                toolInput: longInput,
                timestamp: Date.now(),
              },
            },
            {
              type: 'observation',
              content: longOutput,
              metadata: {
                timestamp: Date.now(),
              },
            },
          ],
        },
      });

      const { lastFrame } = render(<MessageItem message={message} />);
      const frame = lastFrame();

      // Tool input renders inline with the tool name separated by " - "
      // (e.g. "Test Tool - aaaaa..."), not as a separate "Input:" line.
      expect(frame).toContain('•');
      expect(frame).toContain('Result:');
      // Should be truncated
      expect(frame).toContain('...');
    });

    it('should show tool arguments inline for most tools', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: 'Done',
        metadata: {
          steps: [
            {
              type: 'action',
              content: 'Running...',
              metadata: {
                toolName: 'bash_execute',
                toolInput: { command: 'echo hello' },
                timestamp: Date.now(),
              },
            },
          ],
        },
      });

      const { lastFrame } = render(<MessageItem message={message} />);
      const frame = lastFrame();

      // Args render inline alongside the tool name (e.g. "Bash Execute - {...}").
      expect(frame).toContain('Bash Execute');
      expect(frame).toContain('•');
      expect(frame).toContain('echo hello');
    });

    it('should hide arguments for edit_local_file', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: 'Done',
        metadata: {
          steps: [
            {
              type: 'action',
              content: 'Editing...',
              metadata: {
                toolName: 'edit_local_file',
                toolInput: { path: 'apps/foo.ts', old_string: 'noisy old', new_string: 'noisy new' },
                timestamp: Date.now(),
              },
            },
            {
              type: 'observation',
              content: 'File edited successfully: apps/foo.ts',
              metadata: { timestamp: Date.now() },
            },
          ],
        },
      });

      const { lastFrame } = render(<MessageItem message={message} />);
      const frame = lastFrame();

      // Tool name still renders, but the noisy diff strings should not.
      expect(frame).toContain('Edit Local File');
      expect(frame).not.toContain('noisy old');
      expect(frame).not.toContain('noisy new');
      // Result still rendered so the user sees whether the edit worked.
      expect(frame).toContain('Result:');
    });

    it('should show thoughts by default', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: 'Done',
        metadata: {
          steps: [
            {
              type: 'thought',
              content: 'I should think about this carefully',
              metadata: { timestamp: Date.now() },
            },
          ],
        },
      });

      const { lastFrame } = render(<MessageItem message={message} />);

      expect(lastFrame()).toContain('💭');
      expect(lastFrame()).toContain('I should think about this carefully');
    });

    it('should hide thoughts when showThoughts is false', () => {
      const message = createMockMessage({
        role: 'assistant',
        content: 'Done',
        metadata: {
          steps: [
            {
              type: 'thought',
              content: 'secret reasoning',
              metadata: { timestamp: Date.now() },
            },
            {
              type: 'action',
              content: 'Running...',
              metadata: {
                toolName: 'grep_search',
                toolInput: { pattern: 'x' },
                timestamp: Date.now(),
              },
            },
          ],
        },
      });

      const { lastFrame } = render(<MessageItem message={message} showThoughts={false} />);
      const frame = lastFrame();

      expect(frame).not.toContain('💭');
      expect(frame).not.toContain('secret reasoning');
      // Action steps still render
      expect(frame).toContain('Grep Search');
    });
  });

  describe('edge cases', () => {
    it('should handle multiline content', () => {
      const message = createMockMessage({
        role: 'user',
        content: 'Line 1\nLine 2\nLine 3',
      });

      const { lastFrame } = render(<MessageItem message={message} />);
      const frame = lastFrame();

      expect(frame).toContain('Line 1');
      expect(frame).toContain('Line 2');
      expect(frame).toContain('Line 3');
    });

    it('should handle Unicode characters', () => {
      const message = createMockMessage({
        role: 'user',
        content: '你好 🌍 мир',
      });

      const { lastFrame } = render(<MessageItem message={message} />);

      expect(lastFrame()).toContain('你好 🌍 мир');
    });
  });
});
