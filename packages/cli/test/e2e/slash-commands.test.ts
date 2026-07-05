/**
 * E2E test: slash-command surface.
 *
 * Snapshots the canonical list of built-in slash commands. Catches
 * accidentally-dropped commands during Q1 decomposition, when command
 * dispatch moves out of index.tsx into a registry under commands/.
 *
 * Update intentionally: when a command is added, removed, or its
 * description/args change, run with `-u` to refresh the snapshot.
 */

import { describe, it, expect } from 'vitest';
import { COMMANDS, getAllCommandNames } from '../../src/config/commands.js';

describe('e2e — slash-command surface', () => {
  it('matches the canonical built-in command list', () => {
    // Stable shape for the snapshot - name, description, args, aliases only.
    // Strips out any future fields that shouldn't gate this test.
    const surface = COMMANDS.map(c => ({
      name: c.name,
      description: c.description,
      args: c.args ?? null,
      aliases: c.aliases ?? [],
    })).sort((a, b) => a.name.localeCompare(b.name));

    expect(surface).toMatchSnapshot();
  });

  it('exposes a stable name list (sorted, including aliases)', () => {
    const names = getAllCommandNames().sort();
    expect(names).toMatchSnapshot();
  });

  it('every command has a non-empty description', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.description, `command "${cmd.name}" missing description`).toBeTruthy();
      expect(cmd.description.length).toBeGreaterThan(2);
    }
  });

  it('command names are unique (no duplicates across name + aliases)', () => {
    const seen = new Set<string>();
    for (const cmd of COMMANDS) {
      expect(seen.has(cmd.name), `duplicate name: ${cmd.name}`).toBe(false);
      seen.add(cmd.name);
      for (const alias of cmd.aliases ?? []) {
        expect(seen.has(alias), `duplicate alias "${alias}" on command ${cmd.name}`).toBe(false);
        seen.add(alias);
      }
    }
  });
});
