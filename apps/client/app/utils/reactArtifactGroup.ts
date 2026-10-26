import { findRelativeImports, moduleBaseName, stripTypeOnlyImports } from './importStatements';
import { extractReactDependencies, type ParsedArtifact } from './artifactParser';

/**
 * How a React artifact renders when its reply splits an app across several artifacts. An entry
 * renders live with its siblings handed to the sandbox as `files`; a sibling shows its source.
 * A React artifact with no role renders standalone, as a single file.
 */
export type ReactArtifactGroupRole =
  | {
      role: 'entry';
      /** Every other React artifact in the reply, by identifier, for its relative imports. */
      files: Record<string, string>;
      /** npm imports of the entry and every file, since the sandbox loads them all up front. */
      dependencies: string[];
      /** The files the entry reaches through its imports, in `files` order, for the viewer's file tabs. */
      siblings: { identifier: string; title: string }[];
    }
  | { role: 'sibling'; entryTitle: string };

type GroupableArtifact = Pick<ParsedArtifact, 'type' | 'identifier' | 'title' | 'content' | 'startIndex'>;

/**
 * Roles for the React artifacts of one reply, keyed by the artifact objects passed in; standalone
 * ones are absent. Relative imports match identifiers by `moduleBaseName`, the normalizer the
 * sandbox resolves `files` with, so both agree on which artifact an import names. When an
 * identifier repeats, its last occurrence in the reply wins and earlier ones stay standalone.
 *
 * Any artifact with a relative import that nothing imports is an entry, even when none of its
 * imports match here: its (possibly empty) `files` let the sandbox name the missing file.
 */
export function groupReactArtifacts<T extends GroupableArtifact>(
  artifacts: readonly T[]
): Map<T, ReactArtifactGroupRole> {
  const roles = new Map<T, ReactArtifactGroupRole>();
  // The parser returns artifacts last-first, so order by position rather than trusting the array.
  const react = artifacts.filter(a => a.type === 'react').sort((a, b) => a.startIndex - b.startIndex);
  if (react.length === 0) return roles;

  const latest = new Map<string, T>();
  for (const artifact of react) {
    if (artifact.identifier) latest.set(artifact.identifier, artifact);
  }
  const nodes = react.filter(a => !a.identifier || latest.get(a.identifier) === a);

  const byName = new Map<string, T[]>();
  for (const [identifier, artifact] of latest) {
    const name = moduleBaseName(identifier);
    byName.set(name, [...(byName.get(name) ?? []), artifact]);
  }

  const imports = new Map<T, T[]>();
  const imported = new Set<T>();
  const importsRelative = new Set<T>();
  for (const artifact of nodes) {
    const specifiers = findRelativeImports(stripTypeOnlyImports(artifact.content));
    if (specifiers.length > 0) importsRelative.add(artifact);
    const targets = new Set<T>();
    for (const specifier of specifiers) {
      for (const target of byName.get(moduleBaseName(specifier)) ?? []) {
        if (target !== artifact) targets.add(target);
      }
    }
    imports.set(artifact, [...targets]);
    targets.forEach(target => imported.add(target));
  }

  for (const entry of nodes) {
    if (imported.has(entry) || !importsRelative.has(entry)) continue;

    const reached = new Set<T>([entry]);
    const queue = [...(imports.get(entry) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift() as T;
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(...(imports.get(next) ?? []));
    }

    const files = new Map<string, string>();
    const siblings: { identifier: string; title: string }[] = [];
    const dependencies = new Set(extractReactDependencies(entry.content));
    for (const [identifier, file] of latest) {
      if (file === entry) continue;
      files.set(identifier, file.content);
      if (reached.has(file)) siblings.push({ identifier, title: file.title });
      extractReactDependencies(file.content).forEach(dep => dependencies.add(dep));
    }
    roles.set(entry, { role: 'entry', files: Object.fromEntries(files), dependencies: [...dependencies], siblings });

    // A sibling reachable from two entries is labelled with the first one in the reply.
    for (const file of reached) {
      if (file !== entry && !roles.has(file)) roles.set(file, { role: 'sibling', entryTitle: entry.title });
    }
  }

  return roles;
}
