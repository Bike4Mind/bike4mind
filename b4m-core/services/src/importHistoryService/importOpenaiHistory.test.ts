import { describe, it, expect } from 'vitest';
import { processOpenaiConversationNode, type IOpenaiConversationMapping } from './importOpenaiHistory';

/** Minimal mapping node. `conversations.json` is user-uploaded, so ids are attacker-chosen. */
function node(id: string, children: string[], text?: string): IOpenaiConversationMapping {
  return {
    id,
    parent: null,
    children,
    message: text
      ? ({
          id: `msg_${id}`,
          author: { role: 'user', name: null, metadata: {} },
          content: { content_type: 'text', parts: [text] },
        } as IOpenaiConversationMapping['message'])
      : null,
  } as IOpenaiConversationMapping;
}

describe('processOpenaiConversationNode reserved-key node ids', () => {
  // A node id that names an Object.prototype member resolves through the prototype chain on a
  // plain-object index, so a truthy-check guard reads a function as "the node exists" and the
  // recursion then dies on an opaque TypeError far from the real cause.
  it.each(['toString', 'valueOf', 'hasOwnProperty', 'constructor'])(
    'reports a missing child named %s instead of recursing into Object.prototype',
    reserved => {
      const mappings: Record<string, IOpenaiConversationMapping> = { root: node('root', [reserved]) };

      expect(() => processOpenaiConversationNode('session-1', mappings.root, mappings)).toThrowError(
        `Child node ${reserved} not found`
      );
    }
  );

  it('reports a missing reply node named toString instead of reading it off the prototype', () => {
    const root = node('root', ['toString'], 'hello');
    const mappings: Record<string, IOpenaiConversationMapping> = { root };

    expect(() => processOpenaiConversationNode('session-1', root, mappings)).toThrowError(
      /missing reply node toString/
    );
  });

  it('still walks a well-formed tree', () => {
    const child = node('child', [], 'reply');
    const root = node('root', ['child']);
    const mappings: Record<string, IOpenaiConversationMapping> = { root, child };

    expect(() => processOpenaiConversationNode('session-1', root, mappings)).not.toThrow();
  });
});
