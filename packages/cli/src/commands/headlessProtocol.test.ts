import { describe, it, expect } from 'vitest';
import { HEADLESS_SCHEMA_VERSION, stampEvent, createHeadlessEmitter } from './headlessProtocol.js';

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
