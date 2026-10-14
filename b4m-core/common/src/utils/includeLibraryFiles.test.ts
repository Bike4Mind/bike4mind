import { describe, expect, it } from 'vitest';
import { effectiveIncludeLibraryFiles, libraryFlagForScope, retrievalTagsNameALake } from './includeLibraryFiles';

describe('effectiveIncludeLibraryFiles', () => {
  it.each([
    [undefined, false, true],
    [undefined, true, false],
    [false, false, false],
    [true, true, true],
  ])('flag %s, namesALake %s -> %s', (flag, namesALake, expected) => {
    expect(effectiveIncludeLibraryFiles(flag, namesALake)).toBe(expected);
  });
});

describe('retrievalTagsNameALake', () => {
  it.each<[string[] | undefined, string[], boolean]>([
    [undefined, ['acme:'], false],
    [[], ['acme:'], false],
    [['datalake:x'], [], true],
    [['acme:'], ['acme:'], true],
    [['legal:review'], ['acme:'], false],
  ])('tags %j, prefixes %j -> %s', (tags, prefixes, expected) => {
    expect(retrievalTagsNameALake(tags, prefixes)).toBe(expected);
  });
});

describe('libraryFlagForScope', () => {
  it('an explicit flag wins', () => {
    expect(libraryFlagForScope({ includeLibraryFiles: false })).toBe(false);
    expect(libraryFlagForScope({ includeLibraryFiles: true, forceKnowledgeRetrieval: true })).toBe(true);
    expect(libraryFlagForScope({ includeLibraryFiles: false, forceKnowledgeRetrieval: true })).toBe(false);
  });

  it('Data Lakes mode OFF includes the library over a stored false, which ON then restores', () => {
    const off = { includeLibraryFiles: false, lakeScopeExplicit: true, forceKnowledgeRetrieval: false };
    expect(libraryFlagForScope(off)).toBe(true);
    expect(libraryFlagForScope({ ...off, forceKnowledgeRetrieval: true })).toBe(false);
    expect(libraryFlagForScope({ lakeScopeExplicit: true, forceKnowledgeRetrieval: false })).toBe(true);
  });

  it('unset in a chat whose lake tags were only derived from an attachment includes the library', () => {
    expect(libraryFlagForScope({})).toBe(true);
    expect(libraryFlagForScope({ forceKnowledgeRetrieval: false })).toBe(true);
  });

  it('unset stays unset when the user picked a lake', () => {
    expect(libraryFlagForScope({ lakeScopeExplicit: true })).toBeUndefined();
    expect(libraryFlagForScope({ forceKnowledgeRetrieval: true })).toBeUndefined();
  });
});
