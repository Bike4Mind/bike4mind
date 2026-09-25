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

const RECHARTS_ARTIFACT =
  '<artifact identifier="chart-1" type="application/vnd.ant.recharts" title="Bar">{"data":[]}</artifact>';

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

const rechartsTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'recharts',
    description: 'Generate a recharts artifact',
    parameters: {
      type: 'object',
      properties: { definition: { type: 'string' } },
      required: ['definition'],
    },
  },
  toolFn: async () => RECHARTS_ARTIFACT,
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

  it('pin: a chained tool call artifact reaches the client AFTER the text that introduces it, not before', async () => {
    // Regression: the chained artifact used to escape straight to the client via a root-pinned
    // callback while the guard was still buffering the sentence meant to introduce it, reversing
    // the order the model actually generated them in.
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
          if (captured.length === 2) {
            return {
              candidates: [
                {
                  content: {
                    parts: [
                      { text: "Here's the second chart:" },
                      { functionCall: { name: 'recharts', args: { definition: '{}' } } },
                    ],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
            };
          }
          return {
            candidates: [{ content: { parts: [{ text: 'Done.' }] } }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
          };
        },
      },
    };

    const emitted: (string | null | undefined)[] = [];
    await backend.complete(
      'gemini-2.5-flash' as never,
      [{ role: 'user', content: 'two charts please' }],
      { stream: false, tools: [mermaidTool, rechartsTool] },
      async results => {
        emitted.push(...results);
      }
    );

    const clientText = emitted.filter((r): r is string => typeof r === 'string').join('');
    const introIndex = clientText.indexOf("Here's the second chart:");
    const chartIndex = clientText.indexOf('identifier="chart-1"');
    expect(introIndex).toBeGreaterThanOrEqual(0);
    expect(chartIndex).toBeGreaterThan(introIndex);
  });
});
