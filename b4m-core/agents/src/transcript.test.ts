import { describe, it, expect } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import { MISSING_TOOL_RESULT, repairTranscript, type ToolResultBuilder } from './transcript';

const use = (id: string, input: unknown = {}): IMessage =>
  ({ role: 'assistant', content: [{ type: 'tool_use', id, name: `tool_${id}`, input }] }) as IMessage;
const result = (id: string, content = `result ${id}`): IMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content }],
});
const openAiCall = (id: string, args: unknown = '{}'): IMessage =>
  ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: `tool_${id}`, arguments: args } }],
  }) as unknown as IMessage;
const openAiResult = (id: string): IMessage =>
  ({ role: 'tool', content: `result ${id}`, tool_call_id: id }) as unknown as IMessage;

const anthropicResults: ToolResultBuilder = (call, observation) => [result(call.id, observation)];
const openAiResults: ToolResultBuilder = (call, observation) => [
  { role: 'tool', content: observation, tool_call_id: call.id } as unknown as IMessage,
];

const system: IMessage = { role: 'system', content: 'system prompt' };
const question: IMessage = { role: 'user', content: 'question' };

describe('repairTranscript', () => {
  it('leaves a valid transcript untouched, message objects included', () => {
    const messages = [system, question, use('a'), result('a'), use('b'), result('b'), question];
    const before = [...messages];

    const report = repairTranscript(messages, anthropicResults);

    expect(report).toEqual({ synthesizedResults: 0, movedResults: 0, droppedResults: 0, replacedArguments: 0 });
    expect(messages).toHaveLength(before.length);
    messages.forEach((message, index) => expect(message).toBe(before[index]));
  });

  it('synthesizes a result for a call that has none, right after the call', () => {
    const messages = [system, question, use('a'), use('b'), result('b')];

    const report = repairTranscript(messages, anthropicResults);

    expect(report.synthesizedResults).toBe(1);
    expect(messages).toEqual([system, question, use('a'), result('a', MISSING_TOOL_RESULT), use('b'), result('b')]);
  });

  it('synthesizes a result for a trailing call', () => {
    const messages = [system, question, use('a')];

    repairTranscript(messages, anthropicResults);

    expect(messages).toEqual([system, question, use('a'), result('a', MISSING_TOOL_RESULT)]);
  });

  it('moves a result that is not directly after its call', () => {
    const messages = [system, question, use('a'), question, result('a')];

    const report = repairTranscript(messages, anthropicResults);

    expect(report.movedResults).toBe(1);
    expect(messages).toEqual([system, question, use('a'), result('a'), question]);
  });

  it('moves a result that precedes its call', () => {
    const messages = [system, result('a'), use('a')];

    const report = repairTranscript(messages, anthropicResults);

    expect(report.movedResults).toBe(1);
    expect(messages).toEqual([system, use('a'), result('a')]);
  });

  it('keeps the order of results that already follow a multi-call message', () => {
    const multiCall = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'tool_a', input: {} },
        { type: 'tool_use', id: 'b', name: 'tool_b', input: {} },
      ],
    } as IMessage;
    const messages = [system, multiCall, result('a'), result('b')];

    const report = repairTranscript(messages, anthropicResults);

    expect(report.movedResults).toBe(0);
    expect(messages).toEqual([system, multiCall, result('a'), result('b')]);
  });

  it('splits a carrier answering calls of two assistant messages behind each call', () => {
    const carrier: IMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'x', content: 'result x' },
        { type: 'tool_result', tool_use_id: 'y', content: 'result y' },
      ],
    };
    const messages = [system, use('x'), use('y'), carrier];

    const report = repairTranscript(messages, anthropicResults);

    expect(report).toEqual({ synthesizedResults: 0, movedResults: 2, droppedResults: 0, replacedArguments: 0 });
    expect(messages).toEqual([system, use('x'), result('x'), use('y'), result('y')]);
  });

  it('splits a carrier that sits behind the first call but also answers a later one', () => {
    const carrier: IMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'x', content: 'result x' },
        { type: 'tool_result', tool_use_id: 'y', content: 'result y' },
      ],
    };
    const messages = [system, use('x'), carrier, use('y')];

    const report = repairTranscript(messages, anthropicResults);

    expect(report.droppedResults).toBe(0);
    expect(report.synthesizedResults).toBe(0);
    expect(messages).toEqual([system, use('x'), result('x'), use('y'), result('y')]);
  });

  it('drops a duplicate result block inside one carrier', () => {
    const carrier: IMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'result a' },
        { type: 'tool_result', tool_use_id: 'a', content: 'again' },
      ],
    };
    const messages = [system, use('a'), carrier];

    const report = repairTranscript(messages, anthropicResults);

    expect(report.droppedResults).toBe(1);
    expect(messages).toEqual([system, use('a'), result('a')]);
  });

  it('drops a result whose call is not in the transcript', () => {
    const messages = [system, question, result('ghost'), use('a'), result('a')];

    const report = repairTranscript(messages, anthropicResults);

    expect(report.droppedResults).toBe(1);
    expect(messages).toEqual([system, question, use('a'), result('a')]);
  });

  it('drops a second result for a call that is already answered', () => {
    const messages = [system, openAiCall('a'), openAiResult('a'), question, openAiResult('a')];

    const report = repairTranscript(messages, openAiResults);

    expect(report.droppedResults).toBe(1);
    expect(messages).toEqual([system, openAiCall('a'), openAiResult('a'), question]);
  });

  it('drops the orphan result blocks from a carrier that also answers a call', () => {
    const carrier: IMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'result a' },
        { type: 'tool_result', tool_use_id: 'ghost', content: 'result ghost' },
      ],
    };
    const messages = [system, use('a'), carrier];

    const report = repairTranscript(messages, anthropicResults);

    expect(report.droppedResults).toBe(1);
    expect(messages).toEqual([system, use('a'), result('a')]);
  });

  it('replaces tool_use input that is not a JSON object', () => {
    const messages = [system, use('a', 'not-an-object'), result('a')];

    const report = repairTranscript(messages, anthropicResults);

    expect(report.replacedArguments).toBe(1);
    expect(messages).toEqual([system, use('a', {}), result('a')]);
  });

  it('repairs OpenAI-shaped calls through the backend builder', () => {
    const messages = [system, openAiCall('a', '{"path": '), openAiCall('b'), openAiResult('b')];

    const report = repairTranscript(messages, openAiResults);

    expect(report).toEqual({ synthesizedResults: 1, movedResults: 0, droppedResults: 0, replacedArguments: 1 });
    expect(messages).toEqual([
      system,
      openAiCall('a', '{}'),
      { role: 'tool', content: MISSING_TOOL_RESULT, tool_call_id: 'a' },
      openAiCall('b'),
      openAiResult('b'),
    ]);
  });

  it('leaves object arguments alone (Ollama sends them unserialized)', () => {
    const messages = [system, openAiCall('a', { path: 'x' }), openAiResult('a')];

    expect(repairTranscript(messages, openAiResults).replacedArguments).toBe(0);
  });

  it('counts a result inside a mixed message as answering its call, without moving it', () => {
    const mixed: IMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'result a' },
        { type: 'text', text: 'and a follow-up' },
      ],
    };
    const messages = [system, use('a'), mixed];

    const report = repairTranscript(messages, anthropicResults);

    expect(report.synthesizedResults).toBe(0);
    expect(messages).toEqual([system, use('a'), mixed]);
  });

  it('leaves a call unanswered when the backend cannot build a result', () => {
    const messages = [system, use('a')];

    const report = repairTranscript(messages, () => []);

    expect(report.synthesizedResults).toBe(0);
    expect(messages).toEqual([system, use('a')]);
  });
});
