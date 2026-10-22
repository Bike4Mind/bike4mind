import { describe, expect, it } from 'vitest';
import { parseArtifactsWithFallback } from './artifactParser';
import { groupReactArtifacts } from './reactArtifactGroup';

interface TestArtifact {
  type: string;
  identifier?: string;
  title: string;
  content: string;
  startIndex: number;
}

let position = 0;
function artifact(identifier: string | undefined, content: string, type = 'react'): TestArtifact {
  position += 100;
  return { type, identifier, title: `${identifier ?? 'untitled'} title`, content, startIndex: position };
}

const component = (name: string, imports: string[] = []) =>
  [...imports, `export default function ${name}() { return <div>${name}</div>; }`].join('\n');

describe('groupReactArtifacts', () => {
  it('groups an entry with the sibling it imports, from real parser output in reverse document order', () => {
    const reply = [
      'Here is the app.',
      '<artifact identifier="app" type="application/vnd.ant.react" title="Chrono App">',
      "import React from 'react';",
      "import Chronosphere from './Chronosphere';",
      'export default function App() { return <Chronosphere />; }',
      '</artifact>',
      'And the component:',
      '<artifact identifier="chronosphere" type="application/vnd.ant.react" title="Chronosphere">',
      "import { motion } from 'framer-motion';",
      'export default function Chronosphere() { return <motion.div />; }',
      '</artifact>',
    ].join('\n');
    const { artifacts } = parseArtifactsWithFallback(reply);
    expect(artifacts.map(a => a.identifier)).toEqual(['chronosphere', 'app']);

    const roles = groupReactArtifacts(artifacts);
    const [chronosphere, app] = artifacts;
    expect(roles.get(app)).toEqual({
      role: 'entry',
      files: { chronosphere: chronosphere.content },
      dependencies: ['react', 'framer-motion'],
    });
    expect(roles.get(chronosphere)).toEqual({ role: 'sibling', entryTitle: 'Chrono App' });
  });

  it('matches specifiers to identifiers by basename, ignoring directories, extension and case', () => {
    const app = artifact('App', component('App', ["import Panel from '../components/ui/Panel.tsx';"]));
    const panel = artifact('panel', component('Panel'));
    const roles = groupReactArtifacts([panel, app]);
    expect(roles.get(app)).toMatchObject({ role: 'entry', files: { panel: panel.content } });
    expect(roles.get(panel)).toEqual({ role: 'sibling', entryTitle: 'App title' });
  });

  it('lets the last occurrence of a repeated identifier win, whatever the array order', () => {
    const app = artifact('app', component('App', ["import Widget from './Widget';"]));
    const draft = artifact('widget', component('Draft'));
    const revised = artifact('widget', component('Revised'));

    for (const input of [
      [app, draft, revised],
      [revised, draft, app],
    ]) {
      const roles = groupReactArtifacts(input);
      expect(roles.get(app)).toMatchObject({ role: 'entry', files: { widget: revised.content } });
      expect(roles.get(revised)).toEqual({ role: 'sibling', entryTitle: 'app title' });
      expect(roles.has(draft)).toBe(false);
    }
  });

  it('marks transitively imported artifacts as siblings of the entry', () => {
    const app = artifact('App', component('App', ["import Panel from './Panel';"]));
    const panel = artifact('Panel', component('Panel', ["import Button from './Button';"]));
    const button = artifact('Button', component('Button', ["const icons = require('./Icons');"]));
    const icons = artifact('Icons', 'export const star = 1;');
    const roles = groupReactArtifacts([icons, button, panel, app]);

    expect(roles.get(app)).toMatchObject({
      role: 'entry',
      files: { Panel: panel.content, Button: button.content, Icons: icons.content },
    });
    for (const sibling of [panel, button, icons]) {
      expect(roles.get(sibling)).toEqual({ role: 'sibling', entryTitle: 'App title' });
    }
  });

  it('terminates on a cycle between siblings', () => {
    const app = artifact('App', component('App', ["import A from './A';"]));
    const a = artifact('A', component('A', ["import B from './B';"]));
    const b = artifact('B', component('B', ["export { helper } from './A';"]));
    const roles = groupReactArtifacts([app, a, b]);

    expect(roles.get(app)).toMatchObject({ role: 'entry' });
    expect(roles.get(a)).toEqual({ role: 'sibling', entryTitle: 'App title' });
    expect(roles.get(b)).toEqual({ role: 'sibling', entryTitle: 'App title' });
  });

  it('finds no entry when every importer is itself imported', () => {
    const a = artifact('A', component('A', ["import B from './B';"]));
    const b = artifact('B', component('B', ["import A from './A';"]));
    expect(groupReactArtifacts([a, b]).size).toBe(0);
  });

  it('groups two independent entries in one reply, each labelling its own siblings', () => {
    const first = artifact('First', component('First', ["import One from './One';"]));
    const one = artifact('One', component('One'));
    const second = artifact('Second', component('Second', ["import Two from './Two';"]));
    const two = artifact('Two', component('Two'));
    const roles = groupReactArtifacts([two, second, one, first]);

    expect(roles.get(first)).toEqual({
      role: 'entry',
      files: { One: one.content, Second: second.content, Two: two.content },
      dependencies: [],
    });
    expect(roles.get(second)).toMatchObject({
      role: 'entry',
      files: { First: first.content, One: one.content, Two: two.content },
    });
    expect(roles.get(one)).toEqual({ role: 'sibling', entryTitle: 'First title' });
    expect(roles.get(two)).toEqual({ role: 'sibling', entryTitle: 'Second title' });
  });

  it('labels a sibling shared by two entries with the first entry in the reply', () => {
    const first = artifact('First', component('First', ["import Shared from './Shared';"]));
    const second = artifact('Second', component('Second', ["import Shared from './Shared';"]));
    const shared = artifact('Shared', component('Shared'));
    const roles = groupReactArtifacts([shared, second, first]);
    expect(roles.get(shared)).toEqual({ role: 'sibling', entryTitle: 'First title' });
  });

  it('still makes an entry when one import is missing, handing over the files that exist', () => {
    const app = artifact('App', component('App', ["import Here from './Here';", "import Gone from './Gone';"]));
    const here = artifact('Here', component('Here'));
    const roles = groupReactArtifacts([app, here]);
    expect(roles.get(app)).toMatchObject({ role: 'entry', files: { Here: here.content } });
    expect(roles.get(here)).toEqual({ role: 'sibling', entryTitle: 'App title' });
  });

  it('leaves an artifact whose imports match nothing standalone', () => {
    const app = artifact('App', component('App', ["import Gone from './Gone';"]));
    const other = artifact('Other', component('Other'));
    expect(groupReactArtifacts([app, other]).size).toBe(0);
  });

  it('lets an artifact without an identifier be an entry but never a sibling or a file', () => {
    const nameless = artifact(undefined, component('Nameless', ["import Panel from './Panel';"]));
    const panel = artifact('Panel', component('Panel', ["import Untitled from './untitled';"]));
    const unnamed = artifact(undefined, component('Untitled'));
    const roles = groupReactArtifacts([nameless, panel, unnamed]);

    expect(roles.get(nameless)).toEqual({ role: 'entry', files: { Panel: panel.content }, dependencies: [] });
    expect(roles.get(panel)).toEqual({ role: 'sibling', entryTitle: 'untitled title' });
    expect(roles.has(unnamed)).toBe(false);
  });

  it('ignores non-React artifacts, as import targets and as files', () => {
    const app = artifact('App', component('App', ["import Chart from './Chart';", "import Panel from './Panel';"]));
    const chart = artifact('Chart', '<svg></svg>', 'svg');
    const panel = artifact('Panel', component('Panel'));
    const notes = artifact('Notes', '<html></html>', 'html');
    const roles = groupReactArtifacts([app, chart, panel, notes]);

    expect(roles.get(app)).toMatchObject({ role: 'entry', files: { Panel: panel.content } });
    expect(roles.has(chart)).toBe(false);
    expect(roles.has(notes)).toBe(false);
  });

  it('does not group on a type-only relative import, which the sandbox strips', () => {
    const app = artifact('App', component('App', ["import type { Props } from './Types';"]));
    const types = artifact('Types', 'export type Props = { a: string };');
    expect(groupReactArtifacts([app, types]).size).toBe(0);
  });

  it('unions the npm imports of the entry and every file', () => {
    const app = artifact(
      'App',
      component('App', ["import { LineChart } from 'recharts';", "import Panel from './Panel';"])
    );
    const panel = artifact('Panel', component('Panel', ["import _ from 'lodash';", "import { sum } from 'recharts';"]));
    const loose = artifact('Loose', component('Loose', ["import * as d3 from 'd3';"]));
    expect(groupReactArtifacts([app, panel, loose]).get(app)).toMatchObject({
      dependencies: ['recharts', 'lodash', 'd3'],
    });
  });

  it('leaves a lone React artifact standalone', () => {
    const app = artifact('App', component('App', ["import Panel from './Panel';"]));
    expect(groupReactArtifacts([app]).size).toBe(0);
  });
});
