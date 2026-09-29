/**
 * Which Prism grammar a file's lines should be read with.
 *
 * Extension only, and a short list of them. The alternative - sniffing the content - would have
 * to guess from a handful of changed lines, and a diff highlighted as the wrong language is
 * harder to read than one highlighted as none.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  graphql: 'graphql',
  prisma: 'prisma',
  dockerfile: 'docker',
};

/** Files whose whole NAME is the type, so there is no extension to read. */
const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
};

/** 'text' for anything unrecognised: Prism leaves it alone rather than colouring it wrongly. */
export function diffLanguage(path: string): string {
  const name = (path.split(/[/\\]/).pop() ?? '').toLowerCase();
  const byName = LANGUAGE_BY_FILENAME[name];
  if (byName) return byName;

  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'text';
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)] ?? 'text';
}
