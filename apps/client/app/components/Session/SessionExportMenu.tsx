import { IChatHistoryItemDocument, ISessionDocument } from '@bike4mind/common';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import {
  toExportableSession,
  sessionToMarkdown,
  sessionToJSON,
  sessionToCSV,
  sessionToExcel,
  sessionToDocx,
  getSessionExportFilename,
} from '@client/app/utils/sessionExport';
import { downloadFile } from '@client/app/components/common/DownloadMenu';
import {
  SaveAlt as ExportIcon,
  Description as MarkdownIcon,
  DataObject as JSONIcon,
  TableChart as CSVIcon,
  ContentCopy as CopyIcon,
  GridOn as ExcelIcon,
  Article as WordIcon,
  Storage as StorageIcon,
} from '@mui/icons-material';
import { useSendToDataLakeStore } from '@client/app/stores/useSendToDataLakeStore';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
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

interface SessionExportMenuProps {
  session: ISessionDocument;
  chatHistory: IChatHistoryItemDocument[];
  size?: 'sm' | 'md';
  variant?: 'icon' | 'menuItem';
}

const SessionExportMenu: React.FC<SessionExportMenuProps> = ({
  session,
  chatHistory,
  size = 'sm',
  variant = 'icon',
}) => {
  const { handleCopyToClipboard } = useCopyToClipboard({ showToast: true });
  const [isExcelGenerating, setIsExcelGenerating] = useState(false);
  const [isDocxGenerating, setIsDocxGenerating] = useState(false);
  const openSendToDataLake = useSendToDataLakeStore(s => s.open);
  const { isFeatureEnabled } = useAdminSettingsCache();

  const filename = getSessionExportFilename(session.name);
  const isExporting = isExcelGenerating || isDocxGenerating;

  const getExportableSession = useCallback(() => {
    return toExportableSession(session, chatHistory);
  }, [session, chatHistory]);

  const handleExport = useCallback(
    (format: 'markdown' | 'json' | 'csv') => {
      const exportable = getExportableSession();

      switch (format) {
        case 'markdown': {
          const md = sessionToMarkdown(exportable);
          downloadFile(md, `${filename}.md`, 'text/markdown');
          toast.success('Markdown exported');
          break;
        }
        case 'json': {
          const json = sessionToJSON(exportable);
          downloadFile(json, `${filename}.json`, 'application/json');
          toast.success('JSON exported');
          break;
        }
        case 'csv': {
          const csv = sessionToCSV(exportable);
          downloadFile(csv, `${filename}.csv`, 'text/csv');
          toast.success('CSV exported');
          break;
        }
      }
    },
    [getExportableSession, filename]
  );

  const handleCopy = useCallback(
    (format: 'markdown' | 'json') => {
      const exportable = getExportableSession();
      const content = format === 'markdown' ? sessionToMarkdown(exportable) : sessionToJSON(exportable);
      handleCopyToClipboard(content);
    },
    [getExportableSession, handleCopyToClipboard]
  );

  const handleExcelExport = useCallback(async () => {
    setIsExcelGenerating(true);
    try {
      const exportable = getExportableSession();
      await sessionToExcel(exportable, filename);
      toast.success('Excel exported');
    } catch (error) {
      console.error('Excel export failed:', error);
      toast.error('Failed to generate Excel file');
    } finally {
      setIsExcelGenerating(false);
    }
  }, [getExportableSession, filename]);

  const handleDocxExport = useCallback(async () => {
    setIsDocxGenerating(true);
    try {
      const exportable = getExportableSession();
      await sessionToDocx(exportable, filename);
      toast.success('Word document exported');
    } catch (error) {
      console.error('DOCX export failed:', error);
      toast.error('Failed to generate Word document');
    } finally {
      setIsDocxGenerating(false);
    }
  }, [getExportableSession, filename]);

  const handleSendToDataLake = useCallback(() => {
    openSendToDataLake({
      content: sessionToMarkdown(getExportableSession()),
      fileName: `${filename}.md`,
      sourceLabel: 'session',
    });
  }, [getExportableSession, filename, openSendToDataLake]);

  return (
    <Dropdown>
      <Tooltip title="Export session" placement="top">
        <MenuButton
          data-testid="session-export-menu-btn"
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

        <MenuItem data-testid="session-export-markdown" onClick={() => handleExport('markdown')}>
          <ListItemDecorator>
            <MarkdownIcon fontSize="small" />
          </ListItemDecorator>
          Markdown (.md)
        </MenuItem>

        <MenuItem data-testid="session-export-json" onClick={() => handleExport('json')}>
          <ListItemDecorator>
            <JSONIcon fontSize="small" />
          </ListItemDecorator>
          JSON (.json)
        </MenuItem>

        <MenuItem data-testid="session-export-csv" onClick={() => handleExport('csv')}>
          <ListItemDecorator>
            <CSVIcon fontSize="small" />
          </ListItemDecorator>
          CSV (.csv)
        </MenuItem>

        <MenuItem data-testid="session-export-excel" onClick={handleExcelExport} disabled={isExcelGenerating}>
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

        <MenuItem data-testid="session-export-docx" onClick={handleDocxExport} disabled={isDocxGenerating}>
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

        <MenuItem data-testid="session-copy-markdown" onClick={() => handleCopy('markdown')}>
          <ListItemDecorator>
            <CopyIcon fontSize="small" />
          </ListItemDecorator>
          Copy as Markdown
        </MenuItem>

        <MenuItem data-testid="session-copy-json" onClick={() => handleCopy('json')}>
          <ListItemDecorator>
            <CopyIcon fontSize="small" />
          </ListItemDecorator>
          Copy as JSON
        </MenuItem>

        {/* Data Lake Section - the item is the section's only entry, so hide the
            header and divider with it when the feature is off (matches the rest of
            the data-lake surface, e.g. CreateDataLakeButton in FileBrowser). */}
        {isFeatureEnabled('EnableDataLakes') && (
          <>
            <Divider sx={{ my: 0.5 }} />

            <Typography level="body-xs" sx={{ px: 1.5, py: 0.5, fontWeight: 'bold', color: 'neutral.500' }}>
              Knowledge
            </Typography>

            <MenuItem data-testid="session-send-to-datalake" onClick={handleSendToDataLake}>
              <ListItemDecorator>
                <StorageIcon fontSize="small" />
              </ListItemDecorator>
              Send to Data Lake
            </MenuItem>
          </>
        )}
      </Menu>
    </Dropdown>
  );
};

export default SessionExportMenu;
