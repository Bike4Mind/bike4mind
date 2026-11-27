import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A run budget is raised only by the user's Raise-and-resume action: RunBudgetRaiseRow ->
 * preload `raiseRunBudget` -> the chatRaiseRunBudget IPC handler -> ChatService.raiseRunBudget ->
 * the HTTP raise in completionRuns.ts. These read the source, so a new caller of any link
 * (a model tool, a skill, a worker wake, another IPC channel) fails here before it can ship.
 */

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const FILES = sourceFiles(SRC).map(path => ({
  path: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

const filesMatching = (pattern: RegExp) => FILES.filter(file => pattern.test(file.text)).map(file => file.path);

const read = (path: string) => {
  const file = FILES.find(candidate => candidate.path === path);
  if (!file) throw new Error(`missing ${path}`);
  return file.text;
};

/** The body of `async name(` in a class, up to the next member at the same indent. */
function methodBody(text: string, name: string): string {
  const start = text.indexOf(`\n  async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = text.slice(start + 1).search(/\n {2}(?:[a-z]|\/\*\*)/);
  return text.slice(start, next === -1 ? undefined : start + 1 + next);
}

describe('the run budget raise path', () => {
  it('builds the budget route only inside the HTTP raise in completionRuns.ts', () => {
    const runApiCallers = FILES.filter(file => /completion-runs|COMPLETION_RUNS_PATH/.test(file.text));
    expect(runApiCallers.map(file => file.path).sort()).toEqual(
      ['main/chat/completionRuns.ts', 'main/chat/evaluationBudget.ts', 'shared/orchestration.ts'].sort()
    );
    for (const file of runApiCallers.filter(caller => caller.path !== 'main/chat/completionRuns.ts')) {
      expect(file.text, file.path).not.toMatch(/\/budget\b|['"`]budget['"`]/);
    }

    const client = read('main/chat/completionRuns.ts');
    expect(client.match(/['"`]budget['"`]/g)).toHaveLength(1);
    const raise = client.slice(client.indexOf('export async function raiseRunBudget('));
    expect(raise).toMatch(/runPath\(serverRunId, 'budget', undefined\)/);
  });

  it('is reachable only from the renderer action, the preload bridge, its IPC handler and ChatService', () => {
    expect(filesMatching(/\braiseRunBudget\b/).sort()).toEqual(
      [
        'main/chat/ChatService.ts',
        'main/chat/completionRuns.ts',
        'main/chat/sessionOrchestrateIpc.ts',
        'preload/index.ts',
        'renderer/src/chat/orchestrator/RunBudgetRaiseRow.tsx',
        'shared/ipc.ts',
      ].sort()
    );
    expect(filesMatching(/\bchatRaiseRunBudget\b/).sort()).toEqual(
      ['main/chat/sessionOrchestrateIpc.ts', 'preload/index.ts', 'shared/ipc.ts'].sort()
    );
  });

  it('offers no model tool, skill or worker a way in', () => {
    const toolFiles = FILES.filter(file => file.path.startsWith('main/chat/tools/'));
    expect(toolFiles.length).toBeGreaterThan(0);
    for (const file of toolFiles) {
      expect(file.text, file.path).not.toMatch(/raiseRunBudget|setRunBudget|budgetCredits|budgetPaused/);
    }
  });

  it('calls the HTTP raise only from ChatService.raiseRunBudget, which nothing in main calls itself', () => {
    const service = read('main/chat/ChatService.ts');
    const body = methodBody(service, 'raiseRunBudget');

    expect(body.match(/\bawait raiseRunBudget\(/g)).toHaveLength(1);
    expect(service.match(/\bawait raiseRunBudget\(/g)).toHaveLength(1);
    expect(service).not.toMatch(/\.raiseRunBudget\(/);
    // The only other main-process caller is the IPC handler for the renderer's action.
    const mainCallers = FILES.filter(file => file.path.startsWith('main/') && /\.raiseRunBudget\(/.test(file.text)).map(
      file => file.path
    );
    expect(mainCallers).toEqual(['main/chat/sessionOrchestrateIpc.ts']);
  });

  it('lifts a budget pause only where the budget is raised', () => {
    const service = read('main/chat/ChatService.ts');
    const lifts = [...service.matchAll(/budgetPaused: undefined/g)];
    expect(lifts).toHaveLength(1);
    expect(methodBody(service, 'raiseRunBudget')).toContain('budgetPaused: undefined');
  });

  // A run with no server run has only this local budget, so a second writer would raise it unchecked.
  it('writes a new local budget only where the budget is raised', () => {
    expect(filesMatching(/\.setRunBudget\(/)).toEqual(['main/chat/ChatService.ts']);
    const service = read('main/chat/ChatService.ts');
    const budgetWrites = [...service.matchAll(/\.setRunBudget\(([^;]*?)\);/g)].filter(([, args]) =>
      /\bbudgetCredits\b/.test(args)
    );
    expect(budgetWrites).toHaveLength(1);
    expect(methodBody(service, 'raiseRunBudget')).toContain(budgetWrites[0][0]);
  });

  it('exposes the raise to the renderer only through its own Raise-and-resume row', () => {
    const renderer = FILES.filter(
      file => file.path.startsWith('renderer/') && /\.raiseRunBudget\(/.test(file.text)
    ).map(file => file.path);
    expect(renderer).toEqual(['renderer/src/chat/orchestrator/RunBudgetRaiseRow.tsx']);
    expect(read('preload/index.ts')).toMatch(
      /raiseRunBudget: \(sessionId: string, budgetCredits: number\) =>\s*ipcRenderer\.invoke\(IPC_CHANNELS\.chatRaiseRunBudget, sessionId, budgetCredits\)/
    );
  });
});
