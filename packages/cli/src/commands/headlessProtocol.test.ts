import { describe, it, expect } from 'vitest';
import { HEADLESS_SCHEMA_VERSION, stampEvent, createHeadlessEmitter, classifyToolRisk } from './headlessProtocol.js';

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
