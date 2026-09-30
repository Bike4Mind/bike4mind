import type { IFabFileDocument } from '@bike4mind/common';

/** The stored tag names of a file, dropping anything this schemaless array holds that is not one. */
export const storedTagNames = (file: Pick<IFabFileDocument, 'tags'>): string[] =>
  (file.tags ?? []).map(t => t?.name).filter((name): name is string => typeof name === 'string');

/**
 * What the bulk tag doors' writes leave behind, predicted in memory so a membership diff can be
 * taken without re-reading the files. Both fold case, because `removeTagByUserId` /
 * `updateTagsByUserId` match the stored name case-INSENSITIVELY - predicting with a
 * case-sensitive comparison would miss exactly the differently-cased tag those writes do touch.
 */
export const withoutTagName = (names: readonly string[], removed: string): string[] => {
  const key = removed.toLocaleLowerCase();
  return names.filter(name => name.toLocaleLowerCase() !== key);
};

/** The rename counterpart: the new name is written verbatim, matching what the write stores. */
export const renamedTagName = (names: readonly string[], from: string, to: string): string[] => {
  const key = from.toLocaleLowerCase();
  return names.map(name => (name.toLocaleLowerCase() === key ? to : name));
};
