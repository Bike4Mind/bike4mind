// prism-languages.ts - Prism language definitions for syntax highlighting.
// IMPORTANT: import in dependency order - many languages depend on others
// (e.g. TypeScript depends on JavaScript).

// Base languages (no dependencies) - MUST come first
import 'prismjs/components/prism-markup'; // HTML, XML, SVG - many languages depend on this
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-clike'; // C-like languages base - many languages depend on this
import 'prismjs/components/prism-javascript'; // Base for JSX, TypeScript, etc.

// Languages that depend on JavaScript
import 'prismjs/components/prism-jsx'; // Depends on: markup, javascript
import 'prismjs/components/prism-typescript'; // Depends on: javascript
import 'prismjs/components/prism-tsx'; // Depends on: jsx, typescript

// Other web languages
import 'prismjs/components/prism-json';

// Languages that depend on clike
import 'prismjs/components/prism-c'; // Depends on: clike
import 'prismjs/components/prism-cpp'; // Depends on: c
import 'prismjs/components/prism-java'; // Depends on: clike
import 'prismjs/components/prism-csharp'; // Depends on: clike
import 'prismjs/components/prism-go'; // Depends on: clike
import 'prismjs/components/prism-rust'; // Depends on: clike
import 'prismjs/components/prism-swift'; // Depends on: clike
import 'prismjs/components/prism-kotlin'; // Depends on: clike
import 'prismjs/components/prism-dart'; // Depends on: clike

// Languages that depend on markup
import 'prismjs/components/prism-markup-templating'; // Required by PHP and other template languages
import 'prismjs/components/prism-php'; // Depends on: markup-templating

// Scripting languages (no dependencies)
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-powershell';

// Database and query languages
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-graphql';

// Markup and data formats
import 'prismjs/components/prism-markdown'; // Depends on: markup
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';

// DevOps and tooling
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-git';

/**
 * Prism registers languages globally (window.Prism); importing this file
 * makes them available to the CodeHighlightPlugin.
 */
