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
