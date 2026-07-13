import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

/**
 * Untracked-AI-usage guard (issue #354 / epic #335).
 *
 * Every tool that makes its own provider call - an `llm.complete(...)` or a direct
 * `generateEmbedding(...)` - must route that spend through the usage infrastructure
 * (`recordToolOperationalUsage` for operational text, `recordOperationalUsage` for
 * embeddings). Otherwise the COGS is invisible to admins, which is exactly the leak
 * M1-M4 closed. This fails CI when a NEW tool call bypasses recording, so the audit
 * can't silently regress.
 *
 * Scope is intentionally the tools/implementation dir: that's where tool authors add
 * new provider calls with a narrowed ToolContext and no ambient settlement path. The
 * chat/agent path (ChatCompletionProcess) and session handlers record via their own
 * dedicated wrappers and are out of scope here.
 */

// Relative paths (from implementation/) that legitimately call a provider without the
// tool recorder, WITH the reason. Keep empty unless a real exception arises; a new
// entry must be justified in review.
const ALLOWLIST: Record<string, string> = {};

const implementationDir = fileURLToPath(new URL('../implementation', import.meta.url));

/** All non-test .ts source files under implementation/, as paths relative to that dir. */
function collectSourceFiles(dir: string, relBase = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(`${dir}/${entry.name}`, rel));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(rel);
    }
  }
  return out;
}

// Substrings that mark a paid provider call inside a tool: a direct completion/embedding,
// or a known helper that embeds internally (semanticDataLakeSearch). Extend this when a new
// provider-calling helper is introduced, or the guard goes blind to it.
const PROVIDER_CALL_MARKERS = ['.complete(', 'generateEmbedding(', 'semanticDataLakeSearch('];

// A compliant tool must CALL a recorder, not merely import one - so match the call form
// `name(`. This is still a lexical heuristic (it can't prove the call is reached on the
// spend path), but it defeats the "import satisfies the check" false-negative.
const RECORDING_CALLS = ['recordToolOperationalUsage(', 'recordOperationalUsage('];

describe('tool usage-recording guard', () => {
  const files = collectSourceFiles(implementationDir);

  it('finds tool source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every tool that makes a provider call records its usage', () => {
    const violations: string[] = [];

    for (const rel of files) {
      if (rel in ALLOWLIST) continue;
      const text = readFileSync(`${implementationDir}/${rel}`, 'utf8');
      const makesProviderCall = PROVIDER_CALL_MARKERS.some(marker => text.includes(marker));
      if (!makesProviderCall) continue;

      const records = RECORDING_CALLS.some(call => text.includes(call));
      if (!records) {
        violations.push(rel);
      }
    }

    expect(
      violations,
      `These tools make a provider call (llm.complete / generateEmbedding / semanticDataLakeSearch) without ` +
        `recording usage.\nRoute the spend through recordToolOperationalUsage (operational text) or ` +
        `recordOperationalUsage (embeddings), or add a justified entry to ALLOWLIST:\n${violations.join('\n')}`
    ).toEqual([]);
  });
});
