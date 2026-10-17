import { describe, it, expect } from 'vitest';
import { ToolCatalog } from '../toolCatalog.js';
import { assessCommandRisk, prependRiskBanner } from './commandRisk.js';

const catalog = new ToolCatalog();

describe('assessCommandRisk', () => {
  it('classifies the declared command argument', () => {
    expect(assessCommandRisk(catalog.resolve('bash_execute'), { command: 'rm -rf /' })?.level).toBe('high');
    expect(assessCommandRisk(catalog.resolve('write_shell_stdin'), { chars: 'rm -rf ~\n' })?.level).toBe('high');
    expect(assessCommandRisk(catalog.resolve('bash_execute'), { command: 'ls' })?.level).not.toBe('high');
  });

  it('returns null for a tool without a command argument or a call without one', () => {
    expect(assessCommandRisk(catalog.resolve('file_read'), { command: 'rm -rf /' })).toBeNull();
    expect(assessCommandRisk(catalog.resolve('shell_execute'), { command: 'rm -rf /' })).toBeNull();
    expect(assessCommandRisk(catalog.resolve('bash_execute'), {})).toBeNull();
    expect(assessCommandRisk(undefined, { command: 'rm -rf /' })).toBeNull();
  });
});

describe('prependRiskBanner', () => {
  it('lists the reasons above the preview', () => {
    const banner = prependRiskBanner('$ rm -rf /', ['deletes the root']);
    expect(banner).toMatch(/HIGH-RISK COMMAND/);
    expect(banner).toMatch(/- deletes the root\n\n\$ rm -rf \/$/);
  });

  it('falls back to a generic reason and works without a preview', () => {
    expect(prependRiskBanner(undefined, [])).toMatch(/- flagged by command analysis$/);
  });
});
