import { describe, expect, it } from 'vitest';
import {
  PAGE_ENTRIES,
  SETTING_KEYWORDS,
  SETTINGS_SECTIONS,
  isSettingsSection,
  matchSettings,
  resolveSettingsLink,
  sectionOfSetting,
} from './settingsNavigation';

describe('resolveSettingsLink', () => {
  it('takes a current page as it is', () => {
    expect(resolveSettingsLink({ section: 'notifications' })).toEqual({ section: 'notifications' });
    expect(resolveSettingsLink({})).toEqual({});
  });

  it.each([
    ['servers', 'models', 'model-servers'],
    ['import', 'privacy', 'claude-import'],
    ['worktrees', 'advanced', 'worktrees'],
  ])('sends the old %s page to the row that replaced it', (legacy, section, setting) => {
    expect(resolveSettingsLink({ section: legacy })).toEqual({ section, setting });
  });

  it('keeps the Claude import source to scroll to', () => {
    expect(resolveSettingsLink({ section: 'import', focus: 'claude-code' })).toEqual({
      section: 'privacy',
      setting: 'claude-import',
      focus: 'claude-code',
    });
  });

  it('lets a known row decide the page', () => {
    expect(resolveSettingsLink({ setting: 'updates' })).toEqual({ section: 'about', setting: 'updates' });
    expect(resolveSettingsLink({ section: 'general', setting: 'updates' })).toEqual({
      section: 'about',
      setting: 'updates',
    });
  });

  it('drops what it does not know', () => {
    expect(resolveSettingsLink({ section: 'billing', setting: 'nope', focus: 'nope' })).toEqual({});
    expect(resolveSettingsLink({ section: 'billing', setting: 'appearance' })).toEqual({
      section: 'general',
      setting: 'appearance',
    });
    expect(isSettingsSection('servers')).toBe(false);
  });
});

describe('PAGE_ENTRIES', () => {
  it('puts each setting on one page and gives each search words', () => {
    const ids = SETTINGS_SECTIONS.flatMap(section => [...PAGE_ENTRIES[section]]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(SETTING_KEYWORDS).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(SETTINGS_SECTIONS).toContain(sectionOfSetting(id));
  });
});

describe('matchSettings', () => {
  const entries = [
    {
      id: 'appearance',
      label: 'Appearance',
      summary: 'System (dark)',
      description: 'Choose a light or dark appearance.',
    },
    { id: 'orchestrator-sound', label: 'Play sounds', summary: 'Sounds are on.' },
    { id: 'updates', label: 'Updates', summary: 'Version 1.2.3' },
    { id: 'model-servers', label: 'Model servers', summary: 'Only this computer.' },
  ];
  const ids = (query: string) => matchSettings(query, entries).map(entry => entry.id);

  it('finds a setting by a word it does not show', () => {
    expect(ids('theme')).toEqual(['appearance']);
    expect(ids('chime')).toEqual(['orchestrator-sound']);
    expect(ids('ollama')).toEqual(['model-servers']);
  });

  it('matches its label, summary and page name, ignoring case', () => {
    expect(ids('PLAY')).toEqual(['orchestrator-sound']);
    expect(ids('1.2.3')).toEqual(['updates']);
    expect(ids('about')).toEqual(['updates']);
  });

  it('needs every word to match', () => {
    expect(ids('dark mode')).toEqual(['appearance']);
    expect(ids('dark version')).toEqual([]);
  });

  it('matches nothing for an empty query', () => {
    expect(ids('')).toEqual([]);
    expect(ids('   ')).toEqual([]);
  });
});
