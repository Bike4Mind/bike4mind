#!/usr/bin/env tsx
/**
 * CI check: scan for hardcoded deprecated model IDs in source code.
 *
 * Self-updating: when a new deprecationDate passes in the model catalog,
 * add the model's string ID to DEPRECATED_MODEL_IDS below and the script
 * will automatically start flagging hardcoded refs.
 *
 * Usage:  npx tsx packages/scripts/src/checkDeprecatedModelUsage.ts
 * Exit 0 = clean, Exit 1 = deprecated model references found.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Deprecated model string IDs (both Bedrock and Anthropic-hosted)
const DEPRECATED_MODEL_IDS = [
  // Bedrock model IDs
  'anthropic.claude-3-5-sonnet-20240620-v1:0',
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  'anthropic.claude-3-haiku-20240307-v1:0',
  'anthropic.claude-3-opus-20240229-v1:0',
  // Anthropic-hosted model IDs
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-20250219',
  'claude-3-opus-20240229',
  'claude-3-haiku-20240307',
  'claude-3-sonnet-20240229',
];

// Files/directories to skip
const SKIP_PATTERNS = [
  /node_modules/,
  /\.next/,
  /dist\//,
  /\.sst\//,
  /migrations\//,
  /\.test\.(ts|tsx)$/,
  /\.spec\.(ts|tsx)$/,
  /models\.ts$/, // enum definitions
  /Model\.ts$/, // Mongoose model files (enum values kept for DB backward compat)
  /Types\.ts$/, // Type definition files (union types kept for DB backward compat)
  /Backend\.ts$/, // model catalog definitions
  /syncModelDescriptions\.ts$/, // model description catalog
  /resolveDeprecatedModel\.ts$/, // the resolver itself
  /checkDeprecatedModelUsage\.ts$/, // this script
  /fallback\.ts$/, // fallback map keys intentionally reference deprecated models
  /mocks\//, // test mock data
  /test-config\.ts$/, // test config fixtures
  /telemetryFingerprint\.ts$/, // normalization logic references old IDs in comments/examples
  /DEPRECATED_MODEL_MAP/, // map definitions are intentional
  /package\.json$/, // dependency manifests
  /package-lock\.json$/, // lock files
  /pnpm-lock\.yaml$/, // lock files
  /tsconfig.*\.json$/, // TypeScript config
];

function shouldSkip(filePath: string): boolean {
  return SKIP_PATTERNS.some(pattern => pattern.test(filePath));
}

function walkDir(dir: string, fileList: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.next' ||
        entry.name === '.open-next' ||
        entry.name === 'dist' ||
        entry.name === '.sst' ||
        entry.name === 'build' ||
        entry.name === 'out' ||
        entry.name === 'coverage'
      ) {
        continue;
      }
      walkDir(fullPath, fileList);
    } else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(entry.name)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

const rootDir = path.resolve(__dirname, '../../..');
const violations: { file: string; line: number; modelId: string; text: string }[] = [];

// Support --files mode: check only specific files passed as args (for pre-commit hook)
const filesFlag = process.argv.indexOf('--files');
let files: string[];
if (filesFlag !== -1) {
  // Files passed as remaining args after --files
  files = process.argv
    .slice(filesFlag + 1)
    .filter(f => /\.(ts|tsx|js|mjs|cjs|json)$/.test(f))
    .map(f => path.resolve(rootDir, f));
} else {
  files = walkDir(rootDir);
}

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const relPath = path.relative(rootDir, file);
  if (shouldSkip(relPath)) continue;

  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip lines that are part of a deprecation map, fallback definition, or comments
    if (
      line.includes('DEPRECATED_MODEL_MAP') ||
      line.includes('deprecatedModelMap') ||
      line.includes('fallbackPreferences') ||
      line.trimStart().startsWith('//') ||
      line.trimStart().startsWith('*') ||
      line.trimStart().startsWith('/**')
    ) {
      continue;
    }
    for (const modelId of DEPRECATED_MODEL_IDS) {
      if (line.includes(modelId)) {
        violations.push({
          file: relPath,
          line: i + 1,
          modelId,
          text: line.trim(),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`\n❌ Found ${violations.length} hardcoded deprecated model reference(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.modelId}`);
    console.error(`    ${v.text}\n`);
  }
  process.exit(1);
} else {
  console.log('✅ No hardcoded deprecated model references found.');
  process.exit(0);
}
