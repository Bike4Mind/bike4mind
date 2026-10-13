import { DATALAKE_TAG_PREFIX } from '../constants/dataLakes';

/**
 * Whether a session grounds on the user's own library (owned, shared and group files) alongside
 * its lakes. An explicit `includeLibraryFiles` wins; unset keeps the pre-existing rule, where
 * naming a lake is what excluded the library. `namesALake` is the caller's lake predicate (the
 * services side uses dataLakeService/narrowLakeAccessToSession.ts sessionNamesALake), never a raw
 * `retrievalTags` length: content tags and file-derived tags do not pick a lake.
 */
export function effectiveIncludeLibraryFiles(includeLibraryFiles: boolean | undefined, namesALake: boolean): boolean {
  return includeLibraryFiles ?? !namesALake;
}

/**
 * Whether `retrievalTags` name a lake, by identity (`datalake:x`) or by one of the caller's lakes'
 * file-tag prefixes. Server (sessionNamesALake) and client (the My files chip) both resolve it here.
 */
export function retrievalTagsNameALake(
  retrievalTags: readonly unknown[] | undefined,
  lakeFileTagPrefixes: Iterable<string | undefined>
): boolean {
  if (!retrievalTags?.length) return false;
  if (retrievalTags.some(tag => typeof tag === 'string' && tag.startsWith(DATALAKE_TAG_PREFIX))) return true;
  for (const prefix of lakeFileTagPrefixes) if (prefix && retrievalTags.includes(prefix)) return true;
  return false;
}

/**
 * The `includeLibraryFiles` value to resolve a session's scope with. Unset stays unset (lake-named
 * sessions exclude the library) only when the user actually picked a lake: a deliberate selection
 * (`lakeScopeExplicit`) or Data Lakes mode (`forceKnowledgeRetrieval`, which every lake-start path
 * sets). Tags derived from attaching a lake file to a plain chat carry neither, so it keeps its library.
 * Data Lakes mode turned OFF (`forceKnowledgeRetrieval === false`) includes the library whatever the
 * stored flag says; the flag is kept, not rewritten, so turning the mode back ON restores that choice.
 * The unset default here is not the only writer: any lake-picker change, including clearing to all
 * lakes, stores an explicit false on a never-chosen chat (useSetLakeScope), and explicit wins.
 */
export function libraryFlagForScope(session: {
  includeLibraryFiles?: boolean;
  lakeScopeExplicit?: boolean;
  forceKnowledgeRetrieval?: boolean;
}): boolean | undefined {
  if (session.forceKnowledgeRetrieval === false) return true;
  if (session.includeLibraryFiles !== undefined) return session.includeLibraryFiles;
  return session.lakeScopeExplicit || session.forceKnowledgeRetrieval ? undefined : true;
}
