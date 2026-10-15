import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SidebarSectionStore } from './SidebarSectionStore';

async function sectionsFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'b4m-sidebar-sections-')), 'sidebar-sections.json');
}

function sequentialIds() {
  let next = 0;
  return () => `section-${++next}`;
}

describe('SidebarSectionStore', () => {
  it('starts with no sections', async () => {
    expect(await new SidebarSectionStore(await sectionsFile()).read()).toEqual({ sections: [], assignments: {} });
  });

  it('survives a restart', async () => {
    const file = await sectionsFile();
    await new SidebarSectionStore(file, sequentialIds()).create('Work', 'session-a');

    expect(await new SidebarSectionStore(file).read()).toEqual({
      sections: [{ id: 'section-1', name: 'Work' }],
      assignments: { 'session-a': 'section-1' },
    });
  });

  it('creates without a session, and normalizes the name', async () => {
    const store = new SidebarSectionStore(await sectionsFile(), sequentialIds());

    const state = await store.create('  Side   projects ');

    expect(state).toEqual({ sections: [{ id: 'section-1', name: 'Side projects' }], assignments: {} });
  });

  it('refuses a blank name', async () => {
    const store = new SidebarSectionStore(await sectionsFile(), sequentialIds());

    expect((await store.create('   ')).sections).toEqual([]);
    await store.create('Work');
    expect((await store.rename('section-1', '  ')).sections).toEqual([{ id: 'section-1', name: 'Work' }]);
  });

  it('renames a section', async () => {
    const store = new SidebarSectionStore(await sectionsFile(), sequentialIds());
    await store.create('Work');

    expect((await store.rename('section-1', 'Day job')).sections).toEqual([{ id: 'section-1', name: 'Day job' }]);
  });

  it('deleting a section returns its sessions to the default list and keeps the others', async () => {
    const store = new SidebarSectionStore(await sectionsFile(), sequentialIds());
    await store.create('Work', 'session-a');
    await store.create('Home', 'session-b');
    await store.move('session-c', 'section-1');

    const state = await store.remove('section-1');

    expect(state).toEqual({ sections: [{ id: 'section-2', name: 'Home' }], assignments: { 'session-b': 'section-2' } });
  });

  it('moves a session between sections and out of them', async () => {
    const store = new SidebarSectionStore(await sectionsFile(), sequentialIds());
    await store.create('Work', 'session-a');
    await store.create('Home');

    expect((await store.move('session-a', 'section-2')).assignments).toEqual({ 'session-a': 'section-2' });
    expect((await store.move('session-a', null)).assignments).toEqual({});
  });

  it('ignores a move into a section that does not exist', async () => {
    const store = new SidebarSectionStore(await sectionsFile(), sequentialIds());

    expect((await store.move('session-a', 'missing')).assignments).toEqual({});
  });

  it('forgets a deleted session', async () => {
    const store = new SidebarSectionStore(await sectionsFile(), sequentialIds());
    await store.create('Work', 'session-a');

    expect((await store.forgetSession('session-a')).assignments).toEqual({});
  });

  it('keeps both of two changes made at once', async () => {
    const file = await sectionsFile();
    const store = new SidebarSectionStore(file, sequentialIds());

    await Promise.all([store.create('Work'), store.create('Home')]);

    expect((await new SidebarSectionStore(file).read()).sections.map(section => section.name)).toEqual([
      'Work',
      'Home',
    ]);
  });

  it('reads a corrupt file as no sections', async () => {
    const file = await sectionsFile();
    await writeFile(file, '{not json', 'utf8');

    expect(await new SidebarSectionStore(file).read()).toEqual({ sections: [], assignments: {} });
  });

  it('drops blank, duplicate and dangling entries from a hand-edited file', async () => {
    const file = await sectionsFile();
    await writeFile(
      file,
      JSON.stringify({
        sections: [
          { id: 'a', name: 'Work' },
          { id: 'a', name: 'Duplicate' },
          { id: 'b', name: '   ' },
        ],
        assignments: { one: 'a', two: 'b', three: 'gone' },
      }),
      'utf8'
    );

    expect(await new SidebarSectionStore(file).read()).toEqual({
      sections: [{ id: 'a', name: 'Work' }],
      assignments: { one: 'a' },
    });
  });

  it('writes the file only when something changed', async () => {
    const file = await sectionsFile();
    const store = new SidebarSectionStore(file, sequentialIds());
    await store.create('Work');
    await writeFile(file, 'sentinel', 'utf8');

    await store.move('session-a', 'missing');

    expect(await readFile(file, 'utf8')).toBe('sentinel');
  });

  it('does not restore stale state when a first read races an update', async () => {
    const file = await sectionsFile();
    await new SidebarSectionStore(file, sequentialIds()).create('Work');
    const store = new SidebarSectionStore(file, sequentialIds());

    const [, created] = await Promise.all([store.read(), store.create('Home')]);

    expect(created.sections.map(section => section.name)).toEqual(['Work', 'Home']);
    expect((await store.read()).sections.map(section => section.name)).toEqual(['Work', 'Home']);
  });

  it('treats an inherited property name as an unassigned session', async () => {
    const store = new SidebarSectionStore(await sectionsFile(), sequentialIds());
    await store.create('Work');

    expect(await store.move('toString', null)).toEqual({ sections: [{ id: 'section-1', name: 'Work' }], assignments: {} });
  });
});
