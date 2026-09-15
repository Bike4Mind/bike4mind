// Utility for detecting and managing file formats for knowledge files
import { SupportedFabFileMimeTypes } from '@bike4mind/common';

export interface FileFormatOption {
  label: string;
  mimeType: SupportedFabFileMimeTypes;
  extension: string;
  description?: string;
}

// Cache for O(1) format lookups
const FORMAT_CACHE = new Map<SupportedFabFileMimeTypes, FileFormatOption>();

// Common file format options for user selection
export const COMMON_FILE_FORMATS: FileFormatOption[] = [
  {
    label: 'Plain Text',
    mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
    extension: 'txt',
    description: 'Simple text without formatting',
  },
  {
    label: 'Markdown',
    mimeType: SupportedFabFileMimeTypes.TXT_MARKDOWN,
    extension: 'md',
    description: 'Text with markdown formatting',
  },
  {
    label: 'JavaScript',
    mimeType: SupportedFabFileMimeTypes.JS,
    extension: 'js',
    description: 'JavaScript code',
  },
  {
    label: 'TypeScript',
    mimeType: SupportedFabFileMimeTypes.TS,
    extension: 'ts',
    description: 'TypeScript code',
  },
  {
    label: 'Python',
    mimeType: SupportedFabFileMimeTypes.PY,
    extension: 'py',
    description: 'Python code',
  },
  {
    label: 'JSON',
    mimeType: SupportedFabFileMimeTypes.JSON,
    extension: 'json',
    description: 'JSON data',
  },
  {
    label: 'HTML',
    mimeType: SupportedFabFileMimeTypes.HTML,
    extension: 'html',
    description: 'HTML markup',
  },
  {
    label: 'CSS',
    mimeType: SupportedFabFileMimeTypes.CSS,
    extension: 'css',
    description: 'CSS styles',
  },
  {
    label: 'XML',
    mimeType: SupportedFabFileMimeTypes.XML,
    extension: 'xml',
    description: 'XML data',
  },
  {
    label: 'CSV',
    mimeType: SupportedFabFileMimeTypes.CSV,
    extension: 'csv',
    description: 'Comma-separated values',
  },
  {
    label: 'YAML',
    mimeType: SupportedFabFileMimeTypes.YAML,
    extension: 'yml',
    description: 'YAML configuration',
  },
  {
    label: 'Shell Script',
    mimeType: SupportedFabFileMimeTypes.SH,
    extension: 'sh',
    description: 'Shell script',
  },
  {
    label: 'Java',
    mimeType: SupportedFabFileMimeTypes.JAVA,
    extension: 'java',
    description: 'Java code',
  },
  {
    label: 'C++',
    mimeType: SupportedFabFileMimeTypes.CPP,
    extension: 'cpp',
    description: 'C++ code',
  },
  {
    label: 'C#',
    mimeType: SupportedFabFileMimeTypes.CS,
    extension: 'cs',
    description: 'C# code',
  },
  {
    label: 'PHP',
    mimeType: SupportedFabFileMimeTypes.PHP,
    extension: 'php',
    description: 'PHP code',
  },
  {
    label: 'Ruby',
    mimeType: SupportedFabFileMimeTypes.RUBY,
    extension: 'rb',
    description: 'Ruby code',
  },
  {
    label: 'Go',
    mimeType: SupportedFabFileMimeTypes.GO,
    extension: 'go',
    description: 'Go code',
  },
  {
    label: 'Rust',
    mimeType: SupportedFabFileMimeTypes.RUST,
    extension: 'rs',
    description: 'Rust code',
  },
  {
    label: 'Swift',
    mimeType: SupportedFabFileMimeTypes.SWIFT,
    extension: 'swift',
    description: 'Swift code',
  },
  {
    label: 'Kotlin',
    mimeType: SupportedFabFileMimeTypes.KOTLIN,
    extension: 'kt',
    description: 'Kotlin code',
  },
  {
    label: 'JSX',
    mimeType: SupportedFabFileMimeTypes.JSX,
    extension: 'jsx',
    description: 'React JSX code',
  },
  {
    label: 'TSX',
    mimeType: SupportedFabFileMimeTypes.TSX,
    extension: 'tsx',
    description: 'React TypeScript JSX code',
  },
  {
    label: 'LESS',
    mimeType: SupportedFabFileMimeTypes.LESS,
    extension: 'less',
    description: 'LESS stylesheet',
  },
  {
    label: 'SASS',
    mimeType: SupportedFabFileMimeTypes.SASS,
    extension: 'sass',
    description: 'SASS stylesheet',
  },
  {
    label: 'SCSS',
    mimeType: SupportedFabFileMimeTypes.SCSS,
    extension: 'scss',
    description: 'SCSS stylesheet',
  },
  {
    label: 'TOML',
    mimeType: SupportedFabFileMimeTypes.TOML,
    extension: 'toml',
    description: 'TOML configuration',
  },
  {
    label: 'Bash Script',
    mimeType: SupportedFabFileMimeTypes.BASH,
    extension: 'bash',
    description: 'Bash shell script',
  },
];

// Initialize the format cache
function initializeFormatCache() {
  if (FORMAT_CACHE.size === 0) {
    COMMON_FILE_FORMATS.forEach(format => {
      FORMAT_CACHE.set(format.mimeType, format);
    });
  }
}

// Fast O(1) format lookup
function getFormat(mimeType: SupportedFabFileMimeTypes): FileFormatOption {
  initializeFormatCache();
  return FORMAT_CACHE.get(mimeType)!;
}

// Interface for format detection results with confidence scoring
interface FormatDetectionResult {
  format: FileFormatOption;
  confidence: number;
  reason: string;
}

// Detect likely file format from content with confidence scoring
export function detectFileFormat(content: string): FileFormatOption {
  const result = detectFileFormatWithConfidence(content);
  return result.format;
}

// Context object to avoid redundant string operations
interface DetectionContext {
  content: string;
  trimmed: string;
  lines: string[];
  firstLine: string;
  firstChar: string;
  lastChar: string;
  length: number;
  // Lazy-computed properties
  _firstFewLines?: string;
}

function createDetectionContext(content: string): DetectionContext {
  const trimmed = content.trim();
  const lines = trimmed.split('\n');
  return {
    content,
    trimmed,
    lines,
    firstLine: lines[0] || '',
    firstChar: trimmed[0] || '',
    lastChar: trimmed[trimmed.length - 1] || '',
    length: trimmed.length,
  };
}

function getFirstFewLines(ctx: DetectionContext): string {
  if (!ctx._firstFewLines) {
    ctx._firstFewLines = ctx.lines.slice(0, Math.min(5, ctx.lines.length)).join('\n');
  }
  return ctx._firstFewLines;
}

// Type for detector functions
type DetectorFunction = (ctx: DetectionContext) => FormatDetectionResult | null;

/**
 * Detection pipeline - ordered by priority (high confidence checks first)
 *
 * The pipeline uses a "first match wins" strategy. Detectors are organized by:
 * 1. High confidence, fast checks (JSON, HTML, XML)
 * 2. Structural formats (YAML, TOML, CSV)
 * 3. Markup and code formats (Markdown, JSX)
 * 4. Language-specific patterns (TypeScript, CSS preprocessors, etc.)
 *
 * To add a new detector:
 * 1. Create a function matching DetectorFunction signature
 * 2. Add it to the pipeline in the appropriate priority position
 * 3. Ensure it returns null for non-matches (for pipeline to continue)
 */
const DETECTION_PIPELINE: DetectorFunction[] = [
  detectJson,
  detectHtml,
  detectXml,
  detectShellScriptFromContext,
  detectYaml,
  detectToml,
  detectCsv,
  detectMarkdown,
  detectReactJsx,
  detectTypeScript,
  detectCssPreprocessor,
  detectProgrammingLanguage,
  detectCss,
];

// Enhanced detection with confidence scoring
export function detectFileFormatWithConfidence(content: string): FormatDetectionResult {
  // Limit content size for performance (sample first 50KB for large files)
  const MAX_SAMPLE_SIZE = 50000;
  const sampleContent = content.length > MAX_SAMPLE_SIZE ? content.substring(0, MAX_SAMPLE_SIZE) : content;

  const ctx = createDetectionContext(sampleContent);

  // Run through detection pipeline - first match wins
  for (const detector of DETECTION_PIPELINE) {
    const result = detector(ctx);
    if (result) return result;
  }

  // Default to plain text with low confidence
  return {
    format: getFormat(SupportedFabFileMimeTypes.TXT_PLAIN),
    confidence: 0.3,
    reason: 'No specific format patterns detected',
  };
}

// Return top-N format candidates sorted by confidence (desc)
export function detectTopFormats(content: string, limit: number = 3): FormatDetectionResult[] {
  const MAX_SAMPLE_SIZE = 50000;
  const sampleContent = content.length > MAX_SAMPLE_SIZE ? content.substring(0, MAX_SAMPLE_SIZE) : content;
  const ctx = createDetectionContext(sampleContent);

  const results: FormatDetectionResult[] = [];

  // Run all non-language detectors and collect candidates
  for (const detector of [
    detectJson,
    detectHtml,
    detectXml,
    detectShellScriptFromContext,
    detectYaml,
    detectToml,
    detectCsv,
    detectMarkdown,
    detectReactJsx,
    detectTypeScript,
    detectCssPreprocessor,
    detectCss,
  ]) {
    const res = detector(ctx);
    if (res) results.push(res);
  }

  // Add programming language candidates (multiple)
  results.push(...getProgrammingLanguageCandidates(ctx));

  // If nothing matched, include plain text low-confidence
  if (results.length === 0) {
    results.push({
      format: getFormat(SupportedFabFileMimeTypes.TXT_PLAIN),
      confidence: 0.3,
      reason: 'No specific format patterns detected',
    });
  }

  // Dedupe by mimeType, keep highest confidence per type
  const bestByMime = new Map<string, FormatDetectionResult>();
  for (const r of results) {
    const key = r.format.mimeType;
    const existing = bestByMime.get(key);
    if (!existing || r.confidence > existing.confidence) bestByMime.set(key, r);
  }

  // Sort by confidence desc and return top N
  return Array.from(bestByMime.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

// Helper functions for format detection - all optimized to use DetectionContext

function detectJson(ctx: DetectionContext): FormatDetectionResult | null {
  if ((ctx.firstChar === '{' && ctx.lastChar === '}') || (ctx.firstChar === '[' && ctx.lastChar === ']')) {
    try {
      JSON.parse(ctx.trimmed);
      return {
        format: getFormat(SupportedFabFileMimeTypes.JSON),
        confidence: 0.95,
        reason: 'Valid JSON structure detected',
      };
    } catch {
      return null;
    }
  }
  return null;
}

function detectHtml(ctx: DetectionContext): FormatDetectionResult | null {
  if (ctx.trimmed.startsWith('<!DOCTYPE html') || ctx.trimmed.startsWith('<html')) {
    return {
      format: getFormat(SupportedFabFileMimeTypes.HTML),
      confidence: 0.95,
      reason: 'HTML document structure detected',
    };
  }
  return null;
}

function detectXml(ctx: DetectionContext): FormatDetectionResult | null {
  if (ctx.trimmed.startsWith('<?xml')) {
    return {
      format: getFormat(SupportedFabFileMimeTypes.XML),
      confidence: 0.95,
      reason: 'XML declaration detected',
    };
  }
  return null;
}

function detectShellScriptFromContext(ctx: DetectionContext): FormatDetectionResult | null {
  if (!ctx.firstLine.startsWith('#!')) return null;

  // Use string operations instead of regex when possible
  const isBash = ctx.firstLine.includes('bash') || ctx.firstLine.includes('zsh') || ctx.firstLine.includes('fish');

  return {
    format: getFormat(isBash ? SupportedFabFileMimeTypes.BASH : SupportedFabFileMimeTypes.SH),
    confidence: 0.9,
    reason: 'Shell script shebang detected',
  };
}

function detectYaml(ctx: DetectionContext): FormatDetectionResult | null {
  // Quick rejection: if no colons or dashes, unlikely to be YAML
  if (!ctx.trimmed.includes(':') && !ctx.trimmed.includes('- ')) return null;

  let yamlScore = 0;
  const sampleSize = Math.min(20, ctx.lines.length); // Only check first 20 lines

  for (let i = 0; i < sampleSize; i++) {
    const line = ctx.lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;

    if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*/.test(line)) yamlScore += 2;
    else if (line.startsWith('- ')) yamlScore += 1;
    else if (line === '---' || line === '...') yamlScore += 3;
  }

  if (yamlScore > sampleSize * 0.6) {
    return {
      format: getFormat(SupportedFabFileMimeTypes.YAML),
      confidence: 0.9,
      reason: 'YAML structure detected',
    };
  }

  return null;
}

function detectToml(ctx: DetectionContext): FormatDetectionResult | null {
  // Quick rejection
  if (!ctx.trimmed.includes('=') && !ctx.trimmed.includes('[')) return null;

  let tomlScore = 0;
  const sampleSize = Math.min(15, ctx.lines.length);

  for (let i = 0; i < sampleSize; i++) {
    const line = ctx.lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;

    if (/^\[[a-zA-Z0-9_.-]+\]\s*$/.test(line)) tomlScore += 3;
    else if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*/.test(line)) tomlScore += 2;
  }

  if (tomlScore > sampleSize * 0.4) {
    return {
      format: getFormat(SupportedFabFileMimeTypes.TOML),
      confidence: 0.9,
      reason: 'TOML structure detected',
    };
  }

  return null;
}

function detectCsv(ctx: DetectionContext): FormatDetectionResult | null {
  if (ctx.lines.length < 2) return null;

  const nonEmptyLines = ctx.lines.filter(line => line.trim() !== '');
  if (nonEmptyLines.length < 2) return null;

  // Quick rejection: CSV shouldn't have code-like patterns
  if (
    ctx.trimmed.includes('def ') ||
    ctx.trimmed.includes('function ') ||
    ctx.trimmed.includes('class ') ||
    ctx.trimmed.includes('import ') ||
    ctx.trimmed.includes('{') ||
    ctx.trimmed.includes('}')
  ) {
    return null;
  }

  // Sample first 10 lines for performance
  const sample = nonEmptyLines.slice(0, Math.min(10, nonEmptyLines.length));
  const commaCounts = sample.map(line => (line.match(/,/g) || []).length);
  const avgCommas = commaCounts.reduce((a, b) => a + b, 0) / commaCounts.length;

  // Need at least 2 commas per line on average for CSV
  if (avgCommas < 2) return null;

  // Check consistency
  const consistentCommas = commaCounts.every(count => Math.abs(count - avgCommas) <= 1);
  if (!consistentCommas) return null;

  // Additional validation: CSV lines shouldn't have type hints or other code patterns
  const hasCodePatterns = sample.some(
    line =>
      line.includes('->') ||
      (line.includes(':') && line.includes('(') && line.includes(')')) ||
      /^\s*(def|class|import|from|function|const|let|var)\s/.test(line)
  );

  if (hasCodePatterns) return null;

  return {
    format: getFormat(SupportedFabFileMimeTypes.CSV),
    confidence: 0.8,
    reason: 'CSV structure detected',
  };
}

function detectMarkdown(ctx: DetectionContext): FormatDetectionResult | null {
  // Quick checks for common markdown patterns
  const hasHeaders = ctx.trimmed.includes('#');
  const hasBold = ctx.trimmed.includes('**');
  const hasLinks = ctx.trimmed.includes('](');
  const hasCode = ctx.trimmed.includes('```');

  if (!hasHeaders && !hasBold && !hasLinks && !hasCode) return null;

  let confidence = 0;

  // Use more efficient pattern matching
  if (/^#{1,6}\s/m.test(ctx.trimmed)) confidence += 0.3;
  if (/\*\*.*\*\*/m.test(ctx.trimmed)) confidence += 0.2;
  if (/\[.*\]\(.*\)/m.test(ctx.trimmed)) confidence += 0.2;
  if (/^\s*[-*+]\s/m.test(ctx.trimmed)) confidence += 0.2;
  if (/```/m.test(ctx.trimmed)) confidence += 0.3;
  if (/`[^`]+`/m.test(ctx.trimmed)) confidence += 0.1;

  if (confidence > 0.6) {
    return {
      format: getFormat(SupportedFabFileMimeTypes.TXT_MARKDOWN),
      confidence: Math.min(confidence, 1),
      reason: 'Markdown patterns detected',
    };
  }

  return null;
}

function detectReactJsx(ctx: DetectionContext): FormatDetectionResult | null {
  // Quick rejection
  if (!ctx.trimmed.includes('<') || !ctx.trimmed.includes('>')) return null;

  const hasReactImport = /import\s+React|from\s+['"]react['"]/.test(ctx.trimmed);
  const hasJsxElements = /<[A-Z][a-zA-Z0-9]*/.test(ctx.trimmed);
  const hasReactHooks = /useState|useEffect|useContext/.test(ctx.trimmed);

  if (hasJsxElements || hasReactImport || hasReactHooks) {
    const isTypeScript = /:\s*(string|number|boolean)|interface\s+\w+|type\s+\w+\s*=/.test(ctx.trimmed);
    return {
      format: getFormat(isTypeScript ? SupportedFabFileMimeTypes.TSX : SupportedFabFileMimeTypes.JSX),
      confidence: 0.85,
      reason: 'React JSX patterns detected',
    };
  }

  return null;
}

function detectTypeScript(ctx: DetectionContext): FormatDetectionResult | null {
  let confidence = 0;

  if (/:\s*(string|number|boolean|object|any|void|never)/.test(ctx.trimmed)) confidence += 0.3;
  if (/interface\s+\w+/.test(ctx.trimmed)) confidence += 0.4;
  if (/type\s+\w+\s*=/.test(ctx.trimmed)) confidence += 0.3;
  if (/enum\s+\w+/.test(ctx.trimmed)) confidence += 0.2;

  if (confidence > 0.7) {
    return {
      format: getFormat(SupportedFabFileMimeTypes.TS),
      confidence: Math.min(confidence, 1),
      reason: 'TypeScript features detected',
    };
  }

  return null;
}

function detectCssPreprocessor(ctx: DetectionContext): FormatDetectionResult | null {
  const hasAtSymbol = ctx.trimmed.includes('@');
  const hasDollar = ctx.trimmed.includes('$');

  if (!hasAtSymbol && !hasDollar) return null;

  // SCSS patterns (most common)
  if (hasDollar || ctx.trimmed.includes('@mixin') || ctx.trimmed.includes('@include')) {
    return {
      format: getFormat(SupportedFabFileMimeTypes.SCSS),
      confidence: 0.8,
      reason: 'SCSS syntax detected',
    };
  }

  // LESS patterns
  if (hasAtSymbol && ctx.trimmed.includes('@variable')) {
    return {
      format: getFormat(SupportedFabFileMimeTypes.LESS),
      confidence: 0.8,
      reason: 'LESS syntax detected',
    };
  }

  // SASS patterns (indented syntax)
  const indentedLines = ctx.lines.filter(line => /^\s{2,}/.test(line) && !line.trim().startsWith('//')).length;
  if (indentedLines > ctx.lines.length * 0.3 && ctx.trimmed.includes(':')) {
    return {
      format: getFormat(SupportedFabFileMimeTypes.SASS),
      confidence: 0.75,
      reason: 'SASS indented syntax detected',
    };
  }

  return null;
}

function detectProgrammingLanguage(ctx: DetectionContext): FormatDetectionResult | null {
  const firstFewLines = getFirstFewLines(ctx);

  // Score-based detection for better accuracy
  let pythonScore = 0;
  let javaScore = 0;
  let cppScore = 0;
  let goScore = 0;
  let phpScore = 0;
  let rustScore = 0;
  let csScore = 0;
  let rubyScore = 0;
  let swiftScore = 0;
  let kotlinScore = 0;

  // Python detection patterns
  if (/\bdef\s+\w+\s*\(/.test(ctx.trimmed)) pythonScore += 3;
  if (/\bfrom\s+\w+\s+import\b/.test(ctx.trimmed)) pythonScore += 3;
  if (/\bimport\s+\w+/.test(firstFewLines) && !firstFewLines.includes(';')) pythonScore += 2;
  if (/\bclass\s+\w+(\s*\(|\s*:)/.test(ctx.trimmed)) pythonScore += 2;
  if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(ctx.trimmed)) pythonScore += 4;
  if (/:\s*$|^\s+/m.test(ctx.trimmed)) pythonScore += 1; // Colons and indentation
  if (/\bprint\s*\(/.test(ctx.trimmed)) pythonScore += 1;
  if (/->\s*(int|str|bool|float|list|dict|tuple|None)/i.test(ctx.trimmed)) pythonScore += 2;

  // Java detection
  if (/\bpublic\s+(class|interface|enum)\s+\w+/.test(firstFewLines)) javaScore += 4;
  if (/\bpackage\s+[\w.]+;/.test(firstFewLines)) javaScore += 3;
  if (/\bimport\s+[\w.]+;/.test(firstFewLines)) javaScore += 2;
  if (/\bprivate\s+\w+/.test(ctx.trimmed)) javaScore += 1;
  if (/\bSystem\.out\.print/.test(ctx.trimmed)) javaScore += 2;

  // C++ detection
  if (/#include\s*<\w+>/.test(firstFewLines)) cppScore += 4;
  if (/\busing\s+namespace\s+\w+;/.test(ctx.trimmed)) cppScore += 3;
  if (/\bstd::/.test(ctx.trimmed)) cppScore += 2;
  if (/\b(int|void)\s+main\s*\(/.test(ctx.trimmed)) cppScore += 3;

  // Go detection
  if (/\bpackage\s+main\b/.test(firstFewLines)) goScore += 4;
  if (/\bfunc\s+\w+\s*\(/.test(firstFewLines)) goScore += 3;
  if (/\bimport\s+\(/.test(firstFewLines)) goScore += 3;
  if (/:=/.test(ctx.trimmed)) goScore += 2;

  // PHP detection
  if (/^<\?php/.test(firstFewLines)) phpScore += 5;
  if (/\$\w+/.test(ctx.trimmed)) phpScore += 2;

  // Rust detection
  if (/\bfn\s+\w+/.test(firstFewLines)) rustScore += 3;
  if (/\buse\s+\w+::\w+/.test(firstFewLines)) rustScore += 3;
  if (/\b(struct|impl)\s+\w+/.test(ctx.trimmed)) rustScore += 2;
  if (/let\s+mut\s+/.test(ctx.trimmed)) rustScore += 2;

  // C# detection
  if (/\bnamespace\s+\w+/.test(firstFewLines)) csScore += 3;
  if (/\busing\s+\w+;/.test(firstFewLines) && /\bnamespace\b/.test(ctx.trimmed)) csScore += 3;

  // Ruby detection
  if (/\bdef\s+\w+/.test(firstFewLines) && /\bend\b/.test(ctx.trimmed)) rubyScore += 3;
  if (/\brequire\s+['"]/.test(firstFewLines)) rubyScore += 2;
  if (/\bmodule\s+\w+/.test(ctx.trimmed)) rubyScore += 2;

  // Swift detection
  if (/\bimport\s+Foundation\b/.test(firstFewLines)) swiftScore += 4;
  if (/\bfunc\s+\w+\s*\(/.test(ctx.trimmed) && /\s+->\s+/.test(ctx.trimmed)) swiftScore += 2;

  // Kotlin detection
  if (/\bfun\s+\w+/.test(firstFewLines)) kotlinScore += 4;
  if (/\bval\s+\w+/.test(ctx.trimmed)) kotlinScore += 2;

  // Find the highest score
  const scores = [
    { score: pythonScore, format: SupportedFabFileMimeTypes.PY, name: 'Python' },
    { score: javaScore, format: SupportedFabFileMimeTypes.JAVA, name: 'Java' },
    { score: cppScore, format: SupportedFabFileMimeTypes.CPP, name: 'C++' },
    { score: goScore, format: SupportedFabFileMimeTypes.GO, name: 'Go' },
    { score: phpScore, format: SupportedFabFileMimeTypes.PHP, name: 'PHP' },
    { score: rustScore, format: SupportedFabFileMimeTypes.RUST, name: 'Rust' },
    { score: csScore, format: SupportedFabFileMimeTypes.CS, name: 'C#' },
    { score: rubyScore, format: SupportedFabFileMimeTypes.RUBY, name: 'Ruby' },
    { score: swiftScore, format: SupportedFabFileMimeTypes.SWIFT, name: 'Swift' },
    { score: kotlinScore, format: SupportedFabFileMimeTypes.KOTLIN, name: 'Kotlin' },
  ];

  const winner = scores.reduce((max, curr) => (curr.score > max.score ? curr : max));

  // Need at least score of 3 to be confident
  if (winner.score >= 3) {
    const confidence = Math.min(0.7 + winner.score * 0.05, 0.95);
    return {
      format: getFormat(winner.format),
      confidence,
      reason: `${winner.name} patterns detected`,
    };
  }

  return null;
}

// Expose top programming language candidates with confidence
function getProgrammingLanguageCandidates(ctx: DetectionContext): FormatDetectionResult[] {
  const firstFewLines = getFirstFewLines(ctx);

  const scores: Array<{ score: number; format: SupportedFabFileMimeTypes; name: string }> = [];

  const add = (name: string, format: SupportedFabFileMimeTypes, score: number) => {
    if (score > 0) scores.push({ name, format, score });
  };

  // Reuse the same scoring logic as detectProgrammingLanguage
  let python = 0;
  if (/\bdef\s+\w+\s*\(/.test(ctx.trimmed)) python += 3;
  if (/\bfrom\s+\w+\s+import\b/.test(ctx.trimmed)) python += 3;
  if (/\bimport\s+\w+/.test(firstFewLines) && !firstFewLines.includes(';')) python += 2;
  if (/\bclass\s+\w+(\s*\(|\s*:)/.test(ctx.trimmed)) python += 2;
  if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(ctx.trimmed)) python += 4;
  if (/:\s*$|^\s+/m.test(ctx.trimmed)) python += 1;
  if (/\bprint\s*\(/.test(ctx.trimmed)) python += 1;
  if (/->\s*(int|str|bool|float|list|dict|tuple|None)/i.test(ctx.trimmed)) python += 2;
  add('Python', SupportedFabFileMimeTypes.PY, python);

  let java = 0;
  if (/\bpublic\s+(class|interface|enum)\s+\w+/.test(firstFewLines)) java += 4;
  if (/\bpackage\s+[\w.]+;/.test(firstFewLines)) java += 3;
  if (/\bimport\s+[\w.]+;/.test(firstFewLines)) java += 2;
  if (/\bprivate\s+\w+/.test(ctx.trimmed)) java += 1;
  if (/\bSystem\.out\.print/.test(ctx.trimmed)) java += 2;
  add('Java', SupportedFabFileMimeTypes.JAVA, java);

  let cpp = 0;
  if (/#include\s*<\w+>/.test(firstFewLines)) cpp += 4;
  if (/\busing\s+namespace\s+\w+;/.test(ctx.trimmed)) cpp += 3;
  if (/\bstd::/.test(ctx.trimmed)) cpp += 2;
  if (/\b(int|void)\s+main\s*\(/.test(ctx.trimmed)) cpp += 3;
  add('C++', SupportedFabFileMimeTypes.CPP, cpp);

  let go = 0;
  if (/\bpackage\s+main\b/.test(firstFewLines)) go += 4;
  if (/\bfunc\s+\w+\s*\(/.test(firstFewLines)) go += 3;
  if (/\bimport\s+\(/.test(firstFewLines)) go += 3;
  if (/:=/.test(ctx.trimmed)) go += 2;
  add('Go', SupportedFabFileMimeTypes.GO, go);

  let php = 0;
  if (/^<\?php/.test(firstFewLines)) php += 5;
  if (/\$\w+/.test(ctx.trimmed)) php += 2;
  add('PHP', SupportedFabFileMimeTypes.PHP, php);

  let rust = 0;
  if (/\bfn\s+\w+/.test(firstFewLines)) rust += 3;
  if (/\buse\s+\w+::\w+/.test(firstFewLines)) rust += 3;
  if (/\b(struct|impl)\s+\w+/.test(ctx.trimmed)) rust += 2;
  if (/let\s+mut\s+/.test(ctx.trimmed)) rust += 2;
  add('Rust', SupportedFabFileMimeTypes.RUST, rust);

  let cs = 0;
  if (/\bnamespace\s+\w+/.test(firstFewLines)) cs += 3;
  if (/\busing\s+\w+;/.test(firstFewLines) && /\bnamespace\b/.test(ctx.trimmed)) cs += 3;
  add('C#', SupportedFabFileMimeTypes.CS, cs);

  let ruby = 0;
  if (/\bdef\s+\w+/.test(firstFewLines) && /\bend\b/.test(ctx.trimmed)) ruby += 3;
  if (/\brequire\s+['"]/.test(firstFewLines)) ruby += 2;
  if (/\bmodule\s+\w+/.test(ctx.trimmed)) ruby += 2;
  add('Ruby', SupportedFabFileMimeTypes.RUBY, ruby);

  let swift = 0;
  if (/\bimport\s+Foundation\b/.test(firstFewLines)) swift += 4;
  if (/\bfunc\s+\w+\s*\(/.test(ctx.trimmed) && /\s+->\s+/.test(ctx.trimmed)) swift += 2;
  add('Swift', SupportedFabFileMimeTypes.SWIFT, swift);

  let kotlin = 0;
  if (/\bfun\s+\w+/.test(firstFewLines)) kotlin += 4;
  if (/\bval\s+\w+/.test(ctx.trimmed)) kotlin += 2;
  add('Kotlin', SupportedFabFileMimeTypes.KOTLIN, kotlin);

  // Convert scores to results with confidence similar to detectProgrammingLanguage
  const results: FormatDetectionResult[] = scores
    .filter(s => s.score >= 3)
    .map(s => ({
      format: getFormat(s.format),
      confidence: Math.min(0.7 + s.score * 0.05, 0.95),
      reason: `${s.name} patterns detected`,
    }));

  return results;
}

function detectCss(ctx: DetectionContext): FormatDetectionResult | null {
  // Quick checks
  if (!ctx.trimmed.includes('{') || !ctx.trimmed.includes(':')) return null;

  const hasSelectors = /[.#][a-zA-Z][a-zA-Z0-9_-]*\s*\{/.test(ctx.trimmed);
  const hasProperties = /:\s*[^;]+;/.test(ctx.trimmed);

  if (hasSelectors || hasProperties) {
    return {
      format: getFormat(SupportedFabFileMimeTypes.CSS),
      confidence: 0.7,
      reason: 'CSS syntax detected',
    };
  }

  return null;
}

// Get format option by mime type
export function getFormatByMimeType(mimeType: string): FileFormatOption | undefined {
  return COMMON_FILE_FORMATS.find(f => f.mimeType === mimeType);
}

// Get file extension for a mime type
export function getExtensionForMimeType(mimeType: string): string {
  const format = getFormatByMimeType(mimeType);
  return format?.extension || 'txt';
}

// Update filename extension to match mime type
export function updateFileNameExtension(fileName: string, mimeType: string): string {
  const newExtension = getExtensionForMimeType(mimeType);
  const lastDotIndex = fileName.lastIndexOf('.');

  if (lastDotIndex === -1) {
    // No extension, add one
    return `${fileName}.${newExtension}`;
  }

  // Replace existing extension
  return `${fileName.substring(0, lastDotIndex)}.${newExtension}`;
}
