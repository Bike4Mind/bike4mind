import { useRef, useState } from 'react';
import {
  Box,
  IconButton,
  Stack,
  Tooltip,
  Modal,
  ModalDialog,
  ModalClose,
  Typography,
  Button,
  Table,
  Chip,
} from '@mui/joy';
import DownloadIcon from '@mui/icons-material/Download';
import UploadIcon from '@mui/icons-material/UploadFile';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { useExportCSV, useDownloadTemplate, useImportCSV } from './hooks';
import { toast } from 'sonner';
import { purple, cyan, whiteAlpha, grayAlpha, blackAlpha, green, orange } from '@client/app/utils/themes/colors';

interface IExportControls {
  showExport?: boolean;
}

const ExportControls = ({ showExport = true }: IExportControls) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const exportCSV = useExportCSV();
  const downloadTemplate = useDownloadTemplate();
  const importMutation = useImportCSV();

  const handleExport = async () => {
    await exportCSV();
  };

  const handleDownloadTemplate = async () => {
    await downloadTemplate();
  };

  const handleImport = () => {
    fileInputRef.current?.click();
  };
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      const csv = evt.target?.result as string;
      importMutation.mutate(csv);
    };
    reader.onerror = () => {
      toast.error('Failed to read file');
    };
    reader.readAsText(file);
  };

  return (
    <>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          position: 'absolute',
          top: 20,
          right: 36,
          zIndex: 1201,
        }}
      >
        <Tooltip title="CSV Format Help" placement="bottom" sx={{ zIndex: 13000 }}>
          <IconButton size="sm" variant="outlined" onClick={() => setHelpModalOpen(true)}>
            <HelpOutlineIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Download Template" placement="bottom" sx={{ zIndex: 13000 }}>
          <IconButton size="sm" variant="outlined" onClick={handleDownloadTemplate}>
            <DownloadIcon />
          </IconButton>
        </Tooltip>
        {showExport && (
          <Tooltip title="Export CSV" placement="bottom" sx={{ zIndex: 13000 }}>
            <IconButton size="sm" variant="outlined" onClick={handleExport}>
              <InsertDriveFileIcon />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Import CSV" placement="bottom" sx={{ zIndex: 13000 }}>
          <Box>
            <IconButton
              size="sm"
              variant="outlined"
              color="primary"
              onClick={handleImport}
              loading={importMutation.isPending}
            >
              <UploadIcon />
            </IconButton>
          </Box>
        </Tooltip>
        <Box
          component="input"
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={handleFileChange}
          disabled={importMutation.isPending}
        />
      </Stack>

      {/* CSV Format Help Modal */}
      <Modal open={helpModalOpen} onClose={() => setHelpModalOpen(false)} sx={{ zIndex: 14001 }}>
        <ModalDialog
          sx={{
            minWidth: 600,
            maxWidth: 800,
            maxHeight: 'calc(100vh - 64px)',
            overflow: 'auto',
            zIndex: 14001,
            p: 3,
            background: `linear-gradient(135deg, ${whiteAlpha[0][98]} 0%, ${grayAlpha[15][95]} 50%, ${grayAlpha[5][98]} 100%)`,
            boxShadow: `0 25px 50px -12px ${blackAlpha[0][30]}, 0 0 0 1px ${whiteAlpha[0][5]}`,
            borderRadius: '20px',
            border: `1px solid ${whiteAlpha[0][30]}`,
            backdropFilter: 'blur(20px)',
          }}
        >
          <ModalClose
            onClick={() => setHelpModalOpen(false)}
            sx={{
              position: 'absolute',
              top: 12,
              right: 12,
              zIndex: 10,
              borderRadius: '50%',
              transition: 'all 0.2s ease',
              '&:hover': {
                bgcolor: 'danger.softHoverBg',
                transform: 'scale(1.1)',
              },
            }}
          />

          <Typography level="h3" mb={2} sx={{ fontWeight: 700, color: purple[300] }}>
            📋 CSV Import Format Guide
          </Typography>

          <Typography level="body-md" mb={3} color="neutral">
            Import your business links using a properly formatted CSV file. Here&apos;s everything you need to know:
          </Typography>

          <Typography level="h4" mb={2} sx={{ fontWeight: 600, color: green[650] }}>
            Required CSV Format
          </Typography>

          <Box
            sx={{
              mb: 3,
              p: 2,
              bgcolor: 'background.level1',
              borderRadius: '12px',
              border: `1px solid ${blackAlpha[0][10]}`,
            }}
          >
            <Typography level="body-sm" sx={{ fontFamily: 'monospace', mb: 1, fontWeight: 600 }}>
              Header Row (Required):
            </Typography>
            <Typography level="body-sm" sx={{ fontFamily: 'monospace', color: purple[300] }}>
              Company,Ticker,URL,Type,Category,Category Description
            </Typography>
          </Box>

          <Typography level="h4" mb={2} sx={{ fontWeight: 600, color: green[650] }}>
            Column Descriptions
          </Typography>

          <Table sx={{ mb: 3 }}>
            <thead>
              <tr>
                <th style={{ width: '20%' }}>Column</th>
                <th style={{ width: '15%' }}>Required</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <Chip size="sm" color="primary">
                    Company
                  </Chip>
                </td>
                <td>
                  <Chip size="sm" color="success">
                    Yes
                  </Chip>
                </td>
                <td>Company name (use quotes if contains commas)</td>
              </tr>
              <tr>
                <td>
                  <Chip size="sm" color="primary">
                    Ticker
                  </Chip>
                </td>
                <td>
                  <Chip size="sm" color="success">
                    Yes
                  </Chip>
                </td>
                <td>Stock ticker symbol (e.g., AAPL, MSFT)</td>
              </tr>
              <tr>
                <td>
                  <Chip size="sm" color="primary">
                    URL
                  </Chip>
                </td>
                <td>
                  <Chip size="sm" color="success">
                    Yes
                  </Chip>
                </td>
                <td>Full investor relations or earnings URL</td>
              </tr>
              <tr>
                <td>
                  <Chip size="sm" color="primary">
                    Type
                  </Chip>
                </td>
                <td>
                  <Chip size="sm" color="success">
                    Yes
                  </Chip>
                </td>
                <td>Business type: tech, finance, healthcare, others</td>
              </tr>
              <tr>
                <td>
                  <Chip size="sm" color="primary">
                    Category
                  </Chip>
                </td>
                <td>
                  <Chip size="sm" color="success">
                    Yes
                  </Chip>
                </td>
                <td>Category name (will be created if doesn&apos;t exist)</td>
              </tr>
              <tr>
                <td>
                  <Chip size="sm" color="primary">
                    Category Description
                  </Chip>
                </td>
                <td>
                  <Chip size="sm" color="success">
                    Yes
                  </Chip>
                </td>
                <td>Description for the category</td>
              </tr>
            </tbody>
          </Table>

          <Typography level="h4" mb={2} sx={{ fontWeight: 600, color: green[650] }}>
            Example Rows
          </Typography>

          <Box
            sx={{
              mb: 3,
              p: 2,
              bgcolor: 'background.level1',
              borderRadius: '12px',
              border: `1px solid ${blackAlpha[0][10]}`,
            }}
          >
            <Typography level="body-sm" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-line', lineHeight: 1.5 }}>
              {`Apple,AAPL,https://investor.apple.com/investor-relations/,tech,Earnings Reports,Latest quarterly earnings
"Alphabet (Google)",GOOG,https://abc.xyz/investor/,tech,Earnings Reports,Latest quarterly earnings
PayPal Holdings,PYPL,https://investor.pypl.com/financials/,finance,Financial Services,Financial company reports`}
            </Typography>
          </Box>

          <Typography level="h4" mb={2} sx={{ fontWeight: 600, color: orange[650] }}>
            💡 Pro Tips
          </Typography>

          <Box sx={{ mb: 3 }}>
            <ul style={{ paddingLeft: '20px', margin: 0 }}>
              <li>
                <Typography level="body-sm" mb={1}>
                  Use quotes around company names that contain commas or special characters
                </Typography>
              </li>
              <li>
                <Typography level="body-sm" mb={1}>
                  URLs should start with https:// or https://
                </Typography>
              </li>
              <li>
                <Typography level="body-sm" mb={1}>
                  Categories will be automatically created if they don&apos;t exist
                </Typography>
              </li>
              <li>
                <Typography level="body-sm" mb={1}>
                  Download the template first to see the exact format
                </Typography>
              </li>
              <li>
                <Typography level="body-sm" mb={1}>
                  International tickers are supported (e.g., 7974.T, 000660.KS)
                </Typography>
              </li>
            </ul>
          </Box>

          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
            <Button variant="outlined" onClick={handleDownloadTemplate} startDecorator={<DownloadIcon />}>
              Download Template
            </Button>
            <Button
              variant="solid"
              color="primary"
              onClick={() => setHelpModalOpen(false)}
              sx={{
                background: `linear-gradient(135deg, ${purple[300]} 0%, ${cyan[400]} 100%)`,
                borderRadius: '12px',
                fontWeight: 600,
              }}
            >
              Got it!
            </Button>
          </Box>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default ExportControls;
