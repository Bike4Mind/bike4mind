import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { McpApprovalPrompt } from './McpApprovalPrompt';
import type { PendingMcpApproval } from '../storage/ConfigStore';

const tick = () => new Promise(resolve => setTimeout(resolve, 60));

// Built at runtime so the source stays ASCII (see FolderTrustPrompt.test.tsx).
const ARROW_DOWN = String.fromCharCode(27) + '[B';
const ENTER = '\r';

const servers: PendingMcpApproval[] = [
  {
    name: 'db-srv',
    fingerprint: 'f1',
    transport: 'stdio',
    command: 'node',
    args: ['db.js'],
    envKeys: ['DB_PASSWORD'],
    headerKeys: [],
  },
  {
    name: 'web-srv',
    fingerprint: 'f2',
    transport: 'http',
    url: 'https://mcp.example.com',
    envKeys: [],
    headerKeys: ['Authorization'],
  },
];

describe('McpApprovalPrompt', () => {
  it('shows each definition with key names', () => {
    const { lastFrame } = render(
      <McpApprovalPrompt projectRoot="/home/me/repo" servers={servers} onSelect={() => {}} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/home/me/repo');
    expect(frame).toContain('node db.js');
    expect(frame).toContain('env: DB_PASSWORD');
    expect(frame).toContain('https://mcp.example.com');
    expect(frame).toContain('headers: Authorization');
    expect(frame).toContain('Approve all');
    expect(frame).toContain('Skip');
  });

  it('selects skip on Enter (the safe default)', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<McpApprovalPrompt projectRoot="/r" servers={servers} onSelect={onSelect} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith('skip');
  });

  it('selects approve after moving down then pressing Enter', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<McpApprovalPrompt projectRoot="/r" servers={servers} onSelect={onSelect} />);
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith('approve');
  });
});
