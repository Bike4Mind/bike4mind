import { describe, it, expect } from 'vitest';
import {
  HEADLESS_SCHEMA_VERSION,
  stampEvent,
  createHeadlessEmitter,
  classifyToolRisk,
  parseStrictObject,
  parseStringArray,
  HeadlessInputError,
  parsePermissionPolicy,
  evaluatePermissionPolicy,
} from './headlessProtocol.js';

describe('headless protocol envelope', () => {
  it('stamps schemaVersion and runId onto every event', () => {
    const stamped = stampEvent('run-1', { type: 'thought', content: 'hi' });
    expect(stamped).toEqual({
      schemaVersion: HEADLESS_SCHEMA_VERSION,
      runId: 'run-1',
      type: 'thought',
      content: 'hi',
    });
  });

  it('preserves arbitrary event fields alongside the envelope', () => {
    const stamped = stampEvent('run-2', {
      type: 'action',
      content: 'run tool',
      toolName: 'bash_execute',
      toolInput: { command: 'ls' },
    });
    expect(stamped.toolName).toBe('bash_execute');
    expect(stamped.toolInput).toEqual({ command: 'ls' });
    expect(stamped.runId).toBe('run-2');
  });

  it('envelope always wins over a stray schemaVersion/runId on the event', () => {
    const stamped = stampEvent('real-run', {
      type: 'thought',
      schemaVersion: 'fake',
      runId: 'fake',
    } as never);
    expect(stamped.schemaVersion).toBe(HEADLESS_SCHEMA_VERSION);
    expect(stamped.runId).toBe('real-run');
  });

  it('emitter writes one newline-terminated JSON line per event', () => {
    const lines: string[] = [];
    const emit = createHeadlessEmitter('run-3', line => lines.push(line));

    emit({ type: 'thought', content: 'a' });
    emit({ type: 'result', content: 'done' });

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(line);
      expect(parsed.schemaVersion).toBe(HEADLESS_SCHEMA_VERSION);
      expect(parsed.runId).toBe('run-3');
    }
    expect(JSON.parse(lines[1]).content).toBe('done');
  });
});

describe('classifyToolRisk', () => {
  it('classifies a shell tool from its command text (benign -> low)', () => {
    const risk = classifyToolRisk('bash_execute', { command: 'ls -la' }, 'prompt_always');
    expect(risk.level).toBe('low');
  });

  it('classifies a destructive shell command as high', () => {
    const risk = classifyToolRisk('bash_execute', { command: 'rm -rf /' }, 'prompt_default');
    expect(risk.level).toBe('high');
    expect(risk.reasons.length).toBeGreaterThan(0);
  });

  it('falls back to the permission category for non-shell tools', () => {
    expect(classifyToolRisk('read_file', {}, 'auto_approve').level).toBe('low');
    expect(classifyToolRisk('some_tool', {}, 'prompt_default').level).toBe('medium');
    expect(classifyToolRisk('write_file', {}, 'prompt_always').level).toBe('high');
  });

  it('does not throw on non-object args', () => {
    expect(() => classifyToolRisk('bash_execute', undefined, 'prompt_default')).not.toThrow();
    expect(classifyToolRisk('bash_execute', null, 'prompt_default').level).toBe('medium');
  });
});

describe('parseStrictObject', () => {
  const KEYS = ['allow', 'deny'] as const;

  it('accepts an object with only allowlisted keys', () => {
    expect(parseStrictObject('{"allow":["a"],"deny":[]}', KEYS, 'policy')).toEqual({ allow: ['a'], deny: [] });
  });

  it('rejects an unknown field with a clear, listing error', () => {
    expect(() => parseStrictObject('{"allow":[],"bogus":1}', KEYS, 'policy')).toThrow(HeadlessInputError);
    expect(() => parseStrictObject('{"allow":[],"bogus":1}', KEYS, 'policy')).toThrow(/unknown field\(s\): bogus/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseStrictObject('{not json', KEYS, 'policy')).toThrow(/invalid JSON/);
  });

  it('rejects non-object payloads (array, null, scalar)', () => {
    expect(() => parseStrictObject('[]', KEYS, 'policy')).toThrow(/expected a JSON object/);
    expect(() => parseStrictObject('null', KEYS, 'policy')).toThrow(/expected a JSON object/);
    expect(() => parseStrictObject('42', KEYS, 'policy')).toThrow(/expected a JSON object/);
  });
});

describe('parseStringArray', () => {
  it('accepts a JSON array of strings', () => {
    expect(parseStringArray('["/a","/b"]', 'dirs')).toEqual(['/a', '/b']);
  });

  it('rejects a non-array or an array with non-string elements', () => {
    expect(() => parseStringArray('{"a":1}', 'dirs')).toThrow(/expected a JSON array of strings/);
    expect(() => parseStringArray('["/a",2]', 'dirs')).toThrow(/expected a JSON array of strings/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseStringArray('nope', 'dirs')).toThrow(/invalid JSON/);
  });
});

describe('parsePermissionPolicy', () => {
  it('applies defaults for omitted fields', () => {
    expect(parsePermissionPolicy('{}')).toEqual({
      allow: [],
      deny: [],
      maxAutoAllowRisk: undefined,
      defaultAction: 'deny',
    });
  });

  it('parses a full policy', () => {
    const policy = parsePermissionPolicy(
      '{"allow":["read_file"],"deny":["bash_execute"],"maxAutoAllowRisk":"low","defaultAction":"deny"}'
    );
    expect(policy).toEqual({
      allow: ['read_file'],
      deny: ['bash_execute'],
      maxAutoAllowRisk: 'low',
      defaultAction: 'deny',
    });
  });

  it('rejects unknown fields and invalid enum values', () => {
    expect(() => parsePermissionPolicy('{"nope":true}')).toThrow(/unknown field/);
    expect(() => parsePermissionPolicy('{"maxAutoAllowRisk":"extreme"}')).toThrow(/maxAutoAllowRisk/);
    expect(() => parsePermissionPolicy('{"defaultAction":"maybe"}')).toThrow(/defaultAction/);
    expect(() => parsePermissionPolicy('{"allow":"read_file"}')).toThrow(/must be an array of strings/);
  });

  it('rejects the contradictory maxAutoAllowRisk + defaultAction:allow combination', () => {
    expect(() => parsePermissionPolicy('{"maxAutoAllowRisk":"low","defaultAction":"allow"}')).toThrow(
      /maxAutoAllowRisk has no effect with defaultAction 'allow'/
    );
    // defaultAction:allow on its own (no threshold) is still valid.
    expect(parsePermissionPolicy('{"defaultAction":"allow"}').defaultAction).toBe('allow');
  });
});

describe('evaluatePermissionPolicy', () => {
  const policy = parsePermissionPolicy(
    '{"allow":["read_file"],"deny":["bash_execute"],"maxAutoAllowRisk":"low","defaultAction":"deny"}'
  );

  it('denies a tool on the deny list even if it would otherwise be low risk', () => {
    expect(evaluatePermissionPolicy(policy, 'bash_execute', 'low')).toEqual({
      action: 'deny',
      reason: 'tool in policy deny list',
    });
  });

  it('allows a tool on the allow list', () => {
    expect(evaluatePermissionPolicy(policy, 'read_file', 'high').action).toBe('allow');
  });

  it('auto-allows within the risk threshold and denies above it', () => {
    expect(evaluatePermissionPolicy(policy, 'other_tool', 'low').action).toBe('allow');
    expect(evaluatePermissionPolicy(policy, 'other_tool', 'medium').action).toBe('deny');
  });

  it('falls back to defaultAction when no rule matches and no threshold applies', () => {
    const allowByDefault = parsePermissionPolicy('{"defaultAction":"allow"}');
    expect(evaluatePermissionPolicy(allowByDefault, 'x', 'high').action).toBe('allow');
  });
});
