import { describe, expect, it } from 'vitest';
import { STUDIO_COMPOSITION_LIMITS, type StudioCharacter, type StudioShot } from '@bike4mind/common';
import { addCharacters, removeCharacter, renameCharacter, toggleShotCharacter } from './characterEdits';

const FILE_A = 'a'.repeat(24);
const FILE_B = 'b'.repeat(24);

const maya: StudioCharacter = { id: 'maya', name: 'Maya', fileId: FILE_A };
const fox: StudioCharacter = { id: 'fox', name: 'Fox', fileId: FILE_B };
const shot = (id: string, overrides: Partial<StudioShot> = {}): StudioShot => ({
  id,
  title: id,
  fileIds: [],
  ...overrides,
});

describe('addCharacters', () => {
  it('names a new character from its file name and gives it a valid id', () => {
    const [added] = addCharacters([], [{ id: FILE_B, fileName: 'fox_mascot-v2.png' }]);
    expect(added).toMatchObject({ name: 'fox mascot v2', fileId: FILE_B });
    expect(added?.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('skips an image that is already a character and stops at the cap', () => {
    expect(addCharacters([maya], [{ id: FILE_A, fileName: 'again.png' }])).toEqual([maya]);
    const many = Array.from({ length: 20 }, (_, n) => ({
      id: n.toString(16).padStart(24, '0'),
      fileName: `c${n}.png`,
    }));
    expect(addCharacters([], many)).toHaveLength(STUDIO_COMPOSITION_LIMITS.brandCharactersMax);
  });
});

describe('renameCharacter / removeCharacter', () => {
  it('renames, keeping the old name when the new one is blank', () => {
    expect(renameCharacter([maya], 'maya', '  Dr. Maya ')[0]?.name).toBe('Dr. Maya');
    expect(renameCharacter([maya], 'maya', '   ')[0]?.name).toBe('Maya');
  });

  it('removes by id', () => {
    expect(removeCharacter([maya], 'maya')).toEqual([]);
  });
});

describe('toggleShotCharacter', () => {
  it('adds characters to one shot in the order they are picked', () => {
    const shots = [shot('s1'), shot('s2')];
    const once = toggleShotCharacter(shots, 's1', 'fox', [fox, maya]);
    const twice = toggleShotCharacter(once, 's1', 'maya', [fox, maya]);
    expect(twice[0]?.characterIds).toEqual(['fox', 'maya']);
    expect(twice[1]).toEqual(shot('s2'));
  });

  it('takes a featured character off and drops the field once empty', () => {
    const shots = [shot('s1', { characterIds: ['maya'] })];
    expect(toggleShotCharacter(shots, 's1', 'maya', [maya])[0]).toEqual(shot('s1'));
  });

  it('drops ids that are no longer in the kit, so they cannot block adding at the cap', () => {
    const max = STUDIO_COMPOSITION_LIMITS.brandCharactersMax;
    const stale = Array.from({ length: max }, (_, n) => `gone-${n}`);
    const shots = [shot('s1', { characterIds: stale })];
    expect(toggleShotCharacter(shots, 's1', 'maya', [maya])[0]?.characterIds).toEqual(['maya']);
  });
});
