import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { RewindSelector } from './RewindSelector';
import type { Message } from '../storage';

const message = (role: Message['role'], content: string, metadata?: Message['metadata']): Message => ({
  id: content,
  role,
  content,
  timestamp: '2026-01-01T00:00:00.000Z',
  ...(metadata ? { metadata } : {}),
});

describe('RewindSelector', () => {
  it('offers turn prompts but not steers, which are stored ahead of their turn reply', () => {
    const { lastFrame, unmount } = render(
      <RewindSelector
        messages={[
          message('user', 'run the tests'),
          message('user', 'use pnpm', { steered: true }),
          message('assistant', 'done'),
        ]}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(lastFrame()).toContain('run the tests');
    expect(lastFrame()).not.toContain('use pnpm');
    unmount();
  });
});
