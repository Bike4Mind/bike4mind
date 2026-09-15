import { describe, it, expect } from 'vitest';
import { buildCoreSystemPrompt, buildMinimalSystemPrompt, buildSystemPrompt } from './prompts.js';

describe('buildCoreSystemPrompt', () => {
  describe('dynamic agent creation section', () => {
    it('does not include dynamic agent section when flag is undefined', () => {
      const prompt = buildCoreSystemPrompt({});

      expect(prompt).not.toContain('DYNAMIC AGENT CREATION');
      expect(prompt).not.toContain('create_dynamic_agent');
    });

    it('does not include dynamic agent section when flag is false', () => {
      const prompt = buildCoreSystemPrompt({
        enableDynamicAgentCreation: false,
      });

      expect(prompt).not.toContain('DYNAMIC AGENT CREATION');
      expect(prompt).not.toContain('create_dynamic_agent');
    });

    it('includes dynamic agent section when flag is true', () => {
      const prompt = buildCoreSystemPrompt({
        enableDynamicAgentCreation: true,
      });

      expect(prompt).toContain('DYNAMIC AGENT CREATION');
      expect(prompt).toContain('create_dynamic_agent');
    });

    it('includes usage instructions in dynamic agent section', () => {
      const prompt = buildCoreSystemPrompt({
        enableDynamicAgentCreation: true,
      });

      expect(prompt).toContain('systemPrompt');
      expect(prompt).toContain('allowedTools');
      expect(prompt).toContain('run_in_background');
    });

    it('includes examples in dynamic agent section', () => {
      const prompt = buildCoreSystemPrompt({
        enableDynamicAgentCreation: true,
      });

      expect(prompt).toContain('security-auditor');
      expect(prompt).toContain('test-gap-analyzer');
      expect(prompt).toContain('refactor-planner');
      expect(prompt).toContain('pr-writer');
    });

    it('mentions anti-recursion constraint', () => {
      const prompt = buildCoreSystemPrompt({
        enableDynamicAgentCreation: true,
      });

      expect(prompt).toContain('cannot spawn other agents');
    });
  });

  describe('core prompt structure', () => {
    it('always includes core behavior section', () => {
      const prompt = buildCoreSystemPrompt({});

      expect(prompt).toContain('CORE BEHAVIOR');
      expect(prompt).toContain('SUBAGENT DELEGATION');
    });

    it('includes project context when provided', () => {
      const prompt = buildCoreSystemPrompt({
        contextContent: '## My Project\nUse TypeScript everywhere.',
      });

      expect(prompt).toContain('My Project');
      expect(prompt).toContain('Use TypeScript everywhere');
    });
  });
});

describe('buildMinimalSystemPrompt', () => {
  it('omits the heavy behavioral scaffolding from the current prompt', () => {
    const prompt = buildMinimalSystemPrompt();
    expect(prompt).not.toContain('CORE BEHAVIOR');
    expect(prompt).not.toContain('FOR SOFTWARE ENGINEERING TASKS');
    expect(prompt).not.toContain('CODE SEARCH BEST PRACTICES');
    expect(prompt).not.toContain('SUBAGENT DELEGATION');
    expect(prompt).not.toContain('DURABLE WORKFLOW TRACKING');
  });

  it('is meaningfully shorter than the current prompt', () => {
    const minimal = buildMinimalSystemPrompt();
    const current = buildCoreSystemPrompt();
    // Minimal must be at least 3x smaller. If it grows past that the
    // experiment isn't actually testing a minimal prompt anymore.
    expect(minimal.length * 3).toBeLessThan(current.length);
  });

  it('still includes project context when provided', () => {
    const prompt = buildMinimalSystemPrompt({
      contextContent: '## My Project\nUse TypeScript everywhere.',
    });
    expect(prompt).toContain('My Project');
    expect(prompt).toContain('Use TypeScript everywhere');
  });

  it('still includes additional-directories section when provided', () => {
    const prompt = buildMinimalSystemPrompt({
      additionalDirectories: ['/tmp/foo'],
    });
    expect(prompt).toContain('/tmp/foo');
    expect(prompt).toContain('Additional Allowed Directories');
  });
});

describe('buildSystemPrompt', () => {
  it('returns the current prompt for variant="current"', () => {
    const got = buildSystemPrompt('current');
    expect(got).toContain('CORE BEHAVIOR');
    expect(got).toBe(buildCoreSystemPrompt());
  });

  it('returns the minimal prompt for variant="minimal"', () => {
    const got = buildSystemPrompt('minimal');
    expect(got).not.toContain('CORE BEHAVIOR');
    expect(got).toBe(buildMinimalSystemPrompt());
  });

  it('passes config through to either variant', () => {
    const cfg = { contextContent: '## XYZ-PROJECT' };
    expect(buildSystemPrompt('current', cfg)).toContain('XYZ-PROJECT');
    expect(buildSystemPrompt('minimal', cfg)).toContain('XYZ-PROJECT');
  });

  describe('appendSystemPrompt (claude --append-system-prompt parity)', () => {
    const MARKER = 'HOST-3-LAYER-BRIEF-XYZ';

    it('appends the text at the very end of the current variant', () => {
      const got = buildSystemPrompt('current', { appendSystemPrompt: MARKER });
      expect(got).toContain(MARKER);
      expect(got.trimEnd().endsWith(MARKER)).toBe(true);
    });

    it('appends the text at the very end of the minimal variant', () => {
      const got = buildSystemPrompt('minimal', { appendSystemPrompt: MARKER });
      expect(got).toContain(MARKER);
      expect(got.trimEnd().endsWith(MARKER)).toBe(true);
    });

    it('omits the appended block when not provided', () => {
      expect(buildSystemPrompt('current')).not.toContain(MARKER);
      expect(buildSystemPrompt('minimal')).not.toContain(MARKER);
    });
  });
});
