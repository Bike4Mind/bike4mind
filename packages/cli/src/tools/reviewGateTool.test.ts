import { describe, it, expect, vi } from 'vitest';
import {
  createReviewGateTool,
  createReviewGateStore,
  formatReviewGatesOutput,
  type ReviewGateResponse,
  type RequestReviewGateFn,
} from './reviewGateTool';

const approveFn: RequestReviewGateFn = async () => ({ decision: 'approved' });
const rejectFn: RequestReviewGateFn = async () => ({ decision: 'rejected', note: 'too risky' });

describe('reviewGateTool', () => {
  describe('createReviewGateStore', () => {
    it('creates an empty store', () => {
      const store = createReviewGateStore();
      expect(store.reviewGates).toEqual([]);
    });

    it('accepts an onUpdate callback', () => {
      const onUpdate = vi.fn();
      const store = createReviewGateStore(onUpdate);
      expect(store.onUpdate).toBe(onUpdate);
    });
  });

  describe('request_review_gate tool', () => {
    it('records an approved gate with required fields', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      const result = await tool.toolFn({ description: 'Narrow research scope to auth-only?' });

      expect(store.reviewGates).toHaveLength(1);
      const [entry] = store.reviewGates;
      expect(entry.status).toBe('approved');
      expect(entry.description).toBe('Narrow research scope to auth-only?');
      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeDefined();
      expect(entry.resolvedAt).toBeDefined();
      expect(entry.userNote).toBeUndefined();
      expect(result).toContain('APPROVED');
      expect(result).toContain('Narrow research scope');
    });

    it('records a rejected gate and surfaces the user note', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, rejectFn);

      const result = await tool.toolFn({
        description: 'Refactor auth module?',
        recommendation: 'Recommended for clarity',
      });

      expect(store.reviewGates[0].status).toBe('rejected');
      expect(store.reviewGates[0].userNote).toBe('too risky');
      expect(result).toContain('REJECTED');
      expect(result).toContain('User note: too risky');
    });

    it('forwards options + recommendation to the prompt fn', async () => {
      const store = createReviewGateStore();
      const requestFn = vi.fn<RequestReviewGateFn>(async () => ({ decision: 'approved' }));
      const tool = createReviewGateTool(store, requestFn);

      await tool.toolFn({
        description: 'Pick an approach',
        options: ['rewrite', 'patch'],
        recommendation: 'patch — lower risk',
      });

      expect(requestFn).toHaveBeenCalledTimes(1);
      const arg = requestFn.mock.calls[0][0];
      expect(arg.description).toBe('Pick an approach');
      expect(arg.options).toEqual(['rewrite', 'patch']);
      expect(arg.recommendation).toBe('patch — lower risk');
      expect(arg.id).toBeDefined();
    });

    it('drops empty/whitespace-only options', async () => {
      const store = createReviewGateStore();
      const requestFn = vi.fn<RequestReviewGateFn>(async () => ({ decision: 'approved' }));
      const tool = createReviewGateTool(store, requestFn);

      await tool.toolFn({
        description: 'desc',
        options: ['real option', '   ', ''],
      });

      expect(requestFn.mock.calls[0][0].options).toEqual(['real option']);
    });

    it('omits options when all entries are empty', async () => {
      const store = createReviewGateStore();
      const requestFn = vi.fn<RequestReviewGateFn>(async () => ({ decision: 'approved' }));
      const tool = createReviewGateTool(store, requestFn);

      await tool.toolFn({ description: 'desc', options: ['', '   '] });

      expect(requestFn.mock.calls[0][0].options).toBeUndefined();
    });

    it('appends multiple gates in order', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await tool.toolFn({ description: 'Gate 1' });
      await tool.toolFn({ description: 'Gate 2' });

      expect(store.reviewGates).toHaveLength(2);
      expect(store.reviewGates[0].description).toBe('Gate 1');
      expect(store.reviewGates[1].description).toBe('Gate 2');
    });

    it('calls onUpdate after each gate is resolved', async () => {
      const onUpdate = vi.fn();
      const store = createReviewGateStore(onUpdate);
      const tool = createReviewGateTool(store, approveFn);

      await tool.toolFn({ description: 'Gate' });

      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith(store.reviewGates);
    });

    it('trims description and note', async () => {
      const store = createReviewGateStore();
      const requestFn: RequestReviewGateFn = async () => ({ decision: 'approved', note: '  trim me  ' });
      const tool = createReviewGateTool(store, requestFn);

      await tool.toolFn({ description: '  Padded description  ' });

      expect(store.reviewGates[0].description).toBe('Padded description');
      expect(store.reviewGates[0].userNote).toBe('trim me');
    });

    it('drops blank notes (whitespace only) instead of storing empty string', async () => {
      const store = createReviewGateStore();
      const requestFn: RequestReviewGateFn = async () => ({ decision: 'approved', note: '   ' });
      const tool = createReviewGateTool(store, requestFn);

      await tool.toolFn({ description: 'desc' });

      expect(store.reviewGates[0].userNote).toBeUndefined();
    });

    it('rejects empty description', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await expect(tool.toolFn({ description: '' })).rejects.toThrow('description must be a non-empty string');
      await expect(tool.toolFn({ description: '   ' })).rejects.toThrow('description must be a non-empty string');
    });

    it('rejects non-array options', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await expect(tool.toolFn({ description: 'desc', options: 'not an array' })).rejects.toThrow(
        'options must be an array'
      );
    });

    it('rejects non-string options entries', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await expect(tool.toolFn({ description: 'desc', options: ['ok', 42] })).rejects.toThrow(
        'each option must be a string'
      );
    });

    it('rejects non-string recommendation', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await expect(tool.toolFn({ description: 'desc', recommendation: 5 })).rejects.toThrow(
        'recommendation must be a string'
      );
    });

    it('rejects oversized description', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await expect(tool.toolFn({ description: 'a'.repeat(2001) })).rejects.toThrow(
        'description must be 2000 characters or fewer'
      );
    });

    it('rejects oversized recommendation', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await expect(tool.toolFn({ description: 'desc', recommendation: 'r'.repeat(1001) })).rejects.toThrow(
        'recommendation must be 1000 characters or fewer'
      );
    });

    it('rejects too many options', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await expect(
        tool.toolFn({ description: 'desc', options: Array.from({ length: 11 }, (_, i) => `opt-${i}`) })
      ).rejects.toThrow('options must contain 10 entries or fewer');
    });

    it('rejects oversized individual option', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await expect(tool.toolFn({ description: 'desc', options: ['ok', 'b'.repeat(501)] })).rejects.toThrow(
        'each option must be 500 characters or fewer'
      );
    });

    it('persists options and recommendation on the entry for audit trail', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await tool.toolFn({
        description: 'Pick an approach',
        options: ['rewrite', 'patch'],
        recommendation: 'patch — lower risk',
      });

      expect(store.reviewGates[0].options).toEqual(['rewrite', 'patch']);
      expect(store.reviewGates[0].recommendation).toBe('patch — lower risk');
    });

    it('omits options and recommendation on the entry when not provided', async () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      await tool.toolFn({ description: 'desc' });

      expect(store.reviewGates[0].options).toBeUndefined();
      expect(store.reviewGates[0].recommendation).toBeUndefined();
    });
  });

  describe('formatReviewGatesOutput', () => {
    it('shows message for empty list', () => {
      expect(formatReviewGatesOutput([])).toBe('No review gates recorded in this session.');
    });

    it('formats gates with status and note', () => {
      const output = formatReviewGatesOutput([
        {
          id: 'abc-12345678',
          timestamp: '2026-01-01T12:00:00Z',
          description: 'Refactor auth?',
          status: 'rejected',
          resolvedAt: '2026-01-01T12:01:00Z',
          userNote: 'too risky',
        },
      ]);

      expect(output).toContain('Refactor auth?');
      expect(output).toContain('Status: rejected');
      expect(output).toContain('Note: too risky');
    });

    it('omits note when not present', () => {
      const output = formatReviewGatesOutput([
        {
          id: 'abc',
          timestamp: '2026-01-01T12:00:00Z',
          description: 'A gate',
          status: 'approved',
        },
      ]);

      expect(output).not.toContain('Note:');
    });

    it('renders persisted options and recommendation when present', () => {
      const output = formatReviewGatesOutput([
        {
          id: 'abc',
          timestamp: '2026-01-01T12:00:00Z',
          description: 'A gate',
          status: 'approved',
          resolvedAt: '2026-01-01T12:01:00Z',
          options: ['rewrite', 'patch'],
          recommendation: 'patch — lower risk',
        },
      ]);

      expect(output).toContain('Recommendation: patch — lower risk');
      expect(output).toContain('Options:');
      expect(output).toContain('• rewrite');
      expect(output).toContain('• patch');
    });
  });

  describe('hydration (session resume)', () => {
    it('appends to pre-populated gates from a resumed session', async () => {
      const store = createReviewGateStore();
      store.reviewGates = [
        {
          id: 'existing-1',
          timestamp: '2026-01-01T10:00:00Z',
          description: 'Pre-existing gate',
          status: 'approved',
          resolvedAt: '2026-01-01T10:01:00Z',
        },
      ];

      const tool = createReviewGateTool(store, approveFn);
      await tool.toolFn({ description: 'New gate' });

      expect(store.reviewGates).toHaveLength(2);
      expect(store.reviewGates[0].id).toBe('existing-1');
      expect(store.reviewGates[1].description).toBe('New gate');
    });
  });

  describe('tool schema', () => {
    it('has correct name and required parameters', () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      expect(tool.toolSchema.name).toBe('request_review_gate');
      expect(tool.toolSchema.parameters.required).toEqual(['description']);
    });

    it('declares description, options, and recommendation parameters', () => {
      const store = createReviewGateStore();
      const tool = createReviewGateTool(store, approveFn);

      const props = tool.toolSchema.parameters.properties;
      expect(props.description).toBeDefined();
      expect(props.options).toBeDefined();
      expect(props.recommendation).toBeDefined();
    });
  });

  describe('decision typing', () => {
    it('supports approved and rejected decisions via the response type', () => {
      const a: ReviewGateResponse = { decision: 'approved' };
      const r: ReviewGateResponse = { decision: 'rejected', note: 'no' };
      expect(a.decision).toBe('approved');
      expect(r.decision).toBe('rejected');
    });
  });
});
