import { describe, it, expect } from 'vitest';
import {
  decideFolderTrustGate,
  hostInertNotice,
  isHostLaunchWithQueuedPrompt,
  shouldPromptMcpApproval,
  shouldShowEndpointPicker,
  type EndpointPickerGateInput,
} from './startupTrustGates.js';

describe('shouldShowEndpointPicker', () => {
  const baked: EndpointPickerGateInput = {
    endpointSource: 'baked-default',
    endpointChosen: false,
    hasAuthTokens: false,
  };

  it.each<[string, EndpointPickerGateInput, boolean]>([
    ['fresh install with a default', baked, true],
    ['fork with no endpoint', { endpointSource: 'unconfigured', endpointChosen: false, hasAuthTokens: false }, true],
    [
      'fork with no endpoint, marker set',
      { endpointSource: 'unconfigured', endpointChosen: true, hasAuthTokens: false },
      true,
    ],
    ['signed in', { ...baked, hasAuthTokens: true }, false],
    ['expired token', { ...baked, hasAuthTokens: true }, false],
    ['saved customUrl', { ...baked, endpointSource: 'custom' }, false],
    ['marker set', { ...baked, endpointChosen: true }, false],
    ['--prod / --dev / --api-url / --reset-api (marker set)', { ...baked, endpointChosen: true }, false],
    ['after logout (marker kept, no tokens)', { ...baked, endpointChosen: true, hasAuthTokens: false }, false],
    ['source-mode dev default', { ...baked, endpointSource: 'dev-default' }, false],
  ])('%s', (_name, input, expected) => {
    expect(shouldShowEndpointPicker(input)).toBe(expected);
  });
});

describe('isHostLaunchWithQueuedPrompt', () => {
  it('is false with no initial prompt, whatever host flags are set', () => {
    expect(isHostLaunchWithQueuedPrompt({})).toBe(false);
    expect(isHostLaunchWithQueuedPrompt({ B4M_MCP_CONFIG_FILE: '/tmp/mcp.json', B4M_ALLOWED_TOOLS: '["x"]' })).toBe(
      false
    );
  });

  it('is false for a bare `b4m "task"` (initial prompt, no host flag)', () => {
    expect(isHostLaunchWithQueuedPrompt({ B4M_INITIAL_PROMPT: 'review the recent changes' })).toBe(false);
  });

  it.each([
    'B4M_MCP_CONFIG_FILE',
    'B4M_APPEND_SYSTEM_PROMPT',
    'B4M_ALLOWED_TOOLS',
    'B4M_SETTINGS_JSON',
    'B4M_SESSION_ID',
    'B4M_RESUME_ID',
  ])('is true for an initial prompt plus %s', key => {
    expect(isHostLaunchWithQueuedPrompt({ B4M_INITIAL_PROMPT: 'go', [key]: 'v' })).toBe(true);
  });

  it('ignores unrelated B4M_* variables', () => {
    expect(isHostLaunchWithQueuedPrompt({ B4M_INITIAL_PROMPT: 'go', B4M_ADDITIONAL_DIRS: '["/x"]' })).toBe(false);
  });

  it('treats an empty value as unset', () => {
    expect(isHostLaunchWithQueuedPrompt({ B4M_INITIAL_PROMPT: '', B4M_MCP_CONFIG_FILE: '/tmp/m.json' })).toBe(false);
    expect(isHostLaunchWithQueuedPrompt({ B4M_INITIAL_PROMPT: 'go', B4M_MCP_CONFIG_FILE: '' })).toBe(false);
  });
});

describe('decideFolderTrustGate', () => {
  const base = {
    alreadyResolved: false,
    projectTrusted: false,
    projectHasB4mFiles: true,
    isTty: true,
    hostLaunch: false,
  };

  it('prompts an untrusted project with repo files on a TTY', () => {
    expect(decideFolderTrustGate(base)).toBe('prompt');
  });

  it('leaves the folder inert without a prompt on a host launch', () => {
    expect(decideFolderTrustGate({ ...base, hostLaunch: true })).toBe('inert');
  });

  it('decides nothing when trusted, when nothing is gated, when resolved, or off a TTY', () => {
    for (const hostLaunch of [false, true]) {
      expect(decideFolderTrustGate({ ...base, hostLaunch, projectTrusted: true })).toBe('none');
      expect(decideFolderTrustGate({ ...base, hostLaunch, projectHasB4mFiles: false })).toBe('none');
      expect(decideFolderTrustGate({ ...base, hostLaunch, alreadyResolved: true })).toBe('none');
      expect(decideFolderTrustGate({ ...base, hostLaunch, isTty: false })).toBe('none');
    }
  });
});

describe('shouldPromptMcpApproval', () => {
  const base = { alreadyResolved: false, pendingCount: 1, isTty: true, hostLaunch: false };

  it('prompts for pending repo servers on a TTY', () => {
    expect(shouldPromptMcpApproval(base)).toBe(true);
  });

  it('does not prompt on a host launch', () => {
    expect(shouldPromptMcpApproval({ ...base, hostLaunch: true })).toBe(false);
  });

  it('does not prompt with nothing pending, once resolved, or off a TTY', () => {
    expect(shouldPromptMcpApproval({ ...base, pendingCount: 0 })).toBe(false);
    expect(shouldPromptMcpApproval({ ...base, alreadyResolved: true })).toBe(false);
    expect(shouldPromptMcpApproval({ ...base, isTty: false })).toBe(false);
  });
});

describe('hostInertNotice', () => {
  it('is one line naming the root and the /trust folder command', () => {
    const notice = hostInertNotice('/work/repo');
    expect(notice).not.toContain('\n');
    expect(notice).toContain('/work/repo');
    expect(notice).toContain('/trust folder');
  });

  it('escapes control bytes in the root, like the trust prompt it replaces', () => {
    const notice = hostInertNotice('/work/\x1b[2Jrepo');
    expect(notice).not.toContain('\x1b');
    expect(hostInertNotice('/a/\x1b')).toContain('\\x1b');
  });

  it('keeps a root containing a newline on one line', () => {
    expect(hostInertNotice('/a/\nb\r')).not.toMatch(/[\r\n]/);
  });
});
