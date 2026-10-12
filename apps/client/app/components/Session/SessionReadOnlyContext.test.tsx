import React from 'react';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { render, screen } from '@testing-library/react';
import { SessionReadOnlyProvider, useSessionReadOnly } from './SessionReadOnlyContext';

const Probe = () => <span data-testid="read-only-probe">{String(useSessionReadOnly())}</span>;

describe('SessionReadOnlyContext', () => {
  it('defaults to false with no provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('read-only-probe')).toHaveTextContent('false');
  });

  it('reports the provided value', () => {
    render(
      <SessionReadOnlyProvider readOnly>
        <Probe />
      </SessionReadOnlyProvider>
    );
    expect(screen.getByTestId('read-only-probe')).toHaveTextContent('true');
  });
});

// SessionContainer and SessionMiddle need a large web of providers to render, so their wiring
// is pinned at source level (same approach as SessionMiddle.reconnectProbe.test.ts).
describe('read-only wiring', () => {
  const read = (file: string) => readFileSync(resolve(__dirname, file), 'utf8');

  it('SessionContainer renders no composer and no drop zone when read-only', () => {
    const source = read('SessionContainer.tsx');
    const composers = source.match(/<SessionBottom\b/g) ?? [];
    const gatedComposers = source.match(/\{!readOnly && <SessionBottom\b/g) ?? [];
    expect(composers.length).toBeGreaterThan(0);
    expect(gatedComposers).toHaveLength(composers.length);

    expect(source).not.toMatch(/onDrop=\{handleDrop\}/);
    expect(source).toMatch(/const dropZoneHandlers = readOnly\s*\?\s*\{\}/);
    expect(source).toMatch(/\{!readOnly && !!pastedFile &&/);
  });

  it('SessionContainer provides the prop, honoring an enclosing provider', () => {
    expect(read('SessionContainer.tsx')).toMatch(
      /<SessionReadOnlyProvider readOnly=\{inheritedReadOnly \|\| readOnly\}>/
    );
  });

  it('SessionMiddle makes send, delete and pin no-ops when read-only', () => {
    const source = read('SessionMiddle.tsx');
    expect(source).toMatch(/const readOnly = useSessionReadOnly\(\);/);
    expect(source).toMatch(/const onDelete = useStableCallback\(async \([^)]*\) => \{\s*if \(readOnly \|\|/);
    expect(source).toMatch(/const handlePinToggle = useStableCallback\(async \([^)]*\) => \{\s*if \(readOnly \|\|/);
    expect(source).toMatch(
      /const sendMessage = useStableCallback\(\s*async \([\s\S]*?\) => \{\s*const \{[^}]*\} = options;\s*if \(readOnly\) return;/
    );
  });
});
