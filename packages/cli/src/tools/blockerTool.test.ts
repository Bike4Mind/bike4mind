import { describe, it, expect, vi } from 'vitest';
import { createBlockerTools, createBlockerStore, formatBlockersOutput } from './blockerTool';
import type { WorkflowBlocker } from '../storage/types.js';

describe('blockerTool', () => {
  describe('createBlockerStore', () => {
    it('creates an empty store', () => {
      const store = createBlockerStore();
      expect(store.blockers).toEqual([]);
    });
  });

  describe('track_blocker tool', () => {
    it('tracks a blocker', async () => {
      const store = createBlockerStore();
      const [trackTool] = createBlockerTools(store);

      const result = await trackTool.toolFn({ description: 'Need staging DB credentials' });

      expect(store.blockers).toHaveLength(1);
      expect(store.blockers[0].description).toBe('Need staging DB credentials');
      expect(store.blockers[0].status).toBe('open');
      expect(store.blockers[0].id).toBeDefined();
      expect(store.blockers[0].createdAt).toBeDefined();
      expect(result).toContain('Blocker tracked');
      expect(result).toContain('1 open blocker');
    });

    it('tracks multiple blockers', async () => {
      const store = createBlockerStore();
      const [trackTool] = createBlockerTools(store);

      await trackTool.toolFn({ description: 'Blocker 1' });
      const result = await trackTool.toolFn({ description: 'Blocker 2' });

      expect(store.blockers).toHaveLength(2);
      expect(result).toContain('2 open blockers');
    });

    it('calls onUpdate callback', async () => {
      const onUpdate = vi.fn();
      const store = createBlockerStore(onUpdate);
      const [trackTool] = createBlockerTools(store);

      await trackTool.toolFn({ description: 'A blocker' });

      expect(onUpdate).toHaveBeenCalledTimes(1);
    });

    it('rejects empty description', async () => {
      const store = createBlockerStore();
      const [trackTool] = createBlockerTools(store);

      await expect(trackTool.toolFn({ description: '' })).rejects.toThrow('description must be a non-empty string');
    });

    it('has correct schema', () => {
      const store = createBlockerStore();
      const [trackTool] = createBlockerTools(store);

      expect(trackTool.toolSchema.name).toBe('track_blocker');
      expect(trackTool.toolSchema.parameters.required).toEqual(['description']);
    });
  });

  describe('resolve_blocker tool', () => {
    it('resolves a blocker by full ID', async () => {
      const store = createBlockerStore();
      const [trackTool, resolveTool] = createBlockerTools(store);

      await trackTool.toolFn({ description: 'Missing API key' });
      const blockerId = store.blockers[0].id;

      const result = await resolveTool.toolFn({
        blocker_id: blockerId,
        resolution: 'Got the key from 1Password',
      });

      expect(store.blockers[0].status).toBe('resolved');
      expect(store.blockers[0].resolution).toBe('Got the key from 1Password');
      expect(store.blockers[0].resolvedAt).toBeDefined();
      expect(result).toContain('Blocker resolved');
      expect(result).toContain('0 open blockers');
    });

    it('resolves a blocker by partial ID (first 8 chars)', async () => {
      const store = createBlockerStore();
      const [trackTool, resolveTool] = createBlockerTools(store);

      await trackTool.toolFn({ description: 'Waiting on review' });
      const partialId = store.blockers[0].id.slice(0, 8);

      const result = await resolveTool.toolFn({
        blocker_id: partialId,
        resolution: 'Review completed',
      });

      expect(store.blockers[0].status).toBe('resolved');
      expect(result).toContain('Blocker resolved');
    });

    it('handles non-existent blocker ID', async () => {
      const store = createBlockerStore();
      const [trackTool, resolveTool] = createBlockerTools(store);

      await trackTool.toolFn({ description: 'Some blocker' });

      const result = await resolveTool.toolFn({
        blocker_id: 'nonexistent',
        resolution: 'Fixed',
      });

      expect(result).toContain('Blocker not found');
    });

    it('handles already resolved blocker', async () => {
      const store = createBlockerStore();
      const [trackTool, resolveTool] = createBlockerTools(store);

      await trackTool.toolFn({ description: 'Some blocker' });
      const blockerId = store.blockers[0].id;

      await resolveTool.toolFn({ blocker_id: blockerId, resolution: 'Fixed once' });
      const result = await resolveTool.toolFn({ blocker_id: blockerId, resolution: 'Fixed again' });

      expect(result).toContain('already resolved');
    });

    it('handles no open blockers', async () => {
      const store = createBlockerStore();
      const [, resolveTool] = createBlockerTools(store);

      const result = await resolveTool.toolFn({
        blocker_id: 'anything',
        resolution: 'Fixed',
      });

      expect(result).toContain('No open blockers');
    });

    it('rejects empty blocker_id', async () => {
      const store = createBlockerStore();
      const [, resolveTool] = createBlockerTools(store);

      await expect(resolveTool.toolFn({ blocker_id: '', resolution: 'Fixed' })).rejects.toThrow(
        'blocker_id must be a non-empty string'
      );
    });

    it('rejects empty resolution', async () => {
      const store = createBlockerStore();
      const [, resolveTool] = createBlockerTools(store);

      await expect(resolveTool.toolFn({ blocker_id: 'some-id', resolution: '' })).rejects.toThrow(
        'resolution must be a non-empty string'
      );
    });

    it('has correct schema', () => {
      const store = createBlockerStore();
      const [, resolveTool] = createBlockerTools(store);

      expect(resolveTool.toolSchema.name).toBe('resolve_blocker');
      expect(resolveTool.toolSchema.parameters.required).toEqual(['blocker_id', 'resolution']);
    });
  });

  describe('hydration (session resume)', () => {
    it('appends to pre-populated blockers from a resumed session', async () => {
      const store = createBlockerStore();
      // Simulate hydration from a resumed session
      store.blockers = [
        {
          id: 'existing-blocker-1',
          createdAt: '2026-01-01T10:00:00Z',
          description: 'Pre-existing blocker',
          status: 'open',
        },
      ];

      const [trackTool] = createBlockerTools(store);
      await trackTool.toolFn({ description: 'New blocker' });

      expect(store.blockers).toHaveLength(2);
      expect(store.blockers[0].id).toBe('existing-blocker-1');
      expect(store.blockers[0].description).toBe('Pre-existing blocker');
      expect(store.blockers[1].description).toBe('New blocker');
    });

    it('resolves a pre-populated blocker from a resumed session', async () => {
      const store = createBlockerStore();
      store.blockers = [
        {
          id: 'existing-blocker-abc12345',
          createdAt: '2026-01-01T10:00:00Z',
          description: 'Waiting on credentials',
          status: 'open',
        },
      ];

      const [, resolveTool] = createBlockerTools(store);
      const result = await resolveTool.toolFn({
        blocker_id: 'existing',
        resolution: 'Got them from vault',
      });

      expect(store.blockers[0].status).toBe('resolved');
      expect(store.blockers[0].resolution).toBe('Got them from vault');
      expect(result).toContain('Blocker resolved');
    });

    it('counts open blockers correctly with mixed hydrated state', async () => {
      const store = createBlockerStore();
      store.blockers = [
        {
          id: 'resolved-1',
          createdAt: '',
          description: 'Done',
          status: 'resolved',
          resolvedAt: '',
          resolution: 'Fixed',
        },
        { id: 'open-1', createdAt: '', description: 'Still blocked', status: 'open' },
      ];

      const [trackTool] = createBlockerTools(store);
      const result = await trackTool.toolFn({ description: 'Another blocker' });

      expect(store.blockers).toHaveLength(3);
      expect(result).toContain('2 open blockers');
    });
  });

  describe('formatBlockersOutput', () => {
    it('shows message for empty list', () => {
      expect(formatBlockersOutput([])).toBe('No blockers tracked in this session.');
    });

    it('formats open blockers', () => {
      const output = formatBlockersOutput([
        {
          id: 'abc-12345678',
          createdAt: '2026-01-01T12:00:00Z',
          description: 'Need API access',
          status: 'open',
        },
      ]);

      expect(output).toContain('Open blockers (1)');
      expect(output).toContain('Need API access');
    });

    it('formats resolved blockers with resolution', () => {
      const output = formatBlockersOutput([
        {
          id: 'abc-12345678',
          createdAt: '2026-01-01T12:00:00Z',
          resolvedAt: '2026-01-01T13:00:00Z',
          description: 'Missing config',
          resolution: 'Added to .env',
          status: 'resolved',
        },
      ]);

      expect(output).toContain('Resolved blockers (1)');
      expect(output).toContain('Missing config');
      expect(output).toContain('Added to .env');
    });

    it('handles undefined resolution gracefully', () => {
      const output = formatBlockersOutput([
        {
          id: 'abc-12345678',
          createdAt: '2026-01-01T12:00:00Z',
          description: 'Corrupted entry',
          status: 'resolved',
          resolvedAt: '2026-01-01T13:00:00Z',
          // resolution intentionally omitted to simulate corrupted data
        } as WorkflowBlocker,
      ]);

      expect(output).toContain('Resolved blockers (1)');
      expect(output).not.toContain('undefined');
      expect(output).toContain('(no resolution recorded)');
    });

    it('separates open and resolved blockers', () => {
      const output = formatBlockersOutput([
        { id: 'a', createdAt: '', description: 'Open one', status: 'open' },
        { id: 'b', createdAt: '', description: 'Resolved one', status: 'resolved', resolvedAt: '', resolution: 'Done' },
      ]);

      expect(output).toContain('Open blockers (1)');
      expect(output).toContain('Resolved blockers (1)');
    });
  });
});
