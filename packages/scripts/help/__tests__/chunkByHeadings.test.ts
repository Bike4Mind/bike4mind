import { describe, it, expect } from 'vitest';
import { chunkByHeadings, estimateTokenCount } from '../utils';

describe('chunkByHeadings', () => {
  it('keeps H3 content grouped under parent H2', () => {
    const md = [
      '## Features',
      'Intro to features.',
      '### Sub-feature A',
      'Details about A.',
      '### Sub-feature B',
      'Details about B.',
    ].join('\n');

    const chunks = chunkByHeadings(md, 'Test Article');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionPath).toBe('Features');
    expect(chunks[0].content).toContain('Sub-feature A');
    expect(chunks[0].content).toContain('Sub-feature B');
  });

  it('merges intro text (before first H2) into first H2 section', () => {
    const md = ['This is the intro paragraph.', '', '## First Section', 'First section content.'].join('\n');

    const chunks = chunkByHeadings(md, 'Test Article');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionPath).toBe('First Section');
    expect(chunks[0].content).toContain('This is the intro paragraph.');
    expect(chunks[0].content).toContain('First section content.');
  });

  it('merges small sections forward into next section', () => {
    const md = [
      '## Tiny Section',
      'Short.',
      '',
      '## Normal Section',
      'This section has plenty of content to be well above the minimum section length threshold that is used for merging small sections into adjacent ones.',
    ].join('\n');

    const chunks = chunkByHeadings(md, 'Test Article');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('Short.');
    expect(chunks[0].content).toContain('Normal Section');
  });

  it('merges last small section backward into previous section', () => {
    const md = [
      '## Normal Section',
      'This section has plenty of content to be well above the minimum section length threshold that is used for merging small sections into adjacent ones.',
      '',
      '## Tiny Last Section',
      'Short.',
    ].join('\n');

    const chunks = chunkByHeadings(md, 'Test Article');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionPath).toBe('Normal Section');
    expect(chunks[0].content).toContain('Tiny Last Section');
    expect(chunks[0].content).toContain('Short.');
  });

  it('splits oversized H2 sections at H3 boundaries', () => {
    const longContent = 'x'.repeat(4000); // >800 tokens at chars/4
    const md = [
      '## Big Section',
      'Intro to big section.',
      '### Part One',
      longContent,
      '### Part Two',
      longContent,
    ].join('\n');

    const chunks = chunkByHeadings(md, 'Test Article');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].sectionPath).toBe('Big Section > Part One');
    expect(chunks[1].sectionPath).toBe('Big Section > Part Two');
  });

  it('keeps H4 content with parent H3 during H3 splitting', () => {
    const longContent = 'y'.repeat(4000);
    const md = [
      '## Big Section',
      'Intro.',
      '### Part One',
      longContent,
      '#### Sub-detail',
      'Sub-detail content.',
      '### Part Two',
      longContent,
    ].join('\n');

    const chunks = chunkByHeadings(md, 'Test Article');
    const partOne = chunks.find(c => c.sectionPath === 'Big Section > Part One');
    expect(partOne).toBeDefined();
    expect(partOne!.content).toContain('Sub-detail');
    expect(partOne!.content).toContain('Sub-detail content.');
  });

  it('uses H2 heading as sectionPath for normal sections', () => {
    const md = [
      '## Overview',
      'This is a comprehensive overview section with enough content to pass the minimum threshold easily. It describes the full scope of the feature and provides context for new users getting started.',
      '',
      '## Getting Started',
      'This section describes how to get started and has sufficient content for it to stand alone as a chunk. Follow these detailed step-by-step instructions to set up your environment properly.',
    ].join('\n');

    const chunks = chunkByHeadings(md, 'Test Article');
    expect(chunks.map(c => c.sectionPath)).toEqual(['Overview', 'Getting Started']);
  });

  it('uses "H2 > H3" sectionPath format for H3-split chunks', () => {
    const longContent = 'z'.repeat(4000);
    const md = ['## Parent', '### Child A', longContent, '### Child B', longContent].join('\n');

    const chunks = chunkByHeadings(md, 'Test Article');
    expect(chunks[0].sectionPath).toBe('Parent > Child A');
    expect(chunks[1].sectionPath).toBe('Parent > Child B');
  });

  it('uses articleTitle as sectionPath when no H2 headings exist', () => {
    const md = 'Just some plain content with no headings at all, but enough length to stand on its own.';
    const chunks = chunkByHeadings(md, 'My Article');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionPath).toBe('My Article');
  });

  it('respects custom minSectionLength option', () => {
    const md = [
      '## Short One',
      'Tiny.',
      '',
      '## Longer One',
      'Has enough content here that it exceeds thresholds.',
    ].join('\n');

    // With low threshold, both survive
    const lowThreshold = chunkByHeadings(md, 'Test', { minSectionLength: 3 });
    expect(lowThreshold).toHaveLength(2);

    // With high threshold, short one merges
    const highThreshold = chunkByHeadings(md, 'Test', { minSectionLength: 200 });
    expect(highThreshold).toHaveLength(1);
  });

  it('respects custom maxSectionTokens option', () => {
    // ~100 tokens each subsection (400 chars)
    const content = 'a'.repeat(400);
    const md = ['## Parent', '### Child A', content, '### Child B', content].join('\n');

    // High limit: stays as one chunk
    const highLimit = chunkByHeadings(md, 'Test', { maxSectionTokens: 5000 });
    expect(highLimit).toHaveLength(1);
    expect(highLimit[0].sectionPath).toBe('Parent');

    // Low limit: splits at H3
    const lowLimit = chunkByHeadings(md, 'Test', { maxSectionTokens: 50 });
    expect(lowLimit.length).toBeGreaterThan(1);
  });

  describe('real-world regression: projects.md "Collaboration & Members"', () => {
    // Modeled after apps/client/public/help-content/features/projects.md structure
    const projectsMd = [
      '# Projects - Organize Your Work',
      '',
      'Projects help you group related notebooks, knowledge files, and team members together.',
      '',
      '## Overview',
      '',
      'A project contains:',
      '- **Notebooks** - Related conversation sessions',
      '- **Files** - Knowledge documents for reference',
      '- **Members** - Team collaborators',
      '- **System Prompts** - Project-wide AI context',
      '',
      '## Creating a Project',
      '',
      '1. Navigate to **Projects** from the sidebar',
      '2. Click **Create Project**',
      '3. Enter a name and description',
      '4. Optionally add initial notebooks or files',
      '5. Click **Create**',
      '',
      '### Project Settings',
      '',
      '| Field | Limit | Description |',
      '|-------|-------|-------------|',
      '| Name | 50 characters | Unique name for the project |',
      '| Description | 500 characters | What the project is about |',
      '',
      '## Managing Notebooks in Projects',
      '',
      '### Adding Notebooks',
      '',
      '**From the Project:**',
      '1. Open your project',
      '2. Go to the **Sessions** tab',
      '3. Click **Add Sessions**',
      '4. Search and select notebooks to add',
      '5. Click **Add Selected**',
      '',
      '**From a Notebook:**',
      "1. Open the notebook's menu",
      '2. Select **Add to Project**',
      '3. Choose the target project',
      '',
      '### Removing Notebooks',
      '',
      "1. In the project's Sessions tab",
      '2. Find the notebook you want to remove',
      '3. Click the remove icon',
      '4. Confirm removal',
      '',
      "> **Note:** Removing a notebook from a project doesn't delete it.",
      '',
      '### Searching & Filtering',
      '',
      '- Use the search bar to find notebooks by name',
      '- Filter by tags',
      '- Sort alphabetically or by date',
      '',
      '## Collaboration & Members',
      '',
      'Share projects with team members for collaborative work.',
      '',
      '### Inviting Members',
      '',
      '1. Go to the **Members** tab',
      '2. Click **Invite Members**',
      '3. Enter email addresses',
      '4. Send invitations',
      '',
      'Invited users receive a notification and can accept to join the project.',
      '',
      '### Managing Members',
      '',
      '- **View Members** - See all active project members',
      '- **Pending Invites** - Track outstanding invitations',
      "- **Remove Access** - Revoke a member's access",
      '- **Leave Project** - Remove yourself from a shared project',
      '',
      '### What Members Can Do',
      '',
      '| Action | Owner | Member |',
      '|--------|-------|--------|',
      '| View project | Yes | Yes |',
      '| Access notebooks | Yes | Yes |',
      '| Access files | Yes | Yes |',
      '| Add notebooks/files | Yes | No |',
      '| Invite members | Yes | No |',
      '| Edit project | Yes | No |',
      '| Delete project | Yes | No |',
      '| Leave project | No | Yes |',
      '',
      '## System Prompts',
      '',
      'Add project-wide AI context that applies to all conversations.',
      '',
      '### What Are System Prompts?',
      '',
      'System prompts are instructions or context given to AI before your conversation.',
      '',
      '### Adding System Prompts',
      '',
      '1. Go to the **System Prompts** tab',
      '2. Click **Add System Prompt**',
      '3. Select a knowledge file containing your prompt',
      '4. The prompt is added and enabled by default',
      '',
      '### Managing System Prompts',
      '',
      '- **Enable/Disable** - Toggle prompts on or off without removing them',
      '- **View** - See the content of the prompt',
      '- **Remove** - Remove the prompt from the project',
      '',
      '## Related Features',
      '',
      '- [Notebooks](./notebooks.md) - Create conversations within projects',
      '- [Knowledge Management](./knowledge-management.md) - Manage project files',
    ].join('\n');

    it('"Collaboration & Members" is a single chunk (was 4 tiny chunks before)', () => {
      const chunks = chunkByHeadings(projectsMd, 'Projects');
      const collabChunk = chunks.find(c => c.sectionPath === 'Collaboration & Members');
      expect(collabChunk).toBeDefined();
      expect(collabChunk!.content).toContain('Inviting Members');
      expect(collabChunk!.content).toContain('Managing Members');
      expect(collabChunk!.content).toContain('What Members Can Do');

      // Should be a single chunk, not split at H3
      const collabChunks = chunks.filter(c => c.sectionPath.includes('Collaboration'));
      expect(collabChunks).toHaveLength(1);

      // Token count should be in the sweet spot
      const tokens = estimateTokenCount(collabChunk!.content);
      expect(tokens).toBeGreaterThan(100);
      expect(tokens).toBeLessThan(800);
    });

    it('produces fewer, larger chunks than the old H2+H3 splitting', () => {
      const chunks = chunkByHeadings(projectsMd, 'Projects');
      // Old algorithm produced ~15+ chunks; new should consolidate to ~5-7
      expect(chunks.length).toBeLessThan(10);
      // Every chunk should have meaningful content
      for (const chunk of chunks) {
        const contentOnly = chunk.content.replace(/^#{1,6}\s+.+$/gm, '').trim();
        if (contentOnly.length > 0) {
          expect(estimateTokenCount(contentOnly)).toBeGreaterThan(20);
        }
      }
    });
  });

  it('handles document with only intro text and no headings', () => {
    const md = 'This is a simple document with no headings but enough content to be meaningful on its own.';
    const chunks = chunkByHeadings(md, 'Simple Doc');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionPath).toBe('Simple Doc');
    expect(chunks[0].content).toBe(md);
  });

  it('handles empty content', () => {
    const chunks = chunkByHeadings('', 'Empty');
    expect(chunks).toHaveLength(0);
  });

  it('handles multiple H2 sections of adequate size', () => {
    const content =
      'This section has a reasonable amount of content that should be well above the minimum section length threshold.';
    const md = ['## Section A', content, '', '## Section B', content, '', '## Section C', content].join('\n');

    const chunks = chunkByHeadings(md, 'Test');
    expect(chunks).toHaveLength(3);
    expect(chunks.map(c => c.sectionPath)).toEqual(['Section A', 'Section B', 'Section C']);
  });
});
