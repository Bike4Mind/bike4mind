import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockQuestPlan } from './fixtures/questPlanFixture';

const mockDownloadData = vi.fn();

vi.mock('@client/app/utils/download', () => ({
  downloadData: mockDownloadData,
}));

const mockText = vi.fn().mockReturnThis();
const mockSetFont = vi.fn().mockReturnThis();
const mockSetFontSize = vi.fn().mockReturnThis();
const mockSetTextColor = vi.fn().mockReturnThis();
const mockSetDrawColor = vi.fn().mockReturnThis();
const mockSetLineWidth = vi.fn().mockReturnThis();
const mockLine = vi.fn().mockReturnThis();
const mockAddPage = vi.fn().mockReturnThis();
const mockSplitTextToSize = vi.fn((text: string) => [text]);
const mockOutput = vi.fn().mockReturnValue(new Blob(['pdf-content'], { type: 'application/pdf' }));

vi.mock('jspdf', () => ({
  jsPDF: vi.fn().mockImplementation(function () {
    return {
      text: mockText,
      setFont: mockSetFont,
      setFontSize: mockSetFontSize,
      setTextColor: mockSetTextColor,
      setDrawColor: mockSetDrawColor,
      setLineWidth: mockSetLineWidth,
      line: mockLine,
      addPage: mockAddPage,
      splitTextToSize: mockSplitTextToSize,
      output: mockOutput,
    };
  }),
}));

describe('questPlanToPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a jsPDF document with A4 portrait format', async () => {
    const { jsPDF } = await import('jspdf');
    const { questPlanToPdf } = await import('../questExport');

    await questPlanToPdf(mockQuestPlan, 'test-file');

    expect(jsPDF).toHaveBeenCalledWith({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  });

  it('should render the plan goal as the title', async () => {
    const { questPlanToPdf } = await import('../questExport');

    await questPlanToPdf(mockQuestPlan, 'test-file');

    expect(mockText).toHaveBeenCalledWith(
      expect.stringContaining('Build a mobile app for fitness tracking'),
      expect.any(Number),
      expect.any(Number)
    );
  });

  it('should render quest titles', async () => {
    const { questPlanToPdf } = await import('../questExport');

    await questPlanToPdf(mockQuestPlan, 'test-file');

    const allTextCalls = mockText.mock.calls.map(c => c[0]);
    expect(allTextCalls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Set up project infrastructure'),
        expect.stringContaining('Build core features'),
      ])
    );
  });

  it('should render sub-quest titles and statuses', async () => {
    const { questPlanToPdf } = await import('../questExport');

    await questPlanToPdf(mockQuestPlan, 'test-file');

    const allTextCalls = mockText.mock.calls.map(c => c[0]);
    expect(allTextCalls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Initialize React Native project'),
        expect.stringContaining('Completed'),
      ])
    );
  });

  it('should trigger download with the generated PDF blob', async () => {
    const { questPlanToPdf } = await import('../questExport');

    await questPlanToPdf(mockQuestPlan, 'test-file');

    expect(mockOutput).toHaveBeenCalledWith('blob');
    expect(mockDownloadData).toHaveBeenCalledWith(expect.any(Blob), 'test-file.pdf', 'application/pdf');
  });

  it('should not manipulate the DOM at all', async () => {
    const { questPlanToPdf } = await import('../questExport');
    const appendChildSpy = vi.spyOn(document.body, 'appendChild');

    await questPlanToPdf(mockQuestPlan, 'test-file');

    expect(appendChildSpy).not.toHaveBeenCalled();
    appendChildSpy.mockRestore();
  });
});
