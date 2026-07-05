import { describe, it, expect } from 'vitest';
import { latticeToolDefinitions } from './cliTools';
import { LATTICE_TOOL_NAMES } from './index';

/**
 * `LATTICE_TOOL_NAMES` (names only, web-safe `tools/index`) and
 * `latticeToolDefinitions` (implementations, CLI-isolated `cliTools`) live in
 * separate modules on purpose - the Next app must not trace the tool
 * implementations. That split means the two can silently drift: a name added to
 * one without the other would make `enableLattice` either advertise a tool with
 * no implementation (silently dropped by `buildSharedTools`) or register an
 * implementation no consumer ever enables. This guards that invariant.
 */
describe('Lattice tool name/definition sync', () => {
  it('has a definition for every name in LATTICE_TOOL_NAMES', () => {
    for (const name of LATTICE_TOOL_NAMES) {
      expect(latticeToolDefinitions[name as keyof typeof latticeToolDefinitions]).toBeDefined();
    }
  });

  it('has a name in LATTICE_TOOL_NAMES for every definition', () => {
    expect(Object.keys(latticeToolDefinitions).sort()).toEqual([...LATTICE_TOOL_NAMES].sort());
  });

  it('exposes the expected six Lattice tools', () => {
    expect(LATTICE_TOOL_NAMES).toHaveLength(6);
  });
});
