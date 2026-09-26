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
  yaml: { ext: 'yml', mime: 'text/yaml' },
  yml: { ext: 'yml', mime: 'text/yaml' },
  bash: { ext: 'sh', mime: 'text/x-sh' },
  sh: { ext: 'sh', mime: 'text/x-sh' },
  shell: { ext: 'sh', mime: 'text/x-sh' },
  sql: { ext: 'sql', mime: 'text/x-sql' },
  xml: { ext: 'xml', mime: 'application/xml' },
};

/** Resolves a code artifact's declared language to its save-as extension and MIME type. */
export function getCodeFileType(language: string): CodeFileType {
  return CODE_FILE_TYPES[language.toLowerCase()] ?? DEFAULT_FILE_TYPE;
}
