/**
 * Code Block Title Extractor
 *
 * Extracts meaningful titles from code blocks based on their content.
 * Uses language-specific patterns to find component names, function names, class names, etc.
 *
 * Priority system:
 * 1. Explicit artifact title (highest priority - always respected)
 * 2. Extracted content-based title
 * 3. Language-based fallback (lowest priority)
 */

// Memoization cache for performance
const titleCache = new Map<string, string>();

/**
 * Main entry point for extracting titles from code blocks
 */
export function extractCodeBlockTitle(code: string, language: string, explicitTitle?: string): string {
  // Priority 1: Explicit titles (from artifact tags) should always be used
  if (explicitTitle && explicitTitle.trim()) {
    return explicitTitle.trim();
  }

  // Check cache for performance
  const cacheKey = `${language}:${code.substring(0, 200)}`; // Use first 200 chars as key
  if (titleCache.has(cacheKey)) {
    return titleCache.get(cacheKey)!;
  }

  // Priority 2: Extract content-based title
  let extractedTitle: string | null = null;

  switch (language.toLowerCase()) {
    case 'javascript':
    case 'js':
      extractedTitle = extractJavaScriptTitle(code);
      break;

    case 'typescript':
    case 'ts':
      extractedTitle = extractTypeScriptTitle(code);
      break;

    case 'jsx':
    case 'tsx':
      extractedTitle = extractReactTitle(code);
      break;

    case 'python':
    case 'py':
      extractedTitle = extractPythonTitle(code);
      break;

    case 'html':
      extractedTitle = extractHTMLTitle(code);
      break;

    case 'css':
    case 'scss':
    case 'sass':
      extractedTitle = extractCSSTitle(code);
      break;

    case 'sql':
      extractedTitle = extractSQLTitle(code);
      break;

    case 'bash':
    case 'sh':
    case 'shell':
      extractedTitle = extractBashTitle(code);
      break;

    case 'json':
      extractedTitle = extractJSONTitle(code);
      break;

    case 'yaml':
    case 'yml':
      extractedTitle = extractYAMLTitle(code);
      break;

    default:
      // Try generic extraction for unknown languages
      extractedTitle = extractGenericTitle(code);
  }

  // Priority 3: Language-based fallback
  const finalTitle = extractedTitle || `${capitalizeFirst(language)} Code Block`;

  // Cache the result
  titleCache.set(cacheKey, finalTitle);

  // Limit cache size (LRU-like behavior)
  if (titleCache.size > 100) {
    const firstKey = titleCache.keys().next().value;
    if (firstKey !== undefined) {
      titleCache.delete(firstKey);
    }
  }

  return finalTitle;
}

/**
 * Extract title from JavaScript code
 * Looks for: function names, const declarations, class names
 */
function extractJavaScriptTitle(code: string): string | null {
  // Try to find any function declaration (prioritize any function over other patterns)
  const anyFunctionMatch = code.match(/function\s+([a-zA-Z][a-zA-Z0-9]*)/);
  if (anyFunctionMatch) {
    return anyFunctionMatch[1];
  }

  // Try to find exported functions
  const exportMatch = code.match(/export\s+(?:default\s+)?function\s+([a-zA-Z][a-zA-Z0-9]*)/);
  if (exportMatch) {
    return exportMatch[1];
  }

  // Try to find const/let/var function assignments (arrow functions or regular functions)
  const constFunctionMatch = code.match(/(?:const|let|var)\s+([a-zA-Z][a-zA-Z0-9]*)\s*=\s*(?:function|\(|async)/);
  if (constFunctionMatch) {
    return constFunctionMatch[1];
  }

  // Try to find class declarations
  const classMatch = code.match(/class\s+([A-Z][a-zA-Z0-9]*)/);
  if (classMatch) {
    return classMatch[1];
  }

  // Try to find const/let/var declarations with capitalized names (likely classes or constructors)
  const constMatch = code.match(/(?:const|let|var)\s+([A-Z][a-zA-Z0-9]*)\s*=/);
  if (constMatch) {
    return constMatch[1];
  }

  return null;
}

/**
 * Extract title from TypeScript code
 * Looks for: interfaces, types, classes, functions
 */
function extractTypeScriptTitle(code: string): string | null {
  // Try JavaScript extraction first
  const jsTitle = extractJavaScriptTitle(code);
  if (jsTitle) return jsTitle;

  // Try to find interface declarations
  const interfaceMatch = code.match(/interface\s+([A-Z][a-zA-Z0-9]*)/);
  if (interfaceMatch) {
    return interfaceMatch[1];
  }

  // Try to find type declarations
  const typeMatch = code.match(/type\s+([A-Z][a-zA-Z0-9]*)/);
  if (typeMatch) {
    return typeMatch[1];
  }

  return null;
}

/**
 * Extract title from React/JSX/TSX code
 * Looks for: component names (functional or class components)
 */
function extractReactTitle(code: string): string | null {
  // Try to find React functional component (const ComponentName = )
  const functionalMatch = code.match(/(?:const|let|var|export(?:\s+default)?)\s+([A-Z][a-zA-Z0-9]*)\s*[=:]/);
  if (functionalMatch) {
    return functionalMatch[1];
  }

  // Try to find React class component
  const classMatch = code.match(/class\s+([A-Z][a-zA-Z0-9]*)\s+extends\s+(?:React\.)?Component/);
  if (classMatch) {
    return classMatch[1];
  }

  // Try to find function component
  const functionMatch = code.match(/(?:export\s+(?:default\s+)?)?function\s+([A-Z][a-zA-Z0-9]*)/);
  if (functionMatch) {
    return functionMatch[1];
  }

  return null;
}

/**
 * Extract title from Python code
 * Looks for: class names, function names
 */
function extractPythonTitle(code: string): string | null {
  // Try to find class declarations
  const classMatch = code.match(/class\s+([A-Z][a-zA-Z0-9]*)/);
  if (classMatch) {
    return classMatch[1];
  }

  // Try to find function declarations
  const functionMatch = code.match(/def\s+([a-z][a-zA-Z0-9_]*)/);
  if (functionMatch) {
    return functionMatch[1];
  }

  return null;
}

/**
 * Extract title from HTML code
 * Looks for: <title> tag, first <h1> tag, or descriptive comments
 */
function extractHTMLTitle(code: string): string | null {
  // Try to find <title> tag
  const titleMatch = code.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    return titleMatch[1].trim();
  }

  // Try to find first <h1> tag
  const h1Match = code.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) {
    return h1Match[1].trim();
  }

  // Try to find descriptive comment at the top
  const commentMatch = code.match(/<!--\s*([^-]+?)\s*-->/);
  if (commentMatch) {
    const comment = commentMatch[1].trim();
    if (comment.length < 50 && comment.length > 3) {
      return comment;
    }
  }

  return null;
}

/**
 * Extract title from CSS/SCSS code
 * Looks for: main class name, id, or descriptive comments
 */
function extractCSSTitle(code: string): string | null {
  // Try to find descriptive comment at the top
  const commentMatch = code.match(/\/\*\s*([^*]+?)\s*\*\//);
  if (commentMatch) {
    const comment = commentMatch[1].trim();
    if (comment.length < 50 && comment.length > 3) {
      return comment;
    }
  }

  // Try to find main class or id
  const classMatch = code.match(/\.([a-zA-Z][a-zA-Z0-9-_]*)\s*{/);
  if (classMatch) {
    return classMatch[1];
  }

  return null;
}

/**
 * Extract title from SQL code
 * Looks for: table names, query types
 */
function extractSQLTitle(code: string): string | null {
  const normalizedCode = code.trim().toUpperCase();

  // CREATE TABLE
  const createMatch = code.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (createMatch) {
    return `Create ${createMatch[1]} Table`;
  }

  // SELECT FROM
  const selectMatch = code.match(/SELECT\s+.+?\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (selectMatch) {
    return `Query ${selectMatch[1]}`;
  }

  // INSERT INTO
  const insertMatch = code.match(/INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (insertMatch) {
    return `Insert into ${insertMatch[1]}`;
  }

  // UPDATE
  const updateMatch = code.match(/UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (updateMatch) {
    return `Update ${updateMatch[1]}`;
  }

  // DELETE FROM
  const deleteMatch = code.match(/DELETE\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (deleteMatch) {
    return `Delete from ${deleteMatch[1]}`;
  }

  // Query type only
  if (normalizedCode.startsWith('SELECT')) return 'SQL Query';
  if (normalizedCode.startsWith('CREATE')) return 'Create Table';
  if (normalizedCode.startsWith('INSERT')) return 'Insert Data';
  if (normalizedCode.startsWith('UPDATE')) return 'Update Data';
  if (normalizedCode.startsWith('DELETE')) return 'Delete Data';

  return null;
}

/**
 * Extract title from Bash/Shell scripts
 * Looks for: descriptive comments at the top
 */
function extractBashTitle(code: string): string | null {
  // Try to find descriptive comment at the top (after shebang)
  const commentMatch = code.match(/^#!.*\n#\s*([^\n]+)/);
  if (commentMatch) {
    const comment = commentMatch[1].trim();
    if (comment.length < 50 && comment.length > 3) {
      return comment;
    }
  }

  // Try to find first comment
  const firstCommentMatch = code.match(/^#\s*([^\n]+)/);
  if (firstCommentMatch) {
    const comment = firstCommentMatch[1].trim();
    if (comment.length < 50 && comment.length > 3) {
      return comment;
    }
  }

  return null;
}

/**
 * Extract title from JSON
 * Looks for: name, title, or type fields
 */
function extractJSONTitle(code: string): string | null {
  try {
    const parsed = JSON.parse(code);

    if (parsed.name && typeof parsed.name === 'string') {
      return parsed.name;
    }

    if (parsed.title && typeof parsed.title === 'string') {
      return parsed.title;
    }

    if (parsed.type && typeof parsed.type === 'string') {
      return `${parsed.type} Config`;
    }
  } catch {
    // If JSON parsing fails, try regex
    const nameMatch = code.match(/"(?:name|title)"\s*:\s*"([^"]+)"/);
    if (nameMatch) {
      return nameMatch[1];
    }
  }

  return null;
}

/**
 * Extract title from YAML
 * Looks for: name, title, or type fields
 */
function extractYAMLTitle(code: string): string | null {
  // Simple YAML parsing without a library
  const nameMatch = code.match(/^name\s*:\s*(.+)$/m);
  if (nameMatch) {
    return nameMatch[1].trim().replace(/["']/g, '');
  }

  const titleMatch = code.match(/^title\s*:\s*(.+)$/m);
  if (titleMatch) {
    return titleMatch[1].trim().replace(/["']/g, '');
  }

  const typeMatch = code.match(/^type\s*:\s*(.+)$/m);
  if (typeMatch) {
    return `${typeMatch[1].trim().replace(/["']/g, '')} Config`;
  }

  return null;
}

/**
 * Generic title extraction for unknown languages
 * Looks for: descriptive comments, capitalized identifiers
 */
function extractGenericTitle(code: string): string | null {
  // Try to find any comment at the top
  const commentMatch = code.match(/^(?:\/\/|#|\/\*|\<!--)\s*([^\n*>]+)/);
  if (commentMatch) {
    const comment = commentMatch[1].trim();
    if (comment.length < 50 && comment.length > 3) {
      return comment;
    }
  }

  // Try to find any capitalized identifier (likely a class or component name)
  const identifierMatch = code.match(/\b([A-Z][a-zA-Z0-9]{2,})\b/);
  if (identifierMatch) {
    return identifierMatch[1];
  }

  return null;
}

/**
 * Capitalize first letter of a string
 */
function capitalizeFirst(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Clear the title cache (useful for testing or memory management)
 */
export function clearTitleCache(): void {
  titleCache.clear();
}
