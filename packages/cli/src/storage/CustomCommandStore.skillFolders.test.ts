/**
 * A skill is a folder with SKILL.md, and only that file defines it. The rest of the folder
 * (references/, assets/, scripts/, README) is supporting material and must never surface as a
 * command, in the picker or to the model. Legacy single-file commands keep loading.
 *
 * Hermetic: os.homedir is mocked to an empty temp dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CustomCommandStore } from './CustomCommandStore.js';

let projectRoot: string;
let fakeHome: string;

async function write(base: string, relative: string, content: string): Promise<void> {
  const file = path.join(base, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function writeSkillWithSupportingDocs(base: string, folder: string): Promise<void> {
  await write(base, `${folder}/SKILL.md`, '---\nname: Brag\ndescription: Make a launch video\n---\nDo it.\n');
  await write(base, `${folder}/README.md`, '# Readme\n');
  await write(base, `${folder}/slim.md`, '# Slim\n');
  await write(base, `${folder}/references/step-1-inspect.md`, '# Step 1\n');
  await write(base, `${folder}/references/tones.md`, '# Tones\n');
  await write(base, `${folder}/scripts/nested/helper.md`, '# Helper\n');
}

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'b4m-cmdstore-proj-'));
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'b4m-cmdstore-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of [projectRoot, fakeHome]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

describe('CustomCommandStore skill folders', () => {
  it('loads a global skill folder as exactly one skill, from its SKILL.md', async () => {
    await writeSkillWithSupportingDocs(fakeHome, '.claude/skills/brag');

    const store = new CustomCommandStore(projectRoot);
    await store.loadCommands();

    expect(store.getAllCommands().map(command => command.name)).toEqual(['brag']);
    expect(store.getCommand('brag')).toMatchObject({
      displayName: 'Brag',
      description: 'Make a launch video',
      source: 'global',
    });
    for (const doc of ['README', 'slim', 'step-1-inspect', 'tones', 'helper']) {
      expect(store.hasCommand(doc)).toBe(false);
      expect(store.getModelReachableCommand(doc)).toBeUndefined();
    }
    expect(store.getModelReachableCommands().map(command => command.name)).toEqual(['brag']);
  });

  it('applies the same rule to a trusted project skill folder', async () => {
    await writeSkillWithSupportingDocs(projectRoot, '.claude/skills/deploy');

    const store = new CustomCommandStore(projectRoot);
    store.setProjectTrusted(true);
    await store.loadCommands();

    expect(store.getAllCommands().map(command => `${command.source}:${command.name}`)).toEqual(['project:deploy']);
  });

  it('keeps legacy single-file commands, including namespaced ones and loose skills-dir files', async () => {
    await write(fakeHome, '.claude/commands/review.md', '---\ndescription: Review\n---\nReview it.\n');
    await write(fakeHome, '.claude/commands/frontend/component.md', 'Make a component.\n');
    await write(fakeHome, '.bike4mind/commands/standup.md', 'Write a standup.\n');
    await write(projectRoot, '.claude/commands/ship.md', 'Ship it.\n');
    await write(projectRoot, '.claude/skills/loose.md', 'A loose file.\n');

    const store = new CustomCommandStore(projectRoot);
    store.setProjectTrusted(true);
    await store.loadCommands();

    expect(
      store
        .getAllCommands()
        .map(command => `${command.source}:${command.name}`)
        .sort()
    ).toEqual(['global:component', 'global:review', 'global:standup', 'project:loose', 'project:ship']);
  });
});
