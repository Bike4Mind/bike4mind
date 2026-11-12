// What differs between a repo that ships tutorials and the next: where modules live, how their versions are kept,
// and which owner string its bundles carry. The apply library takes one of these and names no repo itself.
import type { TutorialDraftContent, TutorialStep, ValidationIssue } from '@bike4mind/common';
import type { OverridePolicy } from '../overrides';

export interface ModuleFiles {
  dir: string;
  files: Array<[path: string, text: string]>;
  issues: ValidationIssue[];
  /** Snippets for the registries, printed rather than spliced: their order decides the doors' order. */
  registration: Array<{ file: string; text: string }>;
}

export interface TutorialRepoLayout {
  /** This repo's owner string, as its bundles carry it. */
  owner: string;
  /** What the refusal tells the user to open for another owner's bundle; a repo passes only its own. */
  repoOf(owner: string): string | undefined;
  /** Owner assumed for a bundle exported before bundles carried one; absent refuses such a bundle. */
  legacyOwner?: string;
  root: string;
  /** Relative to `root`. */
  modulesDir: string;
  /** The file holding each module's version, and how to find its entry. */
  version: { path: string; arrayName: string; locate: 'index' | 'introId' };
  /** Repo modules as served before any closing steps, by id. */
  repoModules(): readonly { id: string; version: number; index: number; steps: readonly TutorialStep[] }[];
  policy: OverridePolicy;
  /** A line put atop each written .ts file; empty for none. */
  header: string;
  /** The files a made module writes into `dir`, and the registration snippets for a person to place. */
  moduleFiles(content: TutorialDraftContent, dir: string): ModuleFiles;
  /** Repo-relative files a person edits to register a made module, named in the checklist. */
  registers: readonly string[];
  /** The command that regenerates the editable-fields file, named in the checklist. */
  fieldsCommand: string;
  /** `test` is relative to `cwd`, which is relative to `root` (default `root`). */
  guard: { test: string; cwd?: string };
  /** Relative to `root`; its .ts files are scanned for specs quoting an edited text. */
  specsDir?: string;
}

/** `acme-routing` gives ACME_ROUTING and acmeRouting; an id may start with a digit, which an identifier may not. */
export function identifiersOf(moduleId: string): { upper: string; camel: string } {
  const lead = /^[0-9]/.test(moduleId) ? 'm-' : '';
  const words = `${lead}${moduleId}`.split('-').filter(Boolean);
  return {
    upper: words.join('_').toUpperCase(),
    camel: words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join(''),
  };
}

/** Escapes every character from U+007F up as \uXXXX, so written source stays ASCII and keeps its text. */
export const escapeNonAscii = (text: string): string =>
  text.replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
