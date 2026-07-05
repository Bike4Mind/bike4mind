import { IQuestMasterPlanDocument } from '@bike4mind/common';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { useQuestExport } from '@client/app/hooks/data/useQuestExport';
import {
  questPlanToMarkdown,
  questPlanToJSON,
  questPlanToCSV,
  questPlanToPdf,
  questPlanToExcel,
  questPlanToDocx,
  getExportFilename,
} from '@client/app/utils/questExport';
import { downloadFile } from '@client/app/components/common/DownloadMenu';
import {
  SaveAlt as ExportIcon,
  Description as MarkdownIcon,
  DataObject as JSONIcon,
  TableChart as CSVIcon,
  ContentCopy as CopyIcon,
  FolderZip as ZIPIcon,
  PictureAsPdf as PDFIcon,
  GridOn as ExcelIcon,
  Article as WordIcon,
} from '@mui/icons-material';
import {
  CircularProgress,
  Divider,
  Dropdown,
  IconButton,
  ListItemDecorator,
  Menu,
  MenuButton,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/joy';
import React, { useCallback, useState } from 'react';
import { toast } from 'sonner';

interface QuestExportMenuProps {
  planId: string;
  plan: IQuestMasterPlanDocument;
  size?: 'sm' | 'md';
}

const QuestExportMenu: React.FC<QuestExportMenuProps> = ({ planId, plan, size = 'sm' }) => {
  const { handleCopyToClipboard } = useCopyToClipboard({ showToast: true });
  const { startExport, isExporting: isZipExporting } = useQuestExport();
  const [isPdfGenerating, setIsPdfGenerating] = useState(false);
  const [isExcelGenerating, setIsExcelGenerating] = useState(false);
  const [isDocxGenerating, setIsDocxGenerating] = useState(false);

  const filename = getExportFilename(plan.goal);
  const isExporting = isZipExporting || isPdfGenerating || isExcelGenerating || isDocxGenerating;

  const handleExport = useCallback(
    (format: 'markdown' | 'json' | 'csv') => {
      switch (format) {
        case 'markdown': {
          const md = questPlanToMarkdown(plan);
          downloadFile(md, `${filename}.md`, 'text/markdown');
          toast.success('Markdown exported');
          break;
        }
        case 'json': {
          const json = questPlanToJSON(plan);
          downloadFile(json, `${filename}.json`, 'application/json');
          toast.success('JSON exported');
          break;
        }
        case 'csv': {
          const csv = questPlanToCSV(plan);
          downloadFile(csv, `${filename}.csv`, 'text/csv');
          toast.success('CSV exported');
          break;
        }
      }
    },
    [plan, filename]
  );

  const handleCopy = useCallback(
    (format: 'markdown' | 'json') => {
      const content = format === 'markdown' ? questPlanToMarkdown(plan) : questPlanToJSON(plan);
      handleCopyToClipboard(content);
    },
    [plan, handleCopyToClipboard]
  );

  const handlePdfExport = useCallback(async () => {
    setIsPdfGenerating(true);
    try {
      await questPlanToPdf(plan, filename);
      toast.success('PDF exported');
    } catch (error) {
      console.error('PDF export failed:', error);
      toast.error('Failed to generate PDF');
    } finally {
      setIsPdfGenerating(false);
    }
  }, [plan, filename]);

  const handleExcelExport = useCallback(async () => {
    setIsExcelGenerating(true);
    try {
      await questPlanToExcel(plan, filename);
      toast.success('Excel exported');
    } catch (error) {
      console.error('Excel export failed:', error);
      toast.error('Failed to generate Excel file');
    } finally {
      setIsExcelGenerating(false);
    }
  }, [plan, filename]);

  const handleDocxExport = useCallback(async () => {
    setIsDocxGenerating(true);
    try {
      await questPlanToDocx(plan, filename);
      toast.success('Word document exported');
    } catch (error) {
      console.error('DOCX export failed:', error);
      toast.error('Failed to generate Word document');
    } finally {
      setIsDocxGenerating(false);
    }
  }, [plan, filename]);

  const handleZipExport = useCallback(() => {
    startExport(planId);
  }, [startExport, planId]);

  return (
    <Dropdown>
      <Tooltip title="Export quest plan" placement="top">
        <MenuButton
          data-testid="quest-export-menu-btn"
          slots={{ root: IconButton }}
          slotProps={{
            root: {
              variant: 'outlined',
              color: 'neutral',
              size,
              disabled: isExporting,
              onClick: (e: React.MouseEvent) => e.stopPropagation(),
            },
          }}
        >
          {isExporting ? <CircularProgress size="sm" /> : <ExportIcon />}
        </MenuButton>
      </Tooltip>
      <Menu placement="bottom-end" size={size} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        {/* Quick Export Section */}
        <Typography level="body-xs" sx={{ px: 1.5, py: 0.5, fontWeight: 'bold', color: 'neutral.500' }}>
          Quick Export
        </Typography>

        <MenuItem data-testid="quest-export-markdown" onClick={() => handleExport('markdown')}>
          <ListItemDecorator>
            <MarkdownIcon fontSize="small" />
          </ListItemDecorator>
          Markdown (.md)
        </MenuItem>

        <MenuItem data-testid="quest-export-json" onClick={() => handleExport('json')}>
          <ListItemDecorator>
            <JSONIcon fontSize="small" />
          </ListItemDecorator>
          JSON (.json)
        </MenuItem>

        <MenuItem data-testid="quest-export-csv" onClick={() => handleExport('csv')}>
          <ListItemDecorator>
            <CSVIcon fontSize="small" />
          </ListItemDecorator>
          CSV (.csv)
        </MenuItem>

        <MenuItem data-testid="quest-export-excel" onClick={handleExcelExport} disabled={isExcelGenerating}>
          <ListItemDecorator>
            {isExcelGenerating ? <CircularProgress size="sm" /> : <ExcelIcon fontSize="small" />}
          </ListItemDecorator>
          Excel (.xlsx)
          {isExcelGenerating && (
            <Typography level="body-xs" sx={{ ml: 1, color: 'neutral.500' }}>
              Generating...
            </Typography>
          )}
        </MenuItem>

        <MenuItem data-testid="quest-export-docx" onClick={handleDocxExport} disabled={isDocxGenerating}>
          <ListItemDecorator>
            {isDocxGenerating ? <CircularProgress size="sm" /> : <WordIcon fontSize="small" />}
          </ListItemDecorator>
          Word (.docx)
          {isDocxGenerating && (
            <Typography level="body-xs" sx={{ ml: 1, color: 'neutral.500' }}>
              Generating...
            </Typography>
          )}
        </MenuItem>

        <Divider sx={{ my: 0.5 }} />

        {/* Copy Section */}
        <Typography level="body-xs" sx={{ px: 1.5, py: 0.5, fontWeight: 'bold', color: 'neutral.500' }}>
          Copy to Clipboard
        </Typography>

        <MenuItem data-testid="quest-copy-markdown" onClick={() => handleCopy('markdown')}>
          <ListItemDecorator>
            <CopyIcon fontSize="small" />
          </ListItemDecorator>
          Copy as Markdown
        </MenuItem>

        <MenuItem data-testid="quest-copy-json" onClick={() => handleCopy('json')}>
          <ListItemDecorator>
            <CopyIcon fontSize="small" />
          </ListItemDecorator>
          Copy as JSON
        </MenuItem>

        <Divider sx={{ my: 0.5 }} />

        {/* Full Export Section */}
        <Typography level="body-xs" sx={{ px: 1.5, py: 0.5, fontWeight: 'bold', color: 'neutral.500' }}>
          Full Export
        </Typography>

        <MenuItem data-testid="quest-export-pdf" onClick={handlePdfExport} disabled={isPdfGenerating}>
          <ListItemDecorator>
            {isPdfGenerating ? <CircularProgress size="sm" /> : <PDFIcon fontSize="small" />}
          </ListItemDecorator>
          PDF Document (.pdf)
          {isPdfGenerating && (
            <Typography level="body-xs" sx={{ ml: 1, color: 'neutral.500' }}>
              Generating...
            </Typography>
          )}
        </MenuItem>

        <MenuItem data-testid="quest-export-zip" onClick={handleZipExport} disabled={isZipExporting}>
          <ListItemDecorator>
            {isZipExporting ? <CircularProgress size="sm" /> : <ZIPIcon fontSize="small" />}
          </ListItemDecorator>
          ZIP Package (with AI responses)
          {isZipExporting && (
            <Typography level="body-xs" sx={{ ml: 1, color: 'neutral.500' }}>
              Building...
            </Typography>
          )}
        </MenuItem>
      </Menu>
    </Dropdown>
  );
};

export default QuestExportMenu;
