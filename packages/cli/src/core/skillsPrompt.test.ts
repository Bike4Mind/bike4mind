import { describe, it, expect } from 'vitest';
import { buildSkillsPromptSection, filterSkillsByAllowedList } from './skillsPrompt.js';
import type { CustomCommand } from '../storage/types.js';

describe('buildSkillsPromptSection', () => {
  it('should return empty string when no commands are provided', () => {
    const result = buildSkillsPromptSection([]);
    expect(result).toBe('');
  });

  it('should include section header when commands exist', () => {
    const commands: CustomCommand[] = [
      {
        name: 'test',
        description: 'Test command',
        body: 'test body',
        source: 'global',
        filePath: '/path/to/test.md',
      },
    ];

    const result = buildSkillsPromptSection(commands);
    expect(result).toContain('## Available Skills');
  });

  it('should include usage instructions', () => {
    const commands: CustomCommand[] = [
      {
        name: 'test',
        description: 'Test command',
        body: 'test body',
        source: 'global',
        filePath: '/path/to/test.md',
      },
    ];

    const result = buildSkillsPromptSection(commands);
    expect(result).toContain('skill({ skill: "commit" })');
    expect(result).toContain('ALWAYS use the `skill` tool to invoke it');
  });

  it('should format global commands correctly', () => {
    const commands: CustomCommand[] = [
      {
        name: 'commit',
        description: 'Create a git commit',
        body: 'commit body',
        source: 'global',
        filePath: '/home/.bike4mind/commands/commit.md',
      },
    ];

    const result = buildSkillsPromptSection(commands);
    expect(result).toContain('### Global Skills');
    expect(result).toContain('- **commit**: Create a git commit');
  });

  it('should format project commands correctly', () => {
    const commands: CustomCommand[] = [
      {
        name: 'deploy',
        description: 'Deploy to production',
        body: 'deploy body',
        source: 'project',
        filePath: '/project/.bike4mind/commands/deploy.md',
      },
    ];

    const result = buildSkillsPromptSection(commands);
    expect(result).toContain('### Project Skills');
    expect(result).toContain('- **deploy**: Deploy to production');
  });

  it('should show project skills before global skills', () => {
    const commands: CustomCommand[] = [
      {
        name: 'global-cmd',
        description: 'Global command',
        body: 'body',
        source: 'global',
        filePath: '/home/.bike4mind/commands/global-cmd.md',
      },
      {
        name: 'project-cmd',
        description: 'Project command',
        body: 'body',
        source: 'project',
        filePath: '/project/.bike4mind/commands/project-cmd.md',
      },
    ];

    const result = buildSkillsPromptSection(commands);
    const projectIndex = result.indexOf('### Project Skills');
    const globalIndex = result.indexOf('### Global Skills');

    expect(projectIndex).toBeLessThan(globalIndex);
  });

  it('should include argument hints when provided', () => {
    const commands: CustomCommand[] = [
      {
        name: 'review-pr',
        description: 'Review a pull request',
        argumentHint: '<pr-number>',
        body: 'review body',
        source: 'project',
        filePath: '/project/.bike4mind/commands/review-pr.md',
      },
    ];

    const result = buildSkillsPromptSection(commands);
    expect(result).toContain('- **review-pr** <pr-number>: Review a pull request');
  });

  it('should not include argument hint space when no hint provided', () => {
    const commands: CustomCommand[] = [
      {
        name: 'simple',
        description: 'Simple command',
        body: 'simple body',
        source: 'global',
        filePath: '/home/.bike4mind/commands/simple.md',
      },
    ];

    const result = buildSkillsPromptSection(commands);
    expect(result).toContain('- **simple**: Simple command');
    // Should not have extra space before colon
    expect(result).not.toContain('- **simple** : Simple command');
  });

  it('should handle multiple commands in each category', () => {
    const commands: CustomCommand[] = [
      {
        name: 'global1',
        description: 'Global 1',
        body: 'body',
        source: 'global',
        filePath: '/path/global1.md',
      },
      {
        name: 'global2',
        description: 'Global 2',
        body: 'body',
        source: 'global',
        filePath: '/path/global2.md',
      },
      {
        name: 'project1',
        description: 'Project 1',
        body: 'body',
        source: 'project',
        filePath: '/path/project1.md',
      },
      {
        name: 'project2',
        description: 'Project 2',
        argumentHint: '[args]',
        body: 'body',
        source: 'project',
        filePath: '/path/project2.md',
      },
    ];

    const result = buildSkillsPromptSection(commands);

    expect(result).toContain('- **global1**: Global 1');
    expect(result).toContain('- **global2**: Global 2');
    expect(result).toContain('- **project1**: Project 1');
    expect(result).toContain('- **project2** [args]: Project 2');
  });

  it('should only show Global Skills section if no project commands', () => {
    const commands: CustomCommand[] = [
      {
        name: 'global-only',
        description: 'Global only',
        body: 'body',
        source: 'global',
        filePath: '/path/global.md',
      },
    ];

    const result = buildSkillsPromptSection(commands);

    expect(result).toContain('### Global Skills');
    expect(result).not.toContain('### Project Skills');
  });

  it('should only show Project Skills section if no global commands', () => {
    const commands: CustomCommand[] = [
      {
        name: 'project-only',
        description: 'Project only',
        body: 'body',
        source: 'project',
        filePath: '/path/project.md',
      },
    ];

    const result = buildSkillsPromptSection(commands);

    expect(result).toContain('### Project Skills');
    expect(result).not.toContain('### Global Skills');
  });

  describe('with allowedSkills parameter', () => {
    const allCommands: CustomCommand[] = [
      {
        name: 'commit',
        description: 'Create a commit',
        body: 'body',
        source: 'global',
        filePath: '/path/commit.md',
      },
      {
        name: 'review-pr',
        description: 'Review a PR',
        body: 'body',
        source: 'project',
        filePath: '/path/review-pr.md',
      },
      {
        name: 'deploy',
        description: 'Deploy to production',
        body: 'body',
        source: 'project',
        filePath: '/path/deploy.md',
      },
    ];

    it('should return all skills when allowedSkills is undefined', () => {
      const result = buildSkillsPromptSection(allCommands, undefined);

      expect(result).toContain('**commit**');
      expect(result).toContain('**review-pr**');
      expect(result).toContain('**deploy**');
    });

    it('should return all skills when allowedSkills is empty array', () => {
      const result = buildSkillsPromptSection(allCommands, []);

      expect(result).toContain('**commit**');
      expect(result).toContain('**review-pr**');
      expect(result).toContain('**deploy**');
    });

    it('should filter to only allowed skills when allowedSkills is specified', () => {
      const result = buildSkillsPromptSection(allCommands, ['commit', 'deploy']);

      expect(result).toContain('**commit**');
      expect(result).toContain('**deploy**');
      expect(result).not.toContain('**review-pr**');
    });

    it('should return empty string when no allowed skills match', () => {
      const result = buildSkillsPromptSection(allCommands, ['nonexistent']);

      expect(result).toBe('');
    });

    it('should handle single allowed skill', () => {
      const result = buildSkillsPromptSection(allCommands, ['review-pr']);

      expect(result).toContain('**review-pr**');
      expect(result).not.toContain('**commit**');
      expect(result).not.toContain('**deploy**');
    });
  });
});

describe('filterSkillsByAllowedList', () => {
  const allCommands: CustomCommand[] = [
    {
      name: 'skill-a',
      description: 'Skill A',
      body: 'body',
      source: 'global',
      filePath: '/path/a.md',
    },
    {
      name: 'skill-b',
      description: 'Skill B',
      body: 'body',
      source: 'project',
      filePath: '/path/b.md',
    },
    {
      name: 'skill-c',
      description: 'Skill C',
      body: 'body',
      source: 'global',
      filePath: '/path/c.md',
    },
  ];

  it('should return all commands when allowedSkills is undefined', () => {
    const result = filterSkillsByAllowedList(allCommands, undefined);

    expect(result).toHaveLength(3);
    expect(result.map(c => c.name)).toEqual(['skill-a', 'skill-b', 'skill-c']);
  });

  it('should return all commands when allowedSkills is empty array', () => {
    const result = filterSkillsByAllowedList(allCommands, []);

    expect(result).toHaveLength(3);
  });

  it('should filter to only allowed skills', () => {
    const result = filterSkillsByAllowedList(allCommands, ['skill-a', 'skill-c']);

    expect(result).toHaveLength(2);
    expect(result.map(c => c.name)).toEqual(['skill-a', 'skill-c']);
  });

  it('should return empty array when no skills match', () => {
    const result = filterSkillsByAllowedList(allCommands, ['nonexistent']);

    expect(result).toHaveLength(0);
  });

  it('should handle single allowed skill', () => {
    const result = filterSkillsByAllowedList(allCommands, ['skill-b']);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('skill-b');
  });

  it('should ignore allowed skills that do not exist', () => {
    const result = filterSkillsByAllowedList(allCommands, ['skill-a', 'nonexistent', 'skill-c']);

    expect(result).toHaveLength(2);
    expect(result.map(c => c.name)).toEqual(['skill-a', 'skill-c']);
  });

  it('should handle empty commands array', () => {
    const result = filterSkillsByAllowedList([], ['skill-a']);

    expect(result).toHaveLength(0);
  });
});
