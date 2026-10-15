/**
 * Skills, as the renderer needs to see them.
 *
 * A skill is a markdown file with frontmatter - `.claude/skills/<name>/SKILL.md`,
 * `.claude/commands/<name>.md` or the `.bike4mind/commands/` equivalents - whose body becomes
 * the prompt when the user runs `/<name>`. Discovery and parsing are the CLI's
 * (`@bike4mind/cli/skills`); this is only the shape that crosses the IPC boundary.
 *
 * The BODY is deliberately not here. It is repo- or user-authored instructions that reach the
 * model, it can be long, and expanding it is main's job - so the renderer sends `/name args`
 * and never holds the text that gets sent on its behalf.
 */

/** Where a skill came from. `project` means it arrived with the checked-out repository. */
export type SkillSource = 'global' | 'project';

export interface SkillSummary {
  /** What the user types after the slash. Derived from the filename or the SKILL.md parent dir. */
  name: string;
  /** Frontmatter `name`, when it differs from the one above. */
  displayName?: string;
  description: string;
  /** Frontmatter `argument-hint`, e.g. "[file] [priority]". Shown beside the name in the picker. */
  argumentHint?: string;
  source: SkillSource;
  /** Absolute path, shown as the tooltip so a project skill can be read before it is run. */
  filePath: string;
}

/**
 * What the composer's picker draws.
 *
 * `untrustedProject` is the whole point of the extra field: a bound project whose skills have
 * NOT been trusted yet contributes nothing to `skills`, and the picker has to be able to say so
 * rather than silently showing a shorter list. See ProjectTrustStore.
 */
export interface SkillsState {
  skills: SkillSummary[];
  /** The project root that contributed project skills, or null when none did. */
  projectDirectory: string | null;
  /** Set to the bound project root when it exists but has not been trusted. */
  untrustedProject: string | null;
}

/** The empty state, for a session that has none and for a failed read. */
export const NO_SKILLS: SkillsState = { skills: [], projectDirectory: null, untrustedProject: null };
