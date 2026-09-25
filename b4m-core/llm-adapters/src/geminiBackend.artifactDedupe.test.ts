/**
 * Regression test for #3253 on GeminiBackend - see anthropicBackend.artifactDedupe.test.ts
 * for the full mechanism. Gemini's tool_result is JSON.stringify'd ({ result: <tool output> })
 * before it re-enters history, but the mermaid artifact tag still round-trips inside that JSON
 * string verbatim, so the model can still echo it back in its synthesized reply.
 */
import { describe, it, expect } from 'vitest';
import { GeminiBackend } from './geminiBackend';
import type { ICompletionOptionTools } from './backend';

const MERMAID_ARTIFACT =
  '<artifact identifier="mermaid-1" type="application/vnd.ant.mermaid" title="Flow">graph TD;A-->B</artifact>';

const mermaidTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'mermaid_chart',
    description: 'Generate a Mermaid chart',
    parameters: {
      type: 'object',
      properties: { definition: { type: 'string' } },
      required: ['definition'],
    },
  },
  toolFn: async () => MERMAID_ARTIFACT,
};

describe('GeminiBackend does not duplicate an echoed tool artifact card (#3253)', () => {
  it('strips the artifact tag from history and from an echoed recursive reply', async () => {
    const backend = new GeminiBackend('test-key');
    const captured: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      models: {
        generateContentStream: async (request: unknown) => {
          captured.push(request);
          if (captured.length === 1) {
            return (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ functionCall: { name: 'mermaid_chart', args: { definition: 'graph TD;A-->B' } } }],
                    },
                  },
                ],
                usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
              };
            })();
          }
          return (async function* () {
            yield {
              candidates: [{ content: { parts: [{ text: `Here is your diagram:\n\n${MERMAID_ARTIFACT}` }] } }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
            };
          })();
        },
      },
    };

    const emitted: (string | null | undefined)[] = [];
    await backend.complete(
      'gemini-2.5-flash' as never,
      [{ role: 'user', content: 'a simple process flow diagram' }],
      { stream: true, tools: [mermaidTool] },
      async results => {
        emitted.push(...results);
      }
    );

    const clientText = emitted.filter((r): r is string => typeof r === 'string').join('');
    const artifactTagCount = (clientText.match(/<artifact\b/g) || []).length;
    expect(artifactTagCount).toBe(1);

    const turn2Serialized = JSON.stringify(captured[1]);
    expect(turn2Serialized).not.toContain('<artifact');
    expect(turn2Serialized).toContain('[Artifact rendered and delivered to user]');
  });

  it('strips the artifact tag from history and from an echoed recursive reply (non-streaming)', async () => {
    const backend = new GeminiBackend('test-key');
    const captured: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      models: {
        generateContent: async (request: unknown) => {
          captured.push(request);
          if (captured.length === 1) {
            return {
              candidates: [
                {
                  content: {
                    parts: [{ functionCall: { name: 'mermaid_chart', args: { definition: 'graph TD;A-->B' } } }],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
            };
          }
          return {
            candidates: [{ content: { parts: [{ text: `Here is your diagram:\n\n${MERMAID_ARTIFACT}` }] } }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
          };
        },
      },
    };

    const emitted: (string | null | undefined)[] = [];
    await backend.complete(
      'gemini-2.5-flash' as never,
      [{ role: 'user', content: 'a simple process flow diagram' }],
      { stream: false, tools: [mermaidTool] },
      async results => {
        emitted.push(...results);
      }
    );

    const clientText = emitted.filter((r): r is string => typeof r === 'string').join('');
    const artifactTagCount = (clientText.match(/<artifact\b/g) || []).length;
    expect(artifactTagCount).toBe(1);

    const turn2Serialized = JSON.stringify(captured[1]);
    expect(turn2Serialized).not.toContain('<artifact');
    expect(turn2Serialized).toContain('[Artifact rendered and delivered to user]');
  });
});
