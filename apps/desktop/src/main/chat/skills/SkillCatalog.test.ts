import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProjectTrustStore } from './ProjectTrustStore';
import { SkillCatalog } from './SkillCatalog';

/**
 * The gate, not the loader. Discovery is the CLI's and has its own tests; what is proven here is
 * that a project's skills stay inert until the user says otherwise, that the decision survives a
 * restart, and that a session with no project cannot reach them at all.
 */
describe('SkillCatalog project trust', () => {
  let base: string;
  let project: string;
  let trustFile: string;

  const catalog = () => new SkillCatalog(new ProjectTrustStore(trustFile));

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-skills-')));
    project = join(base, 'repo');
    trustFile = join(base, 'trust.json');
    const skillDir = join(project, '.claude', 'skills', 'deploy');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'description: Ship it', 'argument-hint: "[env]"', '---', '', 'Deploy to $1.'].join('\n'),
      'utf8'
    );
  });

  it('withholds a project skill until the project is trusted', async () => {
    const state = await catalog().state(project);
    expect(state.skills.some(skill => skill.name === 'deploy')).toBe(false);
    expect(state.untrustedProject).toBe(project);
    expect(state.projectDirectory).toBeNull();
  });

  it('refuses to resolve a withheld project skill for the send path', async () => {
    await expect(catalog().get(project, 'deploy')).resolves.toBeUndefined();
  });

  it('loads the project skill once trusted, and labels where it came from', async () => {
    const store = catalog();
    await store.setTrusted(project, true);

    const state = await store.state(project);
    const deploy = state.skills.find(skill => skill.name === 'deploy');
    expect(deploy).toMatchObject({ source: 'project', description: 'Ship it', argumentHint: '[env]' });
    expect(state.untrustedProject).toBeNull();
    expect(state.projectDirectory).toBe(project);
  });

  it('remembers the decision across instances, so the user is asked once', async () => {
    await catalog().setTrusted(project, true);
    await expect(catalog().get(project, 'deploy')).resolves.toBeDefined();
  });

  it('withholds it again after the trust is revoked', async () => {
    const store = catalog();
    await store.setTrusted(project, true);
    await store.setTrusted(project, false);
    await expect(store.get(project, 'deploy')).resolves.toBeUndefined();
  });

  it('trusting one project says nothing about a sibling', async () => {
    const sibling = join(base, 'other-repo');
    await mkdir(join(sibling, '.claude', 'skills', 'deploy'), { recursive: true });
    await writeFile(join(sibling, '.claude', 'skills', 'deploy', 'SKILL.md'), 'Evil.', 'utf8');

    const store = catalog();
    await store.setTrusted(project, true);

    const state = await store.state(sibling);
    expect(state.untrustedProject).toBe(sibling);
    expect(state.skills.some(skill => skill.name === 'deploy')).toBe(false);
  });

  it('offers no project skill at all to a session with no project', async () => {
    const store = catalog();
    await store.setTrusted(project, true);

    // A Chat session passes null: it has no project binding, so a repo skill must not even be
    // advertised - it could not run here.
    const state = await store.state(null);
    expect(state.skills.every(skill => skill.source === 'global')).toBe(true);
    expect(state.projectDirectory).toBeNull();
    expect(state.untrustedProject).toBeNull();
  });
});
