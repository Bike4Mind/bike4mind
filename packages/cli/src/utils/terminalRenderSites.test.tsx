/**
 * Guard for sanitizeTerminalText.ts: untrusted text must reach the terminal
 * through that one module. The render tests feed hostile bytes through the
 * main chokepoints; the source check fails if a known sink drops the import.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { readFileSync } from 'fs';
import path from 'path';
import { render } from 'ink-testing-library';
import { MessageItem } from '../components/MessageItem';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { formatHandoffOutput, renderLocalHandoffMarkdown } from './handoff';
import { createMockMessage, createMockSession } from '../test-utils/mocks';

const ESC = '\x1b';
const HOSTILE = `safe${ESC}]52;c;cm0gLXJmIH4=\x07${ESC}]0;title\x07${ESC}[2K\rspoof\u202Etxt.exe\x00`;
const CLEAN = 'safespooftxt.exe';

// Ink adds SGR styling of its own once chalk detects colour; drop only that so
// the assertion is about what the untrusted text smuggled in.
// eslint-disable-next-line no-control-regex
const stripSgr = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

function expectClean(output: string | undefined) {
  const text = stripSgr(output ?? '');
  expect(text).not.toMatch(CONTROL);
  expect(text).not.toContain('52;c;');
}

describe('untrusted text render sites', () => {
  it('MessageItem sanitizes the reply, thoughts, tool name, args and result', () => {
    const message = createMockMessage({
      role: 'assistant',
      content: HOSTILE,
      metadata: {
        steps: [
          { type: 'thought', content: HOSTILE, metadata: { timestamp: Date.now() } },
          {
            type: 'action',
            content: 'run',
            metadata: { toolName: `x${ESC}[2J`, toolInput: HOSTILE, timestamp: Date.now() },
          },
          { type: 'observation', content: HOSTILE, metadata: { timestamp: Date.now() } },
        ],
      },
    });
    const { lastFrame } = render(<MessageItem message={message} />);
    expectClean(lastFrame());
    expect(lastFrame()).toContain(CLEAN);
  });

  it('MessageItem sanitizes the live streaming frame', () => {
    const message = createMockMessage({ role: 'assistant', content: HOSTILE });
    const { lastFrame } = render(<MessageItem message={message} liveRows={20} />);
    expectClean(lastFrame());
  });

  it('MessageItem leaves the stored message untouched', () => {
    const message = createMockMessage({ role: 'assistant', content: HOSTILE });
    render(<MessageItem message={message} />);
    expect(message.content).toBe(HOSTILE);
  });

  it('MarkdownRenderer sanitizes prose and code blocks before styling', () => {
    const { lastFrame } = render(
      <MarkdownRenderer content={`# ${HOSTILE}\n\n${HOSTILE}\n\n\`\`\`sh\n${HOSTILE}\n\`\`\``} />
    );
    expectClean(lastFrame());
  });

  it('handoff output and the markdown artifact carry no terminal escapes', () => {
    const handoff = {
      summary: HOSTILE,
      keyFindings: [HOSTILE],
      nextSteps: [HOSTILE],
      pendingDecisions: [],
      blockers: [HOSTILE],
      generatedAt: new Date().toISOString(),
    };
    expectClean(formatHandoffOutput(handoff));

    const session = createMockSession();
    session.metadata.workflow = {
      decisions: [
        { id: 'd1', summary: HOSTILE, rationale: HOSTILE, context: HOSTILE, alternatives: [HOSTILE], timestamp: 't' },
      ],
      blockers: [{ id: 'b1', description: HOSTILE, status: 'open', createdAt: 't' }],
      handoff,
    } as unknown as NonNullable<typeof session.metadata.workflow>;
    expectClean(renderLocalHandoffMarkdown(session));
  });

  // Sinks with no render harness (console output, pickers) are held by source:
  // each listed expression must appear wrapped in a sanitizer call, so dropping
  // the wrap at that site fails here even while the import stays. Add a row
  // when you add a sink.
  const SANITIZED_SITES: Record<string, string[]> = {
    'components/liveStepWindow.ts': ['sanitizeTerminalText(raw.length > window'],
    'components/MarkdownRenderer.tsx': ['marked.lexer(sanitizeTerminalText(content))'],
    'components/PermissionPrompt.tsx': [
      'escapeTerminalControlChars(preview)',
      'escapeTerminalControlChars(toolName)',
      'escapeTerminalControlChars(argsString)',
    ],
    'components/FolderTrustPrompt.tsx': ['escapeTerminalControlChars(projectRoot)'],
    'components/McpApprovalPrompt.tsx': ['escapeTerminalControlChars(s)'],
    'components/UserQuestionPrompt.tsx': [
      'escapeTerminalControlChars(currentQuestion.question, { keepBidiMarks: true })',
    ],
    'components/ReviewGatePrompt.tsx': ['escapeTerminalControlChars(description, { keepBidiMarks: true })'],
    'components/McpViewer.tsx': ['sanitizeTerminalText(server.name)', 'sanitizeTerminalText(Object.keys(server.env)'],
    'components/SessionSelector.tsx': [
      'sanitizeTerminalText(lastUserMessage.content)',
      "sanitizeTerminalText(selectedSession?.name ?? '')",
    ],
    'components/RewindSelector.tsx': [
      'sanitizeTerminalText(msg.content)',
      'sanitizeTerminalText(selectedMessage.content)',
    ],
    'components/BackgroundAgentStatus.tsx': ['sanitizeTerminalText(job.task)', 'sanitizeTerminalText(job.agentName)'],
    'components/BackgroundShellStatus.tsx': ['sanitizeTerminalText(rawCommand)'],
    'components/FileAutocomplete.tsx': ['sanitizeTerminalText(file.isDirectory'],
    'components/CompletedGroupNotification.tsx': ['sanitizeTerminalText(item.groupDescription)'],
    'components/CommandAutocomplete.tsx': [
      'sanitizeTerminalText(cmd.name)',
      'sanitizeTerminalText(args)',
      'sanitizeTerminalText(cmd.description)',
    ],
    'commands/handlers/workflowViews.ts': [
      'sanitizeTerminalText(formatDecisionsOutput(',
      'sanitizeTerminalText(formatBlockersOutput(',
      'sanitizeTerminalText(formatReviewGatesOutput(',
    ],
    'commands/headlessCommand.ts': ['sanitizeTerminalText(result.finalAnswer)', 'sanitizeTerminalText(message)'],
    'commands/pluginCommand.ts': ['sanitizeTerminalText(descriptor.reason)'],
    'agents/hookExecutor.ts': ['sanitizeTerminalText(result.stderr)', 'sanitizeTerminalText(result.stderr.trim())'],
    'session/turnController.ts': ['sanitizeTerminalText(rawMessage)'],
    'session/lifecycle.ts': ['sanitizeTerminalText(selected.name)', 'sanitizeTerminalText(sessionForState.name)'],
    'bootstrap/buildSandbox.ts': ['sanitizeTerminalText(event.domain)'],
    'bootstrap/startupTrustGates.ts': ['escapeTerminalControlChars(projectRoot)'],
    'tools/gateway/stages/sandbox.ts': ['sanitizeTerminalText(reason)'],
    'utils/handoff.ts': ['sanitizeTerminalText(formatHandoff(handoff', "sanitizeTerminalText(lines.join('\\n'))"],
    'index.tsx': [
      'sanitizeTerminalText(agent.description)',
      'sanitizeTerminalText(skippedPlugin.reason)',
      'sanitizeTerminalText(v.detail)',
      'sanitizeTerminalText(projectConfig.mcpServers',
      'sanitizeTerminalText(projectConfig.defaultModel)',
      "sanitizeTerminalText(projectConfig.tools.denied.join(', '))",
      "sanitizeTerminalText(localConfig.trustedTools.join(', '))",
      'sanitizeTerminalText(cmd.argumentHint)',
      'sanitizeTerminalText(cmd.name)',
      'sanitizeTerminalText(cmd.description)',
    ],
  };

  it.each(Object.entries(SANITIZED_SITES))(
    '%s routes untrusted text through sanitizeTerminalText.ts',
    (relativePath, calls) => {
      const source = readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
      expect(source).toMatch(/from '(?:\.{1,2}\/)+(?:utils\/)?sanitizeTerminalText(?:\.js)?'/);
      for (const call of calls) expect(source, call).toContain(call);
    }
  );
});
