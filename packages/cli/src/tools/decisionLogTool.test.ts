import { describe, it, expect, vi } from 'vitest';
import { createDecisionLogTool, createDecisionStore, formatDecisionsOutput } from './decisionLogTool';

describe('decisionLogTool', () => {
  describe('createDecisionStore', () => {
    it('creates an empty store', () => {
      const store = createDecisionStore();
      expect(store.decisions).toEqual([]);
    });

    it('accepts an onUpdate callback', () => {
      const onUpdate = vi.fn();
      const store = createDecisionStore(onUpdate);
      expect(store.onUpdate).toBe(onUpdate);
    });
  });

  describe('log_decision tool', () => {
    it('logs a decision with required fields', async () => {
      const store = createDecisionStore();
      const tool = createDecisionLogTool(store);

      const result = await tool.toolFn({
        summary: 'Use Zustand for state management',
        rationale: 'Simpler API than Redux, less boilerplate',
      });

      expect(store.decisions).toHaveLength(1);
      expect(store.decisions[0].summary).toBe('Use Zustand for state management');
      expect(store.decisions[0].rationale).toBe('Simpler API than Redux, less boilerplate');
      expect(store.decisions[0].id).toBeDefined();
      expect(store.decisions[0].timestamp).toBeDefined();
      expect(result).toContain('Decision logged (#1)');
    });

    it('logs a decision with optional fields', async () => {
      const store = createDecisionStore();
      const tool = createDecisionLogTool(store);

      await tool.toolFn({
        summary: 'Use PostgreSQL over MongoDB',
        rationale: 'Need relational queries and ACID transactions',
        alternatives: ['MongoDB', 'DynamoDB'],
        context: 'Evaluating databases for the new analytics service',
      });

      expect(store.decisions[0].alternatives).toEqual(['MongoDB', 'DynamoDB']);
      expect(store.decisions[0].context).toBe('Evaluating databases for the new analytics service');
    });

    it('appends multiple decisions in order', async () => {
      const store = createDecisionStore();
      const tool = createDecisionLogTool(store);

      await tool.toolFn({ summary: 'First decision', rationale: 'Reason 1' });
      await tool.toolFn({ summary: 'Second decision', rationale: 'Reason 2' });

      expect(store.decisions).toHaveLength(2);
      expect(store.decisions[0].summary).toBe('First decision');
      expect(store.decisions[1].summary).toBe('Second decision');
    });

    it('calls onUpdate callback', async () => {
      const onUpdate = vi.fn();
      const store = createDecisionStore(onUpdate);
      const tool = createDecisionLogTool(store);

      await tool.toolFn({ summary: 'A decision', rationale: 'A reason' });

      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith(store.decisions);
    });

    it('trims whitespace from inputs', async () => {
      const store = createDecisionStore();
      const tool = createDecisionLogTool(store);

      await tool.toolFn({
        summary: '  trimmed summary  ',
        rationale: '  trimmed rationale  ',
      });

      expect(store.decisions[0].summary).toBe('trimmed summary');
      expect(store.decisions[0].rationale).toBe('trimmed rationale');
    });

    it('rejects empty summary', async () => {
      const store = createDecisionStore();
      const tool = createDecisionLogTool(store);

      await expect(tool.toolFn({ summary: '', rationale: 'reason' })).rejects.toThrow(
        'summary must be a non-empty string'
      );
    });

    it('rejects empty rationale', async () => {
      const store = createDecisionStore();
      const tool = createDecisionLogTool(store);

      await expect(tool.toolFn({ summary: 'decision', rationale: '' })).rejects.toThrow(
        'rationale must be a non-empty string'
      );
    });

    it('rejects non-array alternatives', async () => {
      const store = createDecisionStore();
      const tool = createDecisionLogTool(store);

      await expect(
        tool.toolFn({ summary: 'decision', rationale: 'reason', alternatives: 'not an array' })
      ).rejects.toThrow('alternatives must be an array');
    });
  });

  describe('formatDecisionsOutput', () => {
    it('shows message for empty list', () => {
      expect(formatDecisionsOutput([])).toBe('No decisions logged in this session.');
    });

    it('formats decisions with required fields', () => {
      const output = formatDecisionsOutput([
        {
          id: 'abc-123',
          timestamp: '2026-01-01T12:00:00Z',
          summary: 'Use TypeScript strict mode',
          rationale: 'Catches more bugs at compile time',
        },
      ]);

      expect(output).toContain('Use TypeScript strict mode');
      expect(output).toContain('Catches more bugs at compile time');
    });

    it('includes alternatives when present', () => {
      const output = formatDecisionsOutput([
        {
          id: 'abc-123',
          timestamp: '2026-01-01T12:00:00Z',
          summary: 'Use Zod',
          rationale: 'Type-safe validation',
          alternatives: ['Joi', 'Yup'],
        },
      ]);

      expect(output).toContain('Joi, Yup');
    });
  });

  describe('hydration (session resume)', () => {
    it('appends to pre-populated decisions from a resumed session', async () => {
      const store = createDecisionStore();
      // Simulate hydration from a resumed session
      store.decisions = [
        {
          id: 'existing-1',
          timestamp: '2026-01-01T10:00:00Z',
          summary: 'Pre-existing decision',
          rationale: 'Was decided before session resume',
        },
      ];

      const tool = createDecisionLogTool(store);
      await tool.toolFn({ summary: 'New decision', rationale: 'Fresh reasoning' });

      expect(store.decisions).toHaveLength(2);
      expect(store.decisions[0].id).toBe('existing-1');
      expect(store.decisions[0].summary).toBe('Pre-existing decision');
      expect(store.decisions[1].summary).toBe('New decision');
    });

    it('numbers new decisions relative to total count', async () => {
      const store = createDecisionStore();
      store.decisions = [
        { id: 'a', timestamp: '', summary: 'First', rationale: 'r1' },
        { id: 'b', timestamp: '', summary: 'Second', rationale: 'r2' },
      ];

      const tool = createDecisionLogTool(store);
      const result = await tool.toolFn({ summary: 'Third', rationale: 'r3' });

      expect(result).toContain('#3');
    });
  });

  describe('tool schema', () => {
    it('has correct name and required parameters', () => {
      const store = createDecisionStore();
      const tool = createDecisionLogTool(store);

      expect(tool.toolSchema.name).toBe('log_decision');
      expect(tool.toolSchema.parameters.required).toEqual(['summary', 'rationale']);
    });
  });
});
