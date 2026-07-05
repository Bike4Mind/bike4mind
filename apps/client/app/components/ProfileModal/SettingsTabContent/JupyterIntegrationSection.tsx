import { Typography, Box, Stack, Alert, Chip, Accordion, AccordionSummary, AccordionDetails } from '@mui/joy';
import {
  Science as JupyterIcon,
  Terminal,
  PlayArrow,
  CheckCircle,
  ExpandMore,
  Code,
  Storage,
  Settings,
} from '@mui/icons-material';
import SectionContainer from '../SectionContainer';
import { gray } from '../../../utils/themes/colors';

/**
 * Setup guide for executing AI-generated Jupyter notebooks on the user's local
 * Jupyter server via the B4M CLI.
 */
const JupyterIntegrationSection = () => {
  return (
    <SectionContainer
      title={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <JupyterIcon sx={{ color: '#F37626' }} />
          <Typography level="h4">Jupyter Notebooks</Typography>
        </Box>
      }
      subtitle="Execute AI-generated Python notebooks on your local Jupyter server directly from the chat interface."
      action={
        <Chip size="sm" variant="soft" color="primary" startDecorator={<Terminal sx={{ fontSize: 14 }} />}>
          CLI Required
        </Chip>
      }
    >
      <Stack spacing={3}>
        {/* Feature Overview */}
        <Box
          sx={theme => ({
            backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : gray[850],
            p: 2.5,
            borderRadius: 'sm',
          })}
        >
          <Stack spacing={2}>
            <Typography level="body-sm" fontWeight="bold" startDecorator={<PlayArrow sx={{ fontSize: 18 }} />}>
              What You Can Do
            </Typography>
            <Stack spacing={1.5} sx={{ pl: 0.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
                <CheckCircle sx={{ fontSize: 16, color: 'success.500', mt: 0.25 }} />
                <Typography level="body-sm">
                  <strong>Generate notebooks</strong> — Ask B4M to create Python notebooks for data analysis,
                  visualizations, or any computational task
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
                <CheckCircle sx={{ fontSize: 16, color: 'success.500', mt: 0.25 }} />
                <Typography level="body-sm">
                  <strong>One-click execution</strong> — Run generated notebooks with a single click using the &quot;Run
                  Notebook&quot; button
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
                <CheckCircle sx={{ fontSize: 16, color: 'success.500', mt: 0.25 }} />
                <Typography level="body-sm">
                  <strong>Real-time progress</strong> — Watch cell execution progress with live updates streamed to your
                  browser
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
                <CheckCircle sx={{ fontSize: 16, color: 'success.500', mt: 0.25 }} />
                <Typography level="body-sm">
                  <strong>Local execution</strong> — Notebooks run on your machine with full access to your Python
                  environment and packages
                </Typography>
              </Box>
            </Stack>
          </Stack>
        </Box>

        {/* Requirements */}
        <Alert
          variant="soft"
          color="neutral"
          sx={{ borderRadius: 'sm' }}
          startDecorator={<Settings sx={{ fontSize: 20 }} />}
        >
          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Requirements
            </Typography>
            <Stack spacing={0.5}>
              <Typography level="body-xs">
                <strong>1.</strong> B4M CLI installed and running on your machine
              </Typography>
              <Typography level="body-xs">
                <strong>2.</strong> Jupyter server (JupyterLab or Jupyter Notebook) running locally
              </Typography>
              <Typography level="body-xs">
                <strong>3.</strong> Python environment with your desired packages installed
              </Typography>
            </Stack>
          </Box>
        </Alert>

        {/* Setup Instructions */}
        <Accordion defaultExpanded sx={{ backgroundColor: 'transparent', boxShadow: 'none' }}>
          <AccordionSummary
            indicator={<ExpandMore />}
            sx={{
              px: 0,
              '& .MuiAccordionSummary-button': {
                px: 0,
              },
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <Code sx={{ fontSize: 18 }} />
              <Typography level="title-sm">Setup Instructions</Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0 }}>
            <Stack spacing={2.5}>
              {/* Step 1: Start Jupyter */}
              <Box
                sx={theme => ({
                  backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : gray[850],
                  p: 2,
                  borderRadius: 'sm',
                  borderLeft: '3px solid',
                  borderColor: 'primary.500',
                })}
              >
                <Typography level="title-sm" sx={{ mb: 1 }}>
                  Step 1: Start your Jupyter server
                </Typography>
                <Box
                  component="pre"
                  sx={theme => ({
                    backgroundColor: theme.palette.mode === 'light' ? gray[100] : gray[900],
                    p: 1.5,
                    borderRadius: 'xs',
                    overflow: 'auto',
                    fontSize: '0.75rem',
                    fontFamily: 'monospace',
                    m: 0,
                  })}
                >
                  {`# Start JupyterLab (recommended)
jupyter lab --NotebookApp.token='' --NotebookApp.password=''

# Or use classic Jupyter Notebook
jupyter notebook --NotebookApp.token='' --NotebookApp.password=''`}
                </Box>
                <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 1 }}>
                  Disabling token/password allows the CLI to connect without authentication. For secure environments,
                  configure a static token instead.
                </Typography>
              </Box>

              {/* Step 2: Configure CLI */}
              <Box
                sx={theme => ({
                  backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : gray[850],
                  p: 2,
                  borderRadius: 'sm',
                  borderLeft: '3px solid',
                  borderColor: 'primary.500',
                })}
              >
                <Typography level="title-sm" sx={{ mb: 1 }}>
                  Step 2: Configure the B4M CLI
                </Typography>
                <Typography level="body-sm" sx={{ mb: 1.5 }}>
                  Set the following environment variables before starting the CLI:
                </Typography>
                <Box
                  component="pre"
                  sx={theme => ({
                    backgroundColor: theme.palette.mode === 'light' ? gray[100] : gray[900],
                    p: 1.5,
                    borderRadius: 'xs',
                    overflow: 'auto',
                    fontSize: '0.75rem',
                    fontFamily: 'monospace',
                    m: 0,
                  })}
                >
                  {`# Required: Jupyter server port (default: 8888)
export JUPYTER_PORT=8888

# Optional: Jupyter server host (default: localhost)
export JUPYTER_HOST=localhost

# Optional: Authentication token (if your server requires one)
export JUPYTER_TOKEN=your-token-here`}
                </Box>
              </Box>

              {/* Step 3: Run CLI */}
              <Box
                sx={theme => ({
                  backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : gray[850],
                  p: 2,
                  borderRadius: 'sm',
                  borderLeft: '3px solid',
                  borderColor: 'primary.500',
                })}
              >
                <Typography level="title-sm" sx={{ mb: 1 }}>
                  Step 3: Start the B4M CLI
                </Typography>
                <Box
                  component="pre"
                  sx={theme => ({
                    backgroundColor: theme.palette.mode === 'light' ? gray[100] : gray[900],
                    p: 1.5,
                    borderRadius: 'xs',
                    overflow: 'auto',
                    fontSize: '0.75rem',
                    fontFamily: 'monospace',
                    m: 0,
                  })}
                >
                  {`# Start the CLI with Jupyter configured
JUPYTER_PORT=8888 b4m

# Or add to your shell profile for persistence
echo 'export JUPYTER_PORT=8888' >> ~/.bashrc`}
                </Box>
              </Box>
            </Stack>
          </AccordionDetails>
        </Accordion>

        {/* Usage Guide */}
        <Accordion sx={{ backgroundColor: 'transparent', boxShadow: 'none' }}>
          <AccordionSummary
            indicator={<ExpandMore />}
            sx={{
              px: 0,
              '& .MuiAccordionSummary-button': {
                px: 0,
              },
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <Storage sx={{ fontSize: 18 }} />
              <Typography level="title-sm">How to Use</Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0 }}>
            <Stack spacing={2}>
              <Box
                sx={theme => ({
                  backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : gray[850],
                  p: 2,
                  borderRadius: 'sm',
                })}
              >
                <Stack spacing={1.5}>
                  <Typography level="body-sm">
                    <strong>1. Generate a notebook</strong> — In the chat, ask B4M to create a Python notebook:
                  </Typography>
                  <Box
                    sx={theme => ({
                      backgroundColor: theme.palette.mode === 'light' ? gray[100] : gray[900],
                      p: 1.5,
                      borderRadius: 'xs',
                      fontStyle: 'italic',
                    })}
                  >
                    <Typography level="body-xs" fontFamily="monospace">
                      &quot;Create a Python notebook that analyzes the iris dataset and generates a correlation
                      heatmap&quot;
                    </Typography>
                  </Box>

                  <Typography level="body-sm">
                    <strong>2. Click &quot;Run Notebook&quot;</strong> — After B4M generates the notebook, you&apos;ll
                    see a &quot;Run Notebook&quot; button below the code block.
                  </Typography>

                  <Typography level="body-sm">
                    <strong>3. Monitor progress</strong> — Watch the progress indicator as each cell executes.
                    You&apos;ll see the cell count and completion percentage.
                  </Typography>

                  <Typography level="body-sm">
                    <strong>4. View results</strong> — Once complete, you can download the executed notebook with all
                    outputs, or view the results in your local Jupyter server.
                  </Typography>
                </Stack>
              </Box>

              <Alert variant="soft" color="primary" sx={{ borderRadius: 'sm' }}>
                <Typography level="body-xs">
                  <strong>Tip:</strong> Keep your Jupyter server running in the background. The CLI will automatically
                  connect when you click &quot;Run Notebook&quot;.
                </Typography>
              </Alert>
            </Stack>
          </AccordionDetails>
        </Accordion>

        {/* Troubleshooting */}
        <Accordion sx={{ backgroundColor: 'transparent', boxShadow: 'none' }}>
          <AccordionSummary
            indicator={<ExpandMore />}
            sx={{
              px: 0,
              '& .MuiAccordionSummary-button': {
                px: 0,
              },
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <Settings sx={{ fontSize: 18 }} />
              <Typography level="title-sm">Troubleshooting</Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0 }}>
            <Stack spacing={2}>
              <Box
                sx={theme => ({
                  backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : gray[850],
                  p: 2,
                  borderRadius: 'sm',
                })}
              >
                <Stack spacing={2}>
                  <Box>
                    <Typography level="body-sm" fontWeight="bold" sx={{ mb: 0.5 }}>
                      &quot;No active connections available&quot;
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      The B4M CLI is not running or not connected. Start the CLI and ensure it shows &quot;Connected to
                      B4M&quot;.
                    </Typography>
                  </Box>

                  <Box>
                    <Typography level="body-sm" fontWeight="bold" sx={{ mb: 0.5 }}>
                      &quot;Jupyter server not responding&quot;
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      Check that your Jupyter server is running and the JUPYTER_PORT matches. Verify with: curl
                      http://localhost:8888/api
                    </Typography>
                  </Box>

                  <Box>
                    <Typography level="body-sm" fontWeight="bold" sx={{ mb: 0.5 }}>
                      &quot;Cell execution failed&quot;
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      The notebook may have missing dependencies. Install required packages in your Jupyter environment
                      (pip install package-name) and try again.
                    </Typography>
                  </Box>

                  <Box>
                    <Typography level="body-sm" fontWeight="bold" sx={{ mb: 0.5 }}>
                      &quot;Authentication required&quot;
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      Your Jupyter server requires a token. Set the JUPYTER_TOKEN environment variable in your CLI
                      session.
                    </Typography>
                  </Box>
                </Stack>
              </Box>
            </Stack>
          </AccordionDetails>
        </Accordion>
      </Stack>
    </SectionContainer>
  );
};

export default JupyterIntegrationSection;
