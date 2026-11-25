import { describe, it, expect, vi } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import {
  applyExampleRunPolicy,
  exampleRunToolMode,
  exampleStepLabel,
  simulatedToolResult,
  type ExampleRunStep,
} from './exampleRunTools';

describe('exampleRunToolMode', () => {
  it.each([
    // Connector tools: always simulated, reads included.
    ['github__search_issues', 'simulated'],
    ['github__create_issue_comment', 'simulated'],
    ['atlassian__get_page', 'simulated'],
    ['slack__send_message', 'simulated'],
    // Built-in tools with outside side effects.
    ['blog_publish', 'simulated'],
    ['save_content_to_data_lake', 'simulated'],
    ['edit_file', 'simulated'],
    ['excel_generation', 'simulated'],
    ['send_slack_message', 'simulated'],
    ['bash_execute', 'simulated'],
    // The author's private workspace.
    ['search_knowledge_base', 'simulated'],
    ['retrieve_knowledge_content', 'simulated'],
    ['list_my_data_lakes', 'simulated'],
    ['file_read', 'simulated'],
    ['notebook_status', 'simulated'],
    ['skill', 'simulated'],
    // Undeclared.
    ['some_new_tool', 'simulated'],
    // Public, computed or generated: real.
    ['web_search', 'real'],
    ['web_fetch', 'real'],
    ['math_evaluate', 'real'],
    ['current_datetime', 'real'],
    ['deep_research', 'real'],
    ['mermaid_chart', 'real'],
    ['recharts', 'real'],
    ['image_generation', 'real'],
    ['edit_image', 'real'],
    ['video_generation', 'real'],
    ['music_generation', 'real'],
    ['delegate_to_agent', 'real'],
  ])('%s is %s', (name, mode) => {
    expect(exampleRunToolMode(name)).toBe(mode);
  });
});

describe('exampleStepLabel', () => {
  it.each([
    ['github__search_issues', {}, 'Searched issues in example-org/app'],
    ['github__create_issue_comment', {}, 'Created issue comment in example-org/app'],
    ['linear__list_projects', {}, 'Listed projects in linear'],
    ['video_generation', { width: 1080, height: 1920 }, 'Rendered 1080x1920 video'],
    ['image_generation', {}, 'Generated an image'],
    ['web_search', { query: ' solar panels ' }, 'Searched the web for "solar panels"'],
    ['web_fetch', { url: 'https://example.com/a' }, 'Read example.com'],
    ['web_fetch', { url: 'not a url' }, 'Read a web page'],
    ['frobnicate', {}, 'Ran frobnicate'],
  ])('%s -> %s', (name, params, label) => {
    expect(exampleStepLabel(name, params)).toBe(label);
  });

  it('keeps a label within 80 characters', () => {
    expect(exampleStepLabel('web_search', { query: 'x'.repeat(200) }).length).toBe(80);
  });
});

describe('simulatedToolResult', () => {
  it('returns placeholder data only', () => {
    const read = JSON.parse(simulatedToolResult('github__list_issues'));
    expect(read.simulated).toBe(true);
    expect(read.result.items[0]).toMatchObject({ repository: 'example-org/app', owner: 'example-user' });
    const write = JSON.parse(simulatedToolResult('github__create_issue'));
    expect(write.result).toMatchObject({ status: 'ok', repository: 'example-org/app' });
  });
});

describe('applyExampleRunPolicy', () => {
  const tool = (name: string): ICompletionOptionTools => ({
    toolFn: vi.fn(async () => `real ${name}`),
    toolSchema: { name, description: name, parameters: { type: 'object', properties: {} } },
  });

  it('runs real tools, simulates the rest and records a step for each call', async () => {
    const steps: ExampleRunStep[] = [];
    const real = tool('web_search');
    const connector = tool('github__create_issue');
    const [wrappedReal, wrappedConnector] = applyExampleRunPolicy([real, connector], { onStep: s => steps.push(s) });

    expect(await wrappedReal.toolFn({ query: 'q' })).toBe('real web_search');
    expect(JSON.parse(await wrappedConnector.toolFn({}))).toMatchObject({ simulated: true });
    expect(connector.toolFn).not.toHaveBeenCalled();
    expect(steps).toEqual([
      { label: 'Searched the web for "q"', simulated: false },
      { label: 'Created issue in example-org/app', simulated: true },
    ]);
  });
});
