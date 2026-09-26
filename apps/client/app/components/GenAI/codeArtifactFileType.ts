export interface CodeFileType {
  ext: string;
  mime: string;
}

const DEFAULT_FILE_TYPE: CodeFileType = { ext: 'txt', mime: 'text/plain' };

/**
 * Maps a code artifact's language tag to a save-as extension and MIME type. Naively using
 * `.${language}` and a javascript/typescript/python/html/css-only ternary (the pattern this
 * replaces) produced files named `.typescript`/`.javascript`/`.bash`/`.markdown` and sent
 * everything else - including CSV - out as text/plain.
 *
 * Extension/MIME pairs mirror the server's EXT_TO_MIME (b4m-core/utils/src/file.ts) so a saved
 * file is never rejected by resolveSupportedMimeType. That module is not importable here:
 * getMimeTypeByExtension pulls in Node's `path` and the `file-type` content-sniffing package
 * through @bike4mind/utils's index, which do not belong in a client bundle - so the pairing is
 * kept in sync by hand rather than by import.
 */
const CODE_FILE_TYPES: Record<string, CodeFileType> = {
  typescript: { ext: 'ts', mime: 'text/typescript' },
  ts: { ext: 'ts', mime: 'text/typescript' },
  tsx: { ext: 'tsx', mime: 'text/typescript' },
  javascript: { ext: 'js', mime: 'text/javascript' },
  js: { ext: 'js', mime: 'text/javascript' },
  jsx: { ext: 'jsx', mime: 'text/javascript' },
  python: { ext: 'py', mime: 'text/x-python' },
  py: { ext: 'py', mime: 'text/x-python' },
  html: { ext: 'html', mime: 'text/html' },
  css: { ext: 'css', mime: 'text/css' },
  json: { ext: 'json', mime: 'application/json' },
  csv: { ext: 'csv', mime: 'text/csv' },
  markdown: { ext: 'md', mime: 'text/markdown' },
  md: { ext: 'md', mime: 'text/markdown' },
  mdx: { ext: 'mdx', mime: 'text/markdown' },
  yaml: { ext: 'yml', mime: 'text/yaml' },
  yml: { ext: 'yml', mime: 'text/yaml' },
  bash: { ext: 'sh', mime: 'text/x-sh' },
  sh: { ext: 'sh', mime: 'text/x-sh' },
  shell: { ext: 'sh', mime: 'text/x-sh' },
  // zsh has no extension of its own server-side; it chunks/saves fine as .sh.
  zsh: { ext: 'sh', mime: 'text/x-sh' },
  sql: { ext: 'sql', mime: 'text/x-sql' },
  xml: { ext: 'xml', mime: 'application/xml' },
  go: { ext: 'go', mime: 'text/x-go' },
  java: { ext: 'java', mime: 'text/x-java-source' },
  // C has no MIME of its own server-side either; text/x-c++src is the closest supported type.
  c: { ext: 'c', mime: 'text/x-c++src' },
  cpp: { ext: 'cpp', mime: 'text/x-c++src' },
  'c++': { ext: 'cpp', mime: 'text/x-c++src' },
  cc: { ext: 'cpp', mime: 'text/x-c++src' },
  cs: { ext: 'cs', mime: 'text/x-csharp' },
  csharp: { ext: 'cs', mime: 'text/x-csharp' },
  rs: { ext: 'rs', mime: 'text/x-rust' },
  rust: { ext: 'rs', mime: 'text/x-rust' },
  rb: { ext: 'rb', mime: 'application/x-ruby' },
  ruby: { ext: 'rb', mime: 'application/x-ruby' },
  kt: { ext: 'kt', mime: 'text/x-kotlin' },
  kotlin: { ext: 'kt', mime: 'text/x-kotlin' },
  php: { ext: 'php', mime: 'application/x-httpd-php' },
  swift: { ext: 'swift', mime: 'text/x-swift' },
  toml: { ext: 'toml', mime: 'application/toml' },
  scss: { ext: 'scss', mime: 'text/x-scss' },
  sass: { ext: 'sass', mime: 'text/x-sass' },
  less: { ext: 'less', mime: 'text/less' },
  ini: { ext: 'ini', mime: 'text/plain' },
};

/**
 * Extensions the server's EXT_TO_MIME (b4m-core/utils/src/file.ts) accepts, mirrored here (keys
 * only - see the note above on why the module itself is not imported) so a language tag with no
 * entry above, but whose name IS already a supported extension, still saves as `.${language}`
 * instead of falling all the way back to `.txt`.
 */
const KNOWN_UPLOAD_EXTENSIONS = new Set([
  'txt',
  'ini',
  'env',
  'conf',
  'log',
  'sql',
  'text',
  'md',
  'mdx',
  'html',
  'htm',
  'shtml',
  'csv',
  'jpg',
  'jpeg',
  'jfif',
  'jpe',
  'png',
  'gif',
  'svg',
  'webp',
  'pdf',
  'json',
  'xml',
  'docx',
  'pptx',
  'xlsx',
  'xls',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'py',
  'java',
  'cpp',
  'c',
  'h',
  'cs',
  'php',
  'rb',
  'go',
  'swift',
  'kt',
  'rs',
  'css',
  'less',
  'sass',
  'scss',
  'yaml',
  'yml',
  'toml',
  'sh',
  'bash',
  'mp3',
  'wav',
  'opus',
  'aac',
  'flac',
  'pcm',
  'ogg',
  'webm',
]);

/** Resolves a code artifact's declared language to its save-as extension and MIME type. */
export function getCodeFileType(language: string): CodeFileType {
  const lang = language.toLowerCase();
  const mapped = CODE_FILE_TYPES[lang];
  if (mapped) return mapped;
  if (KNOWN_UPLOAD_EXTENSIONS.has(lang)) return { ext: lang, mime: 'text/plain' };
  return DEFAULT_FILE_TYPE;
}
