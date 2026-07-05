// Test inputs. Expected outputs are computed by reference.cjs at runtime.
const tu = (id) => ({ type: 'tool_use', id, name: 'search', input: { q: id } });
const tr = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok-' + id });
const txt = (t) => ({ type: 'text', text: t });

module.exports = [
  { name: 'empty array', input: [] },
  {
    name: 'plain string messages (no tools) unchanged',
    input: [ { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' } ],
  },
  {
    name: 'properly paired tool_use + tool_result unchanged',
    input: [
      { role: 'assistant', content: [txt('let me check'), tu('1')] },
      { role: 'user', content: [tr('1')] },
    ],
  },
  {
    name: 'orphaned tool_use removed, text kept',
    input: [ { role: 'assistant', content: [txt('thinking'), tu('1')] } ],
  },
  {
    name: 'orphaned tool_use leaves empty assistant msg -> drop message',
    input: [ { role: 'assistant', content: [tu('1')] }, { role: 'user', content: 'next' } ],
  },
  {
    name: 'orphaned tool_result removed, text kept',
    input: [ { role: 'user', content: [tr('99'), txt('hey')] } ],
  },
  {
    name: 'orphaned tool_result leaves empty user msg -> drop message',
    input: [ { role: 'assistant', content: 'hi' }, { role: 'user', content: [tr('99')] } ],
  },
  {
    name: 'mixed: 1 valid pair + orphan tool_use + orphan tool_result',
    input: [
      { role: 'assistant', content: [txt('a'), tu('1'), tu('2')] },
      { role: 'user', content: [tr('1'), tr('77')] },
    ],
  },
  {
    name: 'two valid pairs across turns, order preserved',
    input: [
      { role: 'assistant', content: [tu('a')] },
      { role: 'user', content: [tr('a')] },
      { role: 'assistant', content: [txt('more'), tu('b')] },
      { role: 'user', content: [tr('b'), txt('done')] },
    ],
  },
  {
    name: 'do not mutate input (returns equal-but-correct structure)',
    input: [
      { role: 'assistant', content: [tu('x'), tu('keep')] },
      { role: 'user', content: [tr('keep')] },
    ],
  },
];
