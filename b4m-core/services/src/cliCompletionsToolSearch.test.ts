import { describe, it, expect } from 'vitest';
import { BadRequestError, ChatModels, ModelBackend, type CompletionTool, type IMessage } from '@bike4mind/common';
import { prepareWireTools } from './cliCompletionsToolSearch';

const DIRECT = { id: ChatModels.CLAUDE_5_5_OPUS, backend: ModelBackend.Anthropic };
const BEDROCK = { id: ChatModels.CLAUDE_5_5_OPUS_BEDROCK, backend: ModelBackend.Bedrock };
const OPENAI = { id: ChatModels.GPT5, backend: ModelBackend.OpenAI };
const OLD_CLAUDE = { id: ChatModels.CLAUDE_4_1_OPUS, backend: ModelBackend.Anthropic };

const hi: IMessage[] = [{ role: 'user', content: 'hi' }];
const searchTool: CompletionTool = {
  serverTool: { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
};

function custom(name: string, extra: Record<string, unknown> = {}): CompletionTool {
  return {
    toolSchema: { name, description: `${name} tool`, parameters: { type: 'object' }, ...extra },
  } as CompletionTool;
}

function refusal(fn: () => unknown): { errorCode?: unknown; status?: number } {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestError);
    const bad = error as BadRequestError;
    return { errorCode: bad.additionalInfo?.errorCode, status: bad.statusCode };
  }
  throw new Error('expected a BadRequestError');
}

function withToolResult(content: unknown[]): IMessage[] {
  return [
    { role: 'user', content: 'find a tool' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'find_tools', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] },
  ] as IMessage[];
}

describe('prepareWireTools', () => {
  it('returns plain tools unchanged with no provider tools', () => {
    const tools = [custom('a', { strict: true })];
    expect(prepareWireTools(tools, hi, DIRECT)).toEqual({ tools, providerTools: [] });
    expect(prepareWireTools(tools, hi, OPENAI)).toEqual({ tools, providerTools: [] });
    expect(prepareWireTools(undefined, hi, DIRECT)).toEqual({ tools: [], providerTools: [] });
  });

  it('splits server tools out and keeps defer_loading on a direct Anthropic model', () => {
    const prepared = prepareWireTools([custom('a', { defer_loading: true }), custom('b'), searchTool], hi, DIRECT);
    expect(prepared.tools.map(t => t.toolSchema)).toEqual([
      expect.objectContaining({ name: 'a', defer_loading: true }),
      expect.not.objectContaining({ defer_loading: expect.anything() }),
    ]);
    expect(prepared.providerTools).toEqual([searchTool.serverTool]);
  });

  it('never forwards cache_control', () => {
    const prepared = prepareWireTools([custom('a', { cache_control: { type: 'ephemeral' } })], hi, DIRECT);
    expect(prepared.tools[0].toolSchema).not.toHaveProperty('cache_control');
  });

  it.each([
    ['a non-Anthropic model', OPENAI],
    ['a Bedrock-served Claude model', BEDROCK],
    ['a Claude model without tool search', OLD_CLAUDE],
  ])('ignores defer_loading on %s', (_label, model) => {
    const prepared = prepareWireTools(
      [custom('a', { defer_loading: true }), custom('b', { defer_loading: true })],
      hi,
      model
    );
    expect(prepared.tools).toEqual([custom('a'), custom('b')]);
    expect(prepared.providerTools).toEqual([]);
  });

  it.each([
    ['a non-Anthropic model', OPENAI],
    ['a Bedrock-served Claude model', BEDROCK],
    ['a Claude model without tool search', OLD_CLAUDE],
    ['an unresolved model', undefined],
  ])('refuses a server tool on %s', (_label, model) => {
    expect(refusal(() => prepareWireTools([custom('a'), searchTool], hi, model))).toEqual({
      errorCode: 'tool_search_unsupported',
      status: 400,
    });
  });

  it('points a Bedrock caller at the direct model', () => {
    expect(() => prepareWireTools([searchTool], hi, BEDROCK)).toThrow(/Bedrock/);
  });

  it('refuses tool_reference blocks and echoed tool search blocks where tool search is unsupported', () => {
    const references = withToolResult([{ type: 'tool_reference', tool_name: 'a' }]);
    expect(refusal(() => prepareWireTools([custom('a')], references, BEDROCK)).errorCode).toBe(
      'tool_search_unsupported'
    );

    const echoed = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: {} }],
      },
      { role: 'user', content: 'go on' },
    ] as IMessage[];
    expect(refusal(() => prepareWireTools([custom('a')], echoed, OPENAI)).errorCode).toBe('tool_search_unsupported');
  });

  it('lets a non-search server_tool_use echo through on a model without tool search', () => {
    const echoedWebSearch = [
      { role: 'user', content: 'news?' },
      {
        role: 'assistant',
        content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'news' } }],
      },
      { role: 'user', content: 'go on' },
    ] as IMessage[];
    expect(() => prepareWireTools([custom('a')], echoedWebSearch, OPENAI)).not.toThrow();
  });

  it('refuses a server tool that is not a tool search tool', () => {
    const webSearch = {
      serverTool: { type: 'web_search_20250305', name: 'web_search', max_uses: 50 },
    } as unknown as CompletionTool;
    expect(refusal(() => prepareWireTools([webSearch], hi, DIRECT))).toEqual({
      errorCode: 'tool_search_unsupported',
      status: 400,
    });
  });

  it('refuses a request where every tool is deferred and no server tool is sent', () => {
    expect(
      refusal(() =>
        prepareWireTools([custom('a', { defer_loading: true }), custom('b', { defer_loading: true })], hi, DIRECT)
      )
    ).toEqual({ errorCode: 'all_tools_deferred', status: 400 });
  });

  it('counts the server tool as the non-deferred tool', () => {
    expect(() => prepareWireTools([custom('a', { defer_loading: true }), searchTool], hi, DIRECT)).not.toThrow();
  });

  it('allows deferred tools without a server tool while one tool stays loaded', () => {
    expect(() => prepareWireTools([custom('a', { defer_loading: true }), custom('b')], hi, DIRECT)).not.toThrow();
  });

  it('refuses cache_control on a deferred tool', () => {
    expect(
      refusal(() =>
        prepareWireTools(
          [custom('a', { defer_loading: true, cache_control: { type: 'ephemeral' } }), custom('b'), searchTool],
          hi,
          DIRECT
        )
      )
    ).toEqual({ errorCode: 'deferred_tool_cache_control', status: 400 });
  });

  it('accepts a tool_reference to a declared tool and refuses one to an undeclared or unnamed tool', () => {
    const tools = [custom('find_tools'), custom('get_weather', { defer_loading: true })];
    expect(() =>
      prepareWireTools(tools, withToolResult([{ type: 'tool_reference', tool_name: 'get_weather' }]), DIRECT)
    ).not.toThrow();
    expect(
      refusal(() => prepareWireTools(tools, withToolResult([{ type: 'tool_reference', tool_name: 'nope' }]), DIRECT))
        .errorCode
    ).toBe('unknown_tool_reference');
    expect(refusal(() => prepareWireTools(tools, withToolResult([{ type: 'tool_reference' }]), DIRECT)).errorCode).toBe(
      'unknown_tool_reference'
    );
  });

  it('checks the tool_references of an echoed tool_search_tool_result against tools', () => {
    const echoedSearch = (toolName: string) =>
      [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: {} },
            {
              type: 'tool_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: {
                type: 'tool_search_tool_search_result',
                tool_references: [{ type: 'tool_reference', tool_name: toolName }],
              },
            },
          ],
        },
        { role: 'user', content: 'go on' },
      ] as IMessage[];
    const tools = [custom('find_tools'), custom('get_weather', { defer_loading: true }), searchTool];

    expect(() => prepareWireTools(tools, echoedSearch('get_weather'), DIRECT)).not.toThrow();
    expect(refusal(() => prepareWireTools(tools, echoedSearch('nope'), DIRECT)).errorCode).toBe(
      'unknown_tool_reference'
    );
  });
});

describe('prepareWireTools tool changes', () => {
  const change = (
    type: 'tool_addition' | 'tool_removal',
    name: string,
    extra: Record<string, unknown> = {}
  ): IMessage =>
    ({ role: 'system', content: [{ type, tool: { type: 'tool_reference', name } }], ...extra }) as IMessage;
  const tools = [custom('a'), custom('b', { defer_loading: true })];
  const serverResult = {
    type: 'tool_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: { type: 'tool_search_tool_search_result', tool_references: [] },
  };

  it('accepts a change after a user turn that precedes an assistant turn', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      change('tool_addition', 'b'),
      { role: 'assistant', content: 'ok' },
    ] as IMessage[];
    expect(prepareWireTools(tools, messages, DIRECT).tools).toHaveLength(2);
  });

  it('accepts a change as the last message after a user turn', () => {
    expect(() => prepareWireTools(tools, [...hi, change('tool_removal', 'a')], DIRECT)).not.toThrow();
  });

  it('accepts a change after an assistant turn ending in a server tool result', () => {
    const messages = [
      { role: 'user', content: 'find' },
      { role: 'assistant', content: [{ type: 'text', text: 'searching' }, serverResult] },
      change('tool_addition', 'b'),
    ] as IMessage[];
    expect(() => prepareWireTools(tools, messages, DIRECT)).not.toThrow();
  });

  it('ignores plain system messages when judging neighbours', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'be brief' },
      change('tool_addition', 'b'),
    ] as IMessage[];
    expect(() => prepareWireTools(tools, messages, DIRECT)).not.toThrow();
  });

  it.each([
    ['Bedrock', BEDROCK],
    ['OpenAI', OPENAI],
    ['an older Claude', OLD_CLAUDE],
    ['an unknown model', undefined],
  ])('refuses a change on %s with tool_changes_unsupported', (_label, model) => {
    expect(refusal(() => prepareWireTools(tools, [...hi, change('tool_addition', 'b')], model))).toEqual({
      errorCode: 'tool_changes_unsupported',
      status: 400,
    });
  });

  it.each([
    ['a lone message', [change('tool_addition', 'b')]],
    ['one after an assistant text turn', [...hi, { role: 'assistant', content: 'ok' }, change('tool_addition', 'b')]],
    ['one before a user turn', [...hi, change('tool_addition', 'b'), { role: 'user', content: 'again' }]],
    ['two back to back', [...hi, change('tool_addition', 'b'), change('tool_removal', 'a')]],
  ])('refuses %s as invalid_tool_change', (_label, messages) => {
    expect(refusal(() => prepareWireTools(tools, messages as IMessage[], DIRECT)).errorCode).toBe(
      'invalid_tool_change'
    );
  });

  it.each([
    ['an inline definition', { type: 'tool_addition', tool: { type: 'tool_reference', name: 'b', input_schema: {} } }],
    ['an MCP reference', { type: 'tool_addition', tool: { type: 'mcp_tool_reference', name: 'b' } }],
    ['a mixed message', { type: 'text', text: 'also this' }],
  ])('refuses %s as invalid_tool_change', (_label, block) => {
    const first = { type: 'tool_removal', tool: { type: 'tool_reference', name: 'a' } };
    const messages = [...hi, { role: 'system', content: [first, block] }] as IMessage[];
    expect(refusal(() => prepareWireTools(tools, messages, DIRECT)).errorCode).toBe('invalid_tool_change');
  });

  it('refuses a tool change block outside a system message', () => {
    const messages = [
      { role: 'user', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'b' } }] },
    ] as IMessage[];
    expect(refusal(() => prepareWireTools(tools, messages, DIRECT)).errorCode).toBe('invalid_tool_change');
  });

  it('refuses a change naming a tool that is not in tools, for an addition and a removal', () => {
    for (const type of ['tool_addition', 'tool_removal'] as const) {
      expect(refusal(() => prepareWireTools(tools, [...hi, change(type, 'ghost')], DIRECT)).errorCode).toBe(
        'unknown_tool_reference'
      );
    }
  });
});
