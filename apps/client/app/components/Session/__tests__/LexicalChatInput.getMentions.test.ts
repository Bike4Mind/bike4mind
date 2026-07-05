import { describe, it, expect } from 'vitest';
import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import { ListNode, ListItemNode, $createListNode, $createListItemNode } from '@lexical/list';
import { BeautifulMentionNode, $createBeautifulMentionNode } from 'lexical-beautiful-mentions';
import { $collectMentions } from '../LexicalChatInput';

function makeEditor() {
  return createEditor({
    namespace: 'test',
    nodes: [BeautifulMentionNode, ListNode, ListItemNode],
    onError: (error: Error) => {
      throw error;
    },
  });
}

describe('$collectMentions', () => {
  it('returns an empty array when the editor has no mentions', () => {
    const editor = makeEditor();

    editor.update(
      () => {
        const root = $getRoot();
        const p = $createParagraphNode();
        p.append($createTextNode('hello world'));
        root.append(p);
      },
      { discrete: true }
    );

    editor.getEditorState().read(() => {
      expect($collectMentions($getRoot())).toEqual([]);
    });
  });

  it('collects a single mention with its trigger and value', () => {
    const editor = makeEditor();

    editor.update(
      () => {
        const root = $getRoot();
        const p = $createParagraphNode();
        p.append($createTextNode('hey '));
        p.append($createBeautifulMentionNode('@', 'research-lead'));
        root.append(p);
      },
      { discrete: true }
    );

    editor.getEditorState().read(() => {
      expect($collectMentions($getRoot())).toEqual([{ trigger: '@', value: 'research-lead' }]);
    });
  });

  it('returns mentions in document order across multiple paragraphs', () => {
    const editor = makeEditor();

    editor.update(
      () => {
        const root = $getRoot();

        const p1 = $createParagraphNode();
        p1.append($createBeautifulMentionNode('@', 'alpha'));
        p1.append($createTextNode(' please review'));
        root.append(p1);

        const p2 = $createParagraphNode();
        p2.append($createTextNode('cc '));
        p2.append($createBeautifulMentionNode('@', 'beta'));
        p2.append($createTextNode(' and '));
        p2.append($createBeautifulMentionNode('@', 'gamma'));
        root.append(p2);
      },
      { discrete: true }
    );

    editor.getEditorState().read(() => {
      expect($collectMentions($getRoot())).toEqual([
        { trigger: '@', value: 'alpha' },
        { trigger: '@', value: 'beta' },
        { trigger: '@', value: 'gamma' },
      ]);
    });
  });

  it('recurses into nested element nodes (lists)', () => {
    const editor = makeEditor();

    editor.update(
      () => {
        const root = $getRoot();

        const list = $createListNode('bullet');
        const li1 = $createListItemNode();
        li1.append($createBeautifulMentionNode('@', 'in-list-1'));
        list.append(li1);

        const li2 = $createListItemNode();
        li2.append($createTextNode('text then '));
        li2.append($createBeautifulMentionNode('@', 'in-list-2'));
        list.append(li2);

        root.append(list);
      },
      { discrete: true }
    );

    editor.getEditorState().read(() => {
      expect($collectMentions($getRoot())).toEqual([
        { trigger: '@', value: 'in-list-1' },
        { trigger: '@', value: 'in-list-2' },
      ]);
    });
  });

  it('returns the same mention twice when it appears twice (no dedupe)', () => {
    const editor = makeEditor();

    editor.update(
      () => {
        const root = $getRoot();
        const p = $createParagraphNode();
        p.append($createBeautifulMentionNode('@', 'bob'));
        p.append($createTextNode(' and '));
        p.append($createBeautifulMentionNode('@', 'bob'));
        root.append(p);
      },
      { discrete: true }
    );

    editor.getEditorState().read(() => {
      expect($collectMentions($getRoot())).toEqual([
        { trigger: '@', value: 'bob' },
        { trigger: '@', value: 'bob' },
      ]);
    });
  });

  it('preserves the trigger character (supports non-@ triggers)', () => {
    const editor = makeEditor();

    editor.update(
      () => {
        const root = $getRoot();
        const p = $createParagraphNode();
        p.append($createBeautifulMentionNode('#', 'topic-x'));
        p.append($createTextNode(' '));
        p.append($createBeautifulMentionNode('@', 'user-y'));
        root.append(p);
      },
      { discrete: true }
    );

    editor.getEditorState().read(() => {
      expect($collectMentions($getRoot())).toEqual([
        { trigger: '#', value: 'topic-x' },
        { trigger: '@', value: 'user-y' },
      ]);
    });
  });
});
