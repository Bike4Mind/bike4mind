import { STUDIO_COMPOSITION_LIMITS, type StudioCharacter, type StudioShot, randomUuid } from '@bike4mind/common';

/**
 * Pure edits on a production's saved characters (brand kit) and on which shots feature them. Shots point at
 * characters by id; generate_shot passes the featured characters' images as references (selectShotReferences).
 */

const { brandCharactersMax, characterNameMaxLength } = STUDIO_COMPOSITION_LIMITS;

const nameFromFile = (fileName: string | undefined): string =>
  (fileName ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .slice(0, characterNameMaxLength) || 'Character';

/** Adds one character per picked image not already a character, up to the kit's cap. */
export const addCharacters = (
  characters: readonly StudioCharacter[],
  files: readonly { id: string; fileName?: string }[]
): StudioCharacter[] => {
  const added = files
    .filter(file => !characters.some(character => character.fileId === file.id))
    .map(file => ({ id: `character-${randomUuid()}`, name: nameFromFile(file.fileName), fileId: file.id }));
  return [...characters, ...added].slice(0, brandCharactersMax);
};

/** A blank name keeps the old one: names are required. */
export const renameCharacter = (
  characters: readonly StudioCharacter[],
  characterId: string,
  name: string
): StudioCharacter[] => {
  const trimmed = name.trim().slice(0, characterNameMaxLength);
  return characters.map(character =>
    character.id === characterId && trimmed ? { ...character, name: trimmed } : character
  );
};

export const removeCharacter = (characters: readonly StudioCharacter[], characterId: string): StudioCharacter[] =>
  characters.filter(character => character.id !== characterId);

/**
 * Adds the character to the shot, or takes it off. A new one goes last, since the order decides which characters
 * keep a reference slot on a model with a small cap. Ids no longer in the kit are dropped first so they cannot
 * take up a slot.
 */
export const toggleShotCharacter = (
  shots: StudioShot[],
  shotId: string,
  characterId: string,
  kit: readonly StudioCharacter[]
): StudioShot[] =>
  shots.map(shot => {
    if (shot.id !== shotId) return shot;
    const current = (shot.characterIds ?? []).filter(id => kit.some(character => character.id === id));
    const next = current.includes(characterId)
      ? current.filter(id => id !== characterId)
      : [...current, characterId].slice(0, brandCharactersMax);
    const { characterIds: _old, ...rest } = shot;
    return next.length > 0 ? { ...rest, characterIds: next } : rest;
  });
