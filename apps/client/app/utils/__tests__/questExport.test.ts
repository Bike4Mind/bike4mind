import { describe, it, expect, vi } from 'vitest';
import { questPlanToMarkdown, questPlanToJSON, questPlanToCSV, getExportFilename } from '../questExport';
import { mockQuestPlan } from './fixtures/questPlanFixture';

describe('questExport', () => {
  describe('getExportFilename', () => {
    it('should create a slug from the goal', () => {
      expect(getExportFilename('Build a Mobile App')).toBe('questmaster-build-a-mobile-app');
    });

    it('should truncate long goals', () => {
      const longGoal = 'A'.repeat(100);
      const filename = getExportFilename(longGoal);
      expect(filename.length).toBeLessThanOrEqual(62); // "questmaster-" prefix + 50 chars max
    });

    it('should handle special characters', () => {
      expect(getExportFilename('Build: App & Test!')).toBe('questmaster-build-app-test');
    });
  });

  describe('questPlanToMarkdown', () => {
    it('should contain the goal as heading', () => {
      const md = questPlanToMarkdown(mockQuestPlan);
      expect(md).toContain('# Build a mobile app for fitness tracking');
    });

    it('should contain export metadata', () => {
      const md = questPlanToMarkdown(mockQuestPlan);
      expect(md).toContain('Exported from QuestMaster');
      expect(md).toContain('Status: active');
      expect(md).toContain('2/6 tasks');
      expect(md).toContain('33%');
    });

    it('should contain tags', () => {
      const md = questPlanToMarkdown(mockQuestPlan);
      expect(md).toContain('mobile, fitness');
    });

    it('should contain all quest titles', () => {
      const md = questPlanToMarkdown(mockQuestPlan);
      expect(md).toContain('Set up project infrastructure');
      expect(md).toContain('Build core features');
    });

    it('should contain all sub-quest titles', () => {
      const md = questPlanToMarkdown(mockQuestPlan);
      expect(md).toContain('Initialize React Native project');
      expect(md).toContain('Configure TypeScript');
      expect(md).toContain('Set up navigation');
      expect(md).toContain('Create workout model');
      expect(md).toContain('Build exercise tracker UI');
      expect(md).toContain('Add timer functionality');
    });

    it('should contain status icons', () => {
      const md = questPlanToMarkdown(mockQuestPlan);
      // Completed items should have check mark
      expect(md).toMatch(/Initialize React Native project.*✓/);
      // In-progress items should have rotating arrows
      expect(md).toMatch(/Set up navigation.*🔄/);
      // Skipped items should have skip icon
      expect(md).toMatch(/Add timer functionality.*⏭/);
    });

    it('should include complexity for each quest', () => {
      const md = questPlanToMarkdown(mockQuestPlan);
      expect(md).toContain('Easy');
      expect(md).toContain('Hard');
    });

    it('should include a Table of Contents', () => {
      const md = questPlanToMarkdown(mockQuestPlan);
      expect(md).toContain('## Table of Contents');
    });
  });

  describe('questPlanToJSON', () => {
    it('should produce valid JSON', () => {
      const json = questPlanToJSON(mockQuestPlan);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('should include format version', () => {
      const parsed = JSON.parse(questPlanToJSON(mockQuestPlan));
      expect(parsed.format).toBe('questmaster-v1');
    });

    it('should include exportedAt timestamp', () => {
      const parsed = JSON.parse(questPlanToJSON(mockQuestPlan));
      expect(parsed.exportedAt).toBeDefined();
      expect(() => new Date(parsed.exportedAt)).not.toThrow();
    });

    it('should include the goal', () => {
      const parsed = JSON.parse(questPlanToJSON(mockQuestPlan));
      expect(parsed.goal).toBe('Build a mobile app for fitness tracking');
    });

    it('should include all quests and sub-quests', () => {
      const parsed = JSON.parse(questPlanToJSON(mockQuestPlan));
      expect(parsed.quests).toHaveLength(2);
      expect(parsed.quests[0].subQuests).toHaveLength(3);
      expect(parsed.quests[1].subQuests).toHaveLength(3);
    });

    it('should include metrics', () => {
      const parsed = JSON.parse(questPlanToJSON(mockQuestPlan));
      expect(parsed.metrics.completionRate).toBe(33);
      expect(parsed.metrics.subQuestsCompleted).toBe(2);
      expect(parsed.metrics.subQuestsTotal).toBe(6);
    });

    it('should include tags', () => {
      const parsed = JSON.parse(questPlanToJSON(mockQuestPlan));
      expect(parsed.tags).toEqual(['mobile', 'fitness']);
    });

    it('should preserve sub-quest statuses', () => {
      const parsed = JSON.parse(questPlanToJSON(mockQuestPlan));
      expect(parsed.quests[0].subQuests[0].status).toBe('completed');
      expect(parsed.quests[0].subQuests[2].status).toBe('in_progress');
      expect(parsed.quests[1].subQuests[2].status).toBe('skipped');
    });
  });

  describe('questPlanToCSV', () => {
    it('should produce valid CSV with headers', () => {
      const csv = questPlanToCSV(mockQuestPlan);
      const lines = csv.split('\n');
      expect(lines[0]).toContain('Quest #');
      expect(lines[0]).toContain('Quest Title');
      expect(lines[0]).toContain('Complexity');
      expect(lines[0]).toContain('Sub-Quest #');
      expect(lines[0]).toContain('Sub-Quest Title');
      expect(lines[0]).toContain('Status');
      expect(lines[0]).toContain('Started At');
    });

    it('should have one row per sub-quest plus header', () => {
      const csv = questPlanToCSV(mockQuestPlan);
      const lines = csv.split('\n').filter(l => l.trim());
      // 1 header + 6 sub-quests = 7 lines
      expect(lines).toHaveLength(7);
    });

    it('should contain all sub-quest titles', () => {
      const csv = questPlanToCSV(mockQuestPlan);
      expect(csv).toContain('Initialize React Native project');
      expect(csv).toContain('Create workout model');
      expect(csv).toContain('Add timer functionality');
    });

    it('should use human-readable status labels', () => {
      const csv = questPlanToCSV(mockQuestPlan);
      expect(csv).toContain('Completed');
      expect(csv).toContain('In Progress');
      expect(csv).toContain('Not Started');
      expect(csv).toContain('Skipped');
    });
  });

  describe('questPlanToExcel', () => {
    it('should generate a valid xlsx blob and trigger download', async () => {
      // Import fresh module to capture download call
      vi.resetModules();
      const downloadMock = vi.fn();
      vi.doMock('@client/app/utils/download', () => ({
        downloadData: downloadMock,
      }));

      const { questPlanToExcel } = await import('../questExport');
      await questPlanToExcel(mockQuestPlan, 'test-export');

      expect(downloadMock).toHaveBeenCalledTimes(1);
      const [blob, filename, mimeType] = downloadMock.mock.calls[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(filename).toBe('test-export.xlsx');
      expect(mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    });

    it('should generate a blob with non-zero size', async () => {
      vi.resetModules();
      const downloadMock = vi.fn();
      vi.doMock('@client/app/utils/download', () => ({
        downloadData: downloadMock,
      }));

      const { questPlanToExcel } = await import('../questExport');
      await questPlanToExcel(mockQuestPlan, 'test-export');

      const [blob] = downloadMock.mock.calls[0];
      expect((blob as Blob).size).toBeGreaterThan(0);
    });
  });

  describe('questPlanToDocx', () => {
    it('should generate a valid docx blob and trigger download', async () => {
      vi.resetModules();
      const downloadMock = vi.fn();
      vi.doMock('@client/app/utils/download', () => ({
        downloadData: downloadMock,
      }));

      const { questPlanToDocx } = await import('../questExport');
      await questPlanToDocx(mockQuestPlan, 'test-export');

      expect(downloadMock).toHaveBeenCalledTimes(1);
      const [blob, filename, mimeType] = downloadMock.mock.calls[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(filename).toBe('test-export.docx');
      expect(mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });

    it('should generate a blob with non-zero size', async () => {
      vi.resetModules();
      const downloadMock = vi.fn();
      vi.doMock('@client/app/utils/download', () => ({
        downloadData: downloadMock,
      }));

      const { questPlanToDocx } = await import('../questExport');
      await questPlanToDocx(mockQuestPlan, 'test-export');

      const [blob] = downloadMock.mock.calls[0];
      expect((blob as Blob).size).toBeGreaterThan(0);
    });
  });
});
