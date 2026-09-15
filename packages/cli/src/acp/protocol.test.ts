import { describe, it, expect } from 'vitest';
import type { AgentStep } from '@bike4mind/agents';
import type { schema } from './acpSdk.js';
import {
  ACP_MODE_ASK,
  ACP_MODE_PLAN,
  SAFE_ACP_MODES,
  buildSessionModeState,
  acpModeToInteraction,
  toolKind,
  toolCallTitle,
  buildPermissionOptions,
  permissionResponseFromOutcome,
  PERMISSION_OPTION_ALLOW_ONCE,
  PERMISSION_OPTION_ALLOW_ALWAYS,
  PERMISSION_OPTION_REJECT,
  contentBlocksToText,
  agentMessageChunk,
  agentThoughtChunk,
  toolCallStart,
  toolCallCompleted,
} from './protocol.js';

describe('acpModeToInteraction', () => {
  it('maps the two safe modes to CLI interaction modes', () => {
    expect(acpModeToInteraction(ACP_MODE_ASK)).toBe('normal');
    expect(acpModeToInteraction(ACP_MODE_PLAN)).toBe('plan');
  });

  it('rejects the unsafe no-prompt mode and any unknown id (fail closed)', () => {
    // 'auto-accept' is the CLI's no-prompt mode - it must never be selectable
    // over the wire.
    expect(acpModeToInteraction('auto-accept')).toBeNull();
    expect(acpModeToInteraction('auto')).toBeNull();
    expect(acpModeToInteraction('yolo')).toBeNull();
    expect(acpModeToInteraction('')).toBeNull();
  });

  it('only advertises the safe modes', () => {
    const ids = SAFE_ACP_MODES.map(m => m.id);
    expect(ids).toEqual([ACP_MODE_ASK, ACP_MODE_PLAN]);
    expect(ids).not.toContain('auto-accept');
  });
});

describe('buildSessionModeState', () => {
  it('defaults the current mode to ask and lists the safe modes', () => {
    const state = buildSessionModeState();
    expect(state.currentModeId).toBe(ACP_MODE_ASK);
    expect(state.availableModes).toBe(SAFE_ACP_MODES);
  });
});

describe('permissionResponseFromOutcome', () => {
  it('maps a selected option back to its CLI action', () => {
    expect(permissionResponseFromOutcome({ outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ONCE })).toBe(
      'allow-once'
    );
    expect(permissionResponseFromOutcome({ outcome: 'selected', optionId: PERMISSION_OPTION_ALLOW_ALWAYS })).toBe(
      'allow-always'
    );
    expect(permissionResponseFromOutcome({ outcome: 'selected', optionId: PERMISSION_OPTION_REJECT })).toBe('deny');
  });

  it('fails closed to deny on cancel, unknown option, or missing outcome', () => {
    expect(permissionResponseFromOutcome({ outcome: 'cancelled' })).toBe('deny');
    expect(permissionResponseFromOutcome({ outcome: 'selected', optionId: 'made-up' })).toBe('deny');
    expect(permissionResponseFromOutcome(null)).toBe('deny');
    expect(permissionResponseFromOutcome(undefined)).toBe('deny');
  });
});

describe('buildPermissionOptions', () => {
  it('offers allow-once, allow-always, and reject with correct ACP kinds', () => {
    const options = buildPermissionOptions();
    expect(options).toEqual([
      { optionId: PERMISSION_OPTION_ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
      { optionId: PERMISSION_OPTION_ALLOW_ALWAYS, name: 'Always allow', kind: 'allow_always' },
      { optionId: PERMISSION_OPTION_REJECT, name: 'Reject', kind: 'reject_once' },
    ]);
  });

  it('every option id round-trips through permissionResponseFromOutcome', () => {
    for (const option of buildPermissionOptions()) {
      const response = permissionResponseFromOutcome({ outcome: 'selected', optionId: option.optionId });
      expect(response).not.toBeUndefined();
    }
  });
});

describe('toolKind', () => {
  it('classifies read-only tools', () => {
    expect(toolKind('read_file')).toBe('read');
    expect(toolKind('grep_search')).toBe('search');
    expect(toolKind('web_search')).toBe('search');
  });

  it('classifies mutating tools', () => {
    expect(toolKind('write_file')).toBe('edit');
    expect(toolKind('apply_patch')).toBe('edit');
    expect(toolKind('run_command')).toBe('execute');
  });

  it('falls back to other for unknown tools', () => {
    expect(toolKind('some_novel_tool')).toBe('other');
  });
});

describe('toolCallTitle', () => {
  it('appends a compact input summary', () => {
    expect(toolCallTitle('read_file', { path: '/a/b.ts' })).toBe('read_file({"path":"/a/b.ts"})');
  });

  it('handles missing input', () => {
    expect(toolCallTitle('list_dir', undefined)).toBe('list_dir');
  });

  it('truncates long input', () => {
    const title = toolCallTitle('x', 'y'.repeat(500));
    expect(title.length).toBeLessThanOrEqual('x('.length + 80 + 1);
  });
});

describe('contentBlocksToText', () => {
  it('joins text blocks and renders resource links as @-refs', () => {
    const blocks: schema.ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
    ];
    expect(contentBlocksToText(blocks)).toBe('hello\n@file:///a.ts');
  });

  it('summarizes non-text blocks with a placeholder', () => {
    const blocks: schema.ContentBlock[] = [
      { type: 'image', data: 'base64', mimeType: 'image/png' },
      { type: 'text', text: 'describe this' },
    ];
    expect(contentBlocksToText(blocks)).toBe('[image]\ndescribe this');
  });
});

describe('session/update builders', () => {
  it('builds agent message and thought chunks', () => {
    expect(agentMessageChunk('hi')).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
    expect(agentThoughtChunk('reasoning')).toEqual({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'reasoning' },
    });
  });

  it('builds an in-progress tool_call from an action step', () => {
    const step: AgentStep = {
      type: 'action',
      content: 'reading',
      metadata: { toolName: 'read_file', toolInput: { path: '/x' }, timestamp: 0 },
    };
    const update = toolCallStart('tool-1', step);
    expect(update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: '/x' },
    });
  });

  it('builds a completed tool_call_update with content', () => {
    const update = toolCallCompleted('tool-1', 'file contents');
    expect(update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }],
    });
  });

  it('omits content on an empty observation', () => {
    const update = toolCallCompleted('tool-1', '') as Extract<
      schema.SessionUpdate,
      { sessionUpdate: 'tool_call_update' }
    >;
    expect(update.content).toBeUndefined();
  });
});
