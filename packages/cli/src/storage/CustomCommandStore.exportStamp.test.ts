/**
 * A SKILL.md exported from Bike4Mind ("Use in Claude Code") carries a `# Bike4Mind-Source:` YAML
 * comment in its frontmatter. The loader must skip it so the account skill stays authoritative
 * (correct trust, no shadowing), while unstamped skills and a stamp in the body still load.
 *
 * Hermetic: os.homedir is mocked to an empty temp dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CustomCommandStore } from './CustomCommandStore.js';
import { parseFrontmatter } from '../utils/parseFrontmatter.js';

const STAMPED =
  '---\n# Bike4Mind-Source: https://app.example/skills/market/abc\nname: exported\ndescription: d\n---\n\nBody\n';
const BODY_ONLY = '---\nname: body-stamp\ndescription: d\n---\n\n# Bike4Mind-Source: https://app.example/skills/1\n';
const PLAIN = '---\ndescription: a hand-written skill\n---\nDo it.\n';

let projectRoot: string;
let fakeHome: string;

async function writeSkill(base: string, name: string, content: string): Promise<void> {
  const dir = path.join(base, '.claude', 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), content);
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

describe('CustomCommandStore skips Bike4Mind-exported skills', () => {
  it('skips a stamped global SKILL.md but loads unstamped and body-stamped ones', async () => {
    await writeSkill(fakeHome, 'exported', STAMPED);
    await writeSkill(fakeHome, 'body-stamp', BODY_ONLY);
    await writeSkill(fakeHome, 'plain', PLAIN);
    const store = new CustomCommandStore(projectRoot);
    await store.loadCommands();
    expect(store.hasCommand('exported')).toBe(false);
    expect(store.hasCommand('body-stamp')).toBe(true);
    expect(store.hasCommand('plain')).toBe(true);
  });

  it('skips a stamped project SKILL.md in a trusted project', async () => {
    await writeSkill(projectRoot, 'exported', STAMPED);
    await writeSkill(projectRoot, 'plain', PLAIN);
    const store = new CustomCommandStore(projectRoot);
    store.setProjectTrusted(true);
    await store.loadCommands();
    expect(store.hasCommand('exported')).toBe(false);
    expect(store.getCommand('plain')?.source).toBe('project');
  });

  it('has to read the raw fence text: parsed frontmatter drops the YAML comment', () => {
    expect(JSON.stringify(parseFrontmatter(STAMPED).data)).not.toContain('Bike4Mind-Source');
  });
});
