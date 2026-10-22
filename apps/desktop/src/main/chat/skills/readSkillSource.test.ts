import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SKILL_FILE_BYTES, readSkillSource } from './readSkillSource';

describe('readSkillSource', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skill-source-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a folder through its SKILL.md, falling back to the folder name, and lists the other files', async () => {
    const skill = join(dir, 'Code-Review');
    await mkdir(skill);
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\ndescription: Reviews code\nallowed-tools: Bash, Read\nmodel: opus\n---\nReview it.'
    );
    for (const name of ['a.py', 'b.md', 'c', 'd', 'e', 'f', '.DS_Store']) await writeFile(join(skill, name), '');

    expect(await readSkillSource(skill)).toEqual({
      ok: true,
      fields: { name: 'code-review', description: 'Reviews code', body: 'Review it.' },
      dropped: ['allowed-tools', 'model'],
      extraFiles: ['a.py', 'b.md', 'c', 'd', 'e'],
      extraFileCount: 6,
    });
  });

  it('prefers the frontmatter name, and names a lone .md file after itself without listing siblings', async () => {
    await writeFile(join(dir, 'deploy.md'), 'Deploy it.');
    await writeFile(join(dir, 'other.md'), '');
    expect(await readSkillSource(join(dir, 'deploy.md'))).toMatchObject({
      ok: true,
      fields: { name: 'deploy', body: 'Deploy it.' },
      extraFileCount: 0,
    });

    await writeFile(join(dir, 'named.md'), '---\nname: " Shipper "\n---\nx');
    expect(await readSkillSource(join(dir, 'named.md'))).toMatchObject({ fields: { name: 'shipper' } });
  });

  it('passes the export stamp through', async () => {
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\n# Bike4Mind-Source: https://app.example.test/skills/market/l1\n# Third-party skill from the Bike4Mind Skill Market - review before use\nname: x\n---\nb'
    );
    expect(await readSkillSource(join(dir, 'SKILL.md'))).toMatchObject({
      source: { url: 'https://app.example.test/skills/market/l1', thirdParty: true },
    });
  });

  it('refuses a folder without SKILL.md, an oversized file and a malformed one', async () => {
    expect(await readSkillSource(dir)).toEqual({ ok: false, error: 'No SKILL.md in that folder.' });

    await writeFile(join(dir, 'big.md'), 'x'.repeat(MAX_SKILL_FILE_BYTES + 1));
    expect(await readSkillSource(join(dir, 'big.md'))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/too large/),
    });

    await writeFile(join(dir, 'bad.md'), '---\nname: x\n');
    expect(await readSkillSource(join(dir, 'bad.md'))).toMatchObject({ ok: false });

    expect(await readSkillSource(join(dir, 'missing.md'))).toEqual({
      ok: false,
      error: 'That file could not be read.',
    });
  });
});
