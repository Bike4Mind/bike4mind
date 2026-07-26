import {
  Typography,
  Box,
  Stack,
  Alert,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Input,
  Button,
} from '@mui/joy';
import {
  Science as JupyterIcon,
  PlayArrow,
  CheckCircle,
  ExpandMore,
  Code,
  Storage,
  Settings,
  LinkOff,
} from '@mui/icons-material';
import { useState, useCallback } from 'react';
import SectionContainer from '../SectionContainer';
import { gray } from '../../../utils/themes/colors';
import {
  JupyterBrowserClient,
  getStoredJupyterConfig,
  setStoredJupyterConfig,
  clearStoredJupyterConfig,
} from '../../../utils/jupyterBrowserClient';

/**
 * Setup guide and configuration for executing AI-generated Jupyter notebooks
 * on the user's local Jupyter server directly from the browser.
 */
const JupyterIntegrationSection = () => {
  const initialConfig = getStoredJupyterConfig();
  const [serverUrl, setServerUrl] = useState(() => initialConfig?.serverUrl || '');
  const [token, setToken] = useState(() => initialConfig?.token || '');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testError, setTestError] = useState('');
  const [isConfigured, setIsConfigured] = useState(() => !!initialConfig);

  const handleSave = useCallback(() => {
    if (!serverUrl.trim()) return;
    setStoredJupyterConfig({ serverUrl: serverUrl.trim(), token: token.trim() });
    setIsConfigured(true);
  }, [serverUrl, token]);

  const handleDisconnect = useCallback(() => {
    clearStoredJupyterConfig();
    setServerUrl('');
    setToken('');
    setIsConfigured(false);
    setTestStatus('idle');
  }, []);

  const handleTestConnection = useCallback(async () => {
    if (!serverUrl.trim()) return;
    setTestStatus('testing');
    setTestError('');

    try {
      const client = new JupyterBrowserClient({
        serverUrl: serverUrl.trim(),
        token: token.trim() || undefined,
      });
      await client.checkStatus();
      setTestStatus('success');
      // Auto-save on successful test
      handleSave();
    } catch (err) {
      setTestStatus('error');
      setTestError(err instanceof Error ? err.message : 'Connection failed');
    }
  }, [serverUrl, token, handleSave]);

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
        <Chip
          size="sm"
          variant="soft"
          color={isConfigured ? 'success' : 'neutral'}
          startDecorator={isConfigured ? <CheckCircle sx={{ fontSize: 14 }} /> : <LinkOff sx={{ fontSize: 14 }} />}
        >
          {isConfigured ? 'Connected' : 'Not configured'}
        </Chip>
      }
    >
      <Stack spacing={3}>
        {/* Connection Config */}
        <Box
          sx={theme => ({
            backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : gray[850],
            p: 2.5,
            borderRadius: 'sm',
          })}
        >
          <Typography level="title-sm" sx={{ mb: 2 }}>
            Jupyter Server Connection
          </Typography>
          <Stack spacing={2}>
            <Box>
              <Typography level="body-xs" sx={{ mb: 0.5, fontWeight: 'bold' }}>
                Server URL
              </Typography>
              <Input
                size="sm"
                placeholder="http://localhost:8888"
                value={serverUrl}
                onChange={e => {
                  setServerUrl(e.target.value);
                  setTestStatus('idle');
                }}
                sx={{ fontFamily: 'monospace' }}
                data-testid="jupyter-server-url-input"
              />
            </Box>
            <Box>
              <Typography level="body-xs" sx={{ mb: 0.5, fontWeight: 'bold' }}>
                Token (optional)
              </Typography>
              <Input
                size="sm"
                type="password"
                placeholder="Leave empty if auth is disabled"
                value={token}
                onChange={e => {
                  setToken(e.target.value);
                  setTestStatus('idle');
                }}
                sx={{ fontFamily: 'monospace' }}
                data-testid="jupyter-token-input"
              />
            </Box>

            {testStatus === 'success' && (
              <Alert variant="soft" color="success" size="sm">
                Connected successfully
              </Alert>
            )}
            {testStatus === 'error' && (
              <Alert variant="soft" color="danger" size="sm">
                {testError || 'Connection failed'}
              </Alert>
            )}

            <Stack direction="row" spacing={1}>
              <Button
                size="sm"
                variant="solid"
                color="primary"
                onClick={handleTestConnection}
                loading={testStatus === 'testing'}
                disabled={!serverUrl.trim()}
                data-testid="jupyter-test-connection-btn"
              >
                Test & Save
              </Button>
              {isConfigured && (
                <Button
                  size="sm"
                  variant="outlined"
                  color="danger"
                  onClick={handleDisconnect}
                  data-testid="jupyter-disconnect-btn"
                >
                  Disconnect
                </Button>
              )}
            </Stack>
          </Stack>
        </Box>

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
                  <strong>One-click execution</strong> — Run generated notebooks directly from the browser with a single
                  click
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
                <CheckCircle sx={{ fontSize: 16, color: 'success.500', mt: 0.25 }} />
                <Typography level="body-sm">
                  <strong>Real-time progress</strong> — Watch cell execution progress with live updates
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
                  Step 1: Start your Jupyter server with CORS enabled
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
                  {`# JupyterLab (recommended)
jupyter lab --ServerApp.allow_origin='*' \\
  --ServerApp.token='' --ServerApp.password=''

# Or classic Jupyter Notebook
jupyter notebook --NotebookApp.allow_origin='*' \\
  --NotebookApp.token='' --NotebookApp.password=''`}
                </Box>
                <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 1 }}>
                  The <code>allow_origin</code> flag lets the browser connect to your local Jupyter server. For secure
                  environments, set a token and enter it above.
                </Typography>
              </Box>

              {/* Step 2: Configure */}
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
                  Step 2: Enter your server URL above and click &quot;Test &amp; Save&quot;
                </Typography>
                <Typography level="body-sm">
                  The default URL is <code>http://localhost:8888</code>. If you changed the port, update it accordingly.
                </Typography>
              </Box>

              {/* Step 3: Use */}
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
                  Step 3: Generate and run notebooks from the chat
                </Typography>
                <Typography level="body-sm">
                  Ask B4M to create a Python notebook, then click &quot;Execute Locally&quot; to run it on your machine.
                </Typography>
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
                    <strong>2. Click &quot;Execute Locally&quot;</strong> — After B4M generates the notebook, click the
                    button below the code block to run it.
                  </Typography>

                  <Typography level="body-sm">
                    <strong>3. Monitor progress</strong> — Watch the progress indicator as each cell executes.
                  </Typography>

                  <Typography level="body-sm">
                    <strong>4. View results</strong> — Once complete, you can download the executed notebook with all
                    outputs, or view the results in your local Jupyter server.
                  </Typography>
                </Stack>
              </Box>
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
                      &quot;WebSocket connection failed&quot; or CORS errors
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      Make sure you started Jupyter with <code>--ServerApp.allow_origin=&apos;*&apos;</code> (or{' '}
                      <code>--NotebookApp.allow_origin=&apos;*&apos;</code> for classic Notebook). This allows the
                      browser to connect.
                    </Typography>
                  </Box>

                  <Box>
                    <Typography level="body-sm" fontWeight="bold" sx={{ mb: 0.5 }}>
                      &quot;Jupyter API error: 403&quot;
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      Your Jupyter server requires a token. Either disable the token (
                      <code>--ServerApp.token=&apos;&apos;</code>) or enter your token in the settings above.
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
                      Connection times out
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      Verify your Jupyter server is running: open the server URL in a new browser tab. You should see
                      the Jupyter interface.
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
