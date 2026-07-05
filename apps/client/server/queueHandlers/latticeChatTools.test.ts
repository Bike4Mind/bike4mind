import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '@bike4mind/services/llm/tools';
import { latticeToolDefinitions } from '@bike4mind/services/llm/tools/cliTools';
import { withLatticeTools } from './latticeChatTools';

// A stand-in base tool so we can assert the existing externalTools (Slack /
// pending-action) survive the merge untouched.
const baseTool = { description: 'base', parameters: {} } as unknown as ToolDefinition;

describe('withLatticeTools', () => {
  it('is a no-op when the flag is undefined — returns the base unchanged', () => {
    const base = { base_tool: baseTool };
    expect(withLatticeTools(base, undefined)).toBe(base);
  });

  it('is a no-op when the flag is false — returns the base unchanged', () => {
    const base = { base_tool: baseTool };
    expect(withLatticeTools(base, false)).toBe(base);
  });

  it('returns undefined unchanged when there are no base tools and the flag is unset', () => {
    expect(withLatticeTools(undefined, false)).toBeUndefined();
  });

  it('merges the Lattice definitions when the flag is set', () => {
    const result = withLatticeTools(undefined, true);
    // Registering names without the backing definitions makes the tools a
    // silent no-op - this test guards against that regression.
    expect(result).toEqual({ ...latticeToolDefinitions });
  });

  it('preserves the base tools alongside the Lattice definitions', () => {
    const base = { base_tool: baseTool };
    const result = withLatticeTools(base, true);
    expect(result).toMatchObject({ base_tool: baseTool, ...latticeToolDefinitions });
    // Does not mutate the caller's base map.
    expect(base).toEqual({ base_tool: baseTool });
  });
});
