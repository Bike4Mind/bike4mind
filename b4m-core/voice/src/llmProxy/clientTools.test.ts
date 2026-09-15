import { describe, it, expect } from 'vitest';
import { buildClientToolPassthrough, toolAcknowledgement, type CapturedToolCall } from './clientTools';
import type { OpenAIChatRequest } from './translator';

const req = (tools: OpenAIChatRequest['tools']): OpenAIChatRequest => ({
  model: 'custom-llm',
  messages: [{ role: 'user', content: 'hi' }],
  tools,
});

describe('toolAcknowledgement', () => {
  it('returns the keyed ack for known tools and a generic ack otherwise', () => {
    expect(toolAcknowledgement('end_call')).toMatch(/do not say anything further/i);
    expect(toolAcknowledgement('language_detection')).toMatch(/language/i);
    expect(toolAcknowledgement('something_else')).toBe('Done.');
  });
});

describe('buildClientToolPassthrough', () => {
  it('returns an empty record when no tools are offered', () => {
    expect(buildClientToolPassthrough(req(undefined), () => {})).toEqual({});
  });

  it('builds one passthrough per offered tool, keyed and named by tool name', () => {
    const tools = buildClientToolPassthrough(
      req([
        {
          type: 'function',
          function: { name: 'end_call', description: 'hang up', parameters: { type: 'object', properties: {} } },
        },
        {
          type: 'function',
          function: {
            name: 'language_detection',
            description: 'switch lang',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]),
      () => {}
    );
    expect(Object.keys(tools).sort()).toEqual(['end_call', 'language_detection']);
    expect(tools.end_call.name).toBe('end_call');
    expect(tools.end_call.implementation().toolSchema.name).toBe('end_call');
  });

  it('captures the call and returns the ack instead of executing', async () => {
    const captured: CapturedToolCall[] = [];
    const tools = buildClientToolPassthrough(
      req([{ type: 'function', function: { name: 'end_call', parameters: { type: 'object', properties: {} } } }]),
      c => captured.push(c)
    );
    const result = await tools.end_call.implementation().toolFn({ reason: 'done' });
    expect(captured).toEqual([{ name: 'end_call', arguments: JSON.stringify({ reason: 'done' }) }]);
    expect(result).toMatch(/do not say anything further/i);
  });
});
