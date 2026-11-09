import { SKILL_FILE_DIRS } from '@bike4mind/common';

// Import rules shown in SkillForm's help dialog and baked into the Claude Code prompt; keep in sync with skillImport.ts.
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 500;

const dirList = SKILL_FILE_DIRS.map(dir => `${dir}/`).join(' and ');

export const SKILL_IMPORT_RULES: readonly string[] = [
  'Import a SKILL.md, the skill folder, or a .zip of the skill folder (it is unzipped in your browser).',
  'The frontmatter is strict YAML: wrap the description in double quotes.',
  `name uses lowercase letters, digits and hyphens only, starts and ends with a letter or digit, and is ${MAX_SKILL_NAME_LENGTH} characters or fewer.`,
  `description is ${MAX_DESCRIPTION_LENGTH} characters or fewer.`,
  `Only SKILL.md and the text files in ${dirList} are imported. Binaries and other files are skipped or rejected.`,
  'The body must not reference files that are not imported.',
  'Skills with scripts are reviewed by a person before they appear in the Skill Market.',
];

export const SKILL_IMPORT_CLAUDE_CODE_PROMPT = [
  'Package my Claude Code skill at ~/.claude/skills/<name>/ so it imports cleanly into Bike4Mind. Fix the files in place, then list what you changed.',
  '',
  'Rules:',
  '1. SKILL.md starts with a YAML frontmatter block between --- lines. The YAML is parsed strictly, so wrap the description value in double quotes and escape any double quotes inside it.',
  `2. name is lowercase letters, digits and hyphens only, starts and ends with a letter or digit, is ${MAX_SKILL_NAME_LENGTH} characters or fewer, and matches the folder name.`,
  `3. description is ${MAX_DESCRIPTION_LENGTH} characters or fewer. Shorten it if needed, keeping when to use the skill.`,
  `4. Only SKILL.md and text files inside ${dirList} are imported. Move needed helper files into those folders and update the paths in SKILL.md. Binaries (images, compiled files, archives) are not imported: replace or remove them.`,
  '5. The SKILL.md body must not reference any file that is not imported. Remove or rewrite such references.',
  '6. Skills with scripts are reviewed by a person before they are shared in the Skill Market, so keep scripts short and readable.',
  '',
  'When done, tell me to import the folder, or a .zip of the folder, in Bike4Mind.',
].join('\n');
