/** The standalone bundle installs with no dependencies, so it may import nothing but `node:` built-ins. */
export const BUNDLE_BUDGET_BYTES = 1024 * 1024;

export interface BundleChunk {
  fileName: string;
  code: string;
  imports: readonly string[];
  dynamicImports: readonly string[];
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** Every module specifier the emitted code loads, from the chunk's import lists and from the text itself. */
export function bundleSpecifiers(chunk: BundleChunk): string[] {
  const found = new Set([...chunk.imports, ...chunk.dynamicImports]);
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of chunk.code.matchAll(pattern)) found.add(match[1]);
  }
  return [...found].sort();
}

/** Problems that would stop the bundle from running as a single file with no `node_modules`. */
export function bundleProblems(chunks: readonly BundleChunk[], budgetBytes = BUNDLE_BUDGET_BYTES): string[] {
  const problems: string[] = [];
  if (chunks.length !== 1) {
    problems.push(`expected one output file, got ${chunks.length}: ${chunks.map(chunk => chunk.fileName).join(', ')}`);
  }
  for (const chunk of chunks) {
    for (const specifier of bundleSpecifiers(chunk)) {
      if (!specifier.startsWith('node:')) problems.push(`${chunk.fileName} imports ${specifier}`);
    }
    const size = Buffer.byteLength(chunk.code);
    if (size > budgetBytes) problems.push(`${chunk.fileName} is ${size} bytes, over the ${budgetBytes} byte budget`);
  }
  return problems;
}
