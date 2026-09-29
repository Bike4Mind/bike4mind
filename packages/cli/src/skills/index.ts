/**
 * The CLI's skill-loading core, as a narrow surface other workspace apps can consume.
 *
 * WORKSPACE-INTERNAL. `@bike4mind/cli` publishes only `dist` and `bin` (see its package.json
 * "files"), so this subpath resolves inside the monorepo and nowhere else. It points at SOURCE
 * on purpose: the consumer (apps/desktop) bundles it with its own toolchain, which keeps
 * `electron-vite dev` working without first running the CLI's bundle build.
 *
 * What belongs here is the part that must have exactly ONE implementation across clients: the
 * discovery rules for `.bike4mind/commands/`, `.claude/commands/` and `.claude/skills/`, the
 * SKILL.md-parent-directory naming convention, the frontmatter contract, the project-trust gate
 * and the argument/`@file` grammar. A second copy of any of those in the desktop app would drift
 * from this one, and the trust gate is not a thing worth having two versions of.
 *
 * What does NOT belong here is anything that reads or runs: `skillTool.ts` resolves `@file`
 * against `process.cwd()` and shells out through the CLI's own permission gate, and neither of
 * those is meaningful in an Electron main process. Hosts share the PARSING and supply their own
 * confinement and approval. Keeping that line is also what keeps this subpath's runtime closure
 * down to `zod` and `gray-matter`.
 */

export { CustomCommandStore, type CustomCommandStoreOptions } from '../storage/CustomCommandStore.js';
export type { AgentConfig, CustomCommand, CustomCommandFrontmatter, SkillHooks } from '../storage/types.js';
export { extractCommandName, isValidCommandName, parseCommandFile } from '../utils/commandParser.js';
export { hasArgumentPatterns, parseArguments, substituteArguments } from '../utils/argumentSubstitution.js';
export { extractFileReferences, hasFileReferences } from '../utils/fileReferences.js';
export {
  buildSkillsPromptSection,
  filterAIVisibleSkills,
  filterSkillsByAllowedList,
  filterUserVisibleSkills,
} from '../core/skillsPrompt.js';
