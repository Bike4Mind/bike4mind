import {
  useGetUserApiKeys,
  useCreateUserApiKey,
  useRotateUserApiKey,
  useRevokeUserApiKey,
  useBillingOrganizations,
  CreateUserApiKeyRequest,
} from '@client/app/hooks/data/userApiKeys';
import { useTheme } from '@mui/joy';
import {
  Box,
  CircularProgress,
  Table,
  Typography,
  Button,
  Chip,
  Tooltip,
  IconButton,
  Modal,
  ModalDialog,
  FormControl,
  FormLabel,
  Input,
  Stack,
  Select,
  Option,
  Alert,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Card,
  CardContent,
  Sheet,
  Accordion,
  AccordionGroup,
  AccordionSummary,
  AccordionDetails,
} from '@mui/joy';
import CheckIcon from '@mui/icons-material/Check';
import RefreshIcon from '@mui/icons-material/Refresh';
import { cardSurfaceSx, hairlineBorderColor, tableHeaderSx } from '@client/app/components/ProfileModal/settingsStyles';
import AddIcon from '@mui/icons-material/Add';
import RotateLeftIcon from '@mui/icons-material/RotateLeft';
import BlockIcon from '@mui/icons-material/Block';
import CopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import WarningIcon from '@mui/icons-material/Warning';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { IUserApiKeyDocument, ApiKeyScope } from '@bike4mind/common';
import { USER_API_KEY_SCOPES, GENERIC_MODAL_API_KEY_SCOPES } from '@client/app/constants/apiKeyScopes';
import { useState } from 'react';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { styled, alpha } from '@mui/system';

dayjs.extend(relativeTime);

const StyledTab = styled(Tab)(({ theme }) => ({
  borderBottomLeftRadius: '0',
  borderBottomRightRadius: '0',
  flexShrink: 0,
  whiteSpace: 'nowrap',
  '&:hover:not([aria-selected="true"])': {
    backgroundColor: `${theme.palette.notebooklist.hoverBg} !important`,
    '& .MuiTypography-root': {
      opacity: 1,
    },
  },
  '& .MuiTypography-root': {
    opacity: 0.7,
  },
  '&[aria-selected="true"] .MuiTypography-root': {
    opacity: 1,
  },
}));

// Scope presentation model derived from USER_API_KEY_SCOPES by parsing the
// resource:action convention, so new scopes surface here automatically.

const RESOURCE_LABELS: Record<string, string> = {
  notebooks: 'Notebooks',
  files: 'Files',
  projects: 'Projects',
  ai: 'AI',
  'marketing-reports': 'Marketing Reports',
};

const ACTION_LABELS: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  generate: 'Generate',
  chat: 'Chat',
};

const humanize = (s: string) =>
  s
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

interface ScopeGroup {
  resource: string;
  resourceLabel: string;
  scopes: {
    value: ApiKeyScope;
    actionLabel: string;
    description: string;
    isMutating: boolean;
  }[];
}

// The New-Key modal offers only generic-flow scopes; embed:chat is minted via
// the dedicated embed flow (epic #41 Phase E), so it is excluded from selection
// here (but still documented in the Scopes tab below via USER_API_KEY_SCOPES).
const MODAL_SCOPE_VALUES = GENERIC_MODAL_API_KEY_SCOPES.map(s => s.value);

const SCOPE_GROUPS: ScopeGroup[] = (() => {
  const groups = new Map<string, ScopeGroup>();
  for (const scope of GENERIC_MODAL_API_KEY_SCOPES) {
    const [resource, action = ''] = scope.value.split(':');
    if (!groups.has(resource)) {
      groups.set(resource, {
        resource,
        resourceLabel: RESOURCE_LABELS[resource] ?? humanize(resource),
        scopes: [],
      });
    }
    groups.get(resource)!.scopes.push({
      value: scope.value,
      actionLabel: ACTION_LABELS[action] ?? humanize(action),
      description: scope.description,
      isMutating: action !== 'read',
    });
  }
  return [...groups.values()];
})();

const READ_SCOPES = GENERIC_MODAL_API_KEY_SCOPES.filter(s => s.value.endsWith(':read')).map(s => s.value);
const WRITE_SCOPES = GENERIC_MODAL_API_KEY_SCOPES.filter(s => s.value.endsWith(':write')).map(s => s.value);

type PresetId = 'read' | 'readwrite' | 'full';

const PRESET_SCOPES: Record<PresetId, ApiKeyScope[]> = {
  read: READ_SCOPES,
  readwrite: [...READ_SCOPES, ...WRITE_SCOPES],
  full: [...MODAL_SCOPE_VALUES],
};

const PRESETS: { id: PresetId; label: string; description: string }[] = [
  { id: 'read', label: 'Read-only', description: 'View-only access to all resources. Safe default.' },
  { id: 'readwrite', label: 'Read & write', description: 'View and modify your data.' },
  { id: 'full', label: 'Full access', description: 'Everything, including AI generation & chat.' },
];

const sameScopeSet = (a: ApiKeyScope[], b: ApiKeyScope[]) => a.length === b.length && a.every(x => b.includes(x));

interface NewKeyModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (key: string) => void;
}

function NewKeyModal({ open, onClose, onSuccess }: NewKeyModalProps) {
  const [formData, setFormData] = useState<CreateUserApiKeyRequest>({
    name: '',
    scopes: [...READ_SCOPES],
    rateLimit: {
      requestsPerMinute: 60,
      requestsPerDay: 1000,
    },
  });
  const [expirationDays, setExpirationDays] = useState<string>('never');

  const { data: billingOrgs } = useBillingOrganizations();
  const canBillOrg = (billingOrgs?.length ?? 0) > 0;

  const createMutation = useCreateUserApiKey({
    onSuccess: result => {
      onSuccess(result.key);
      onClose();
      resetForm();
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      scopes: [...READ_SCOPES],
      rateLimit: {
        requestsPerMinute: 60,
        requestsPerDay: 1000,
      },
    });
    setExpirationDays('never');
  };

  const handleSubmit = () => {
    const submitData: CreateUserApiKeyRequest = {
      ...formData,
      expiresAt: expirationDays === 'never' ? undefined : dayjs().add(parseInt(expirationDays), 'days').toDate(),
    };
    createMutation.mutate(submitData);
  };

  const activePreset = PRESETS.find(p => sameScopeSet(formData.scopes, PRESET_SCOPES[p.id]))?.id;
  const isCustom = !activePreset;

  const applyPreset = (id: PresetId) => setFormData(fd => ({ ...fd, scopes: [...PRESET_SCOPES[id]] }));

  const toggleScope = (value: ApiKeyScope) =>
    setFormData(fd => ({
      ...fd,
      scopes: fd.scopes.includes(value) ? fd.scopes.filter(s => s !== value) : [...fd.scopes, value],
    }));

  const canSubmit = !!formData.name.trim() && formData.scopes.length > 0;

  return (
    <Modal open={open} onClose={onClose} className="project-api-keys-modal">
      <ModalDialog
        size="lg"
        sx={{ width: '600px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto' }}
        className="project-api-keys-modal-dialog"
      >
        <Typography level="h4" className="project-api-keys-modal-title">
          Create New API Key
        </Typography>
        <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 0.5, mb: 2 }}>
          Starts with read-only access. Add more only if you need it.
        </Typography>

        <Stack spacing={2.5} className="project-api-keys-modal-content">
          <FormControl required className="project-api-keys-name-control">
            <FormLabel className="project-api-keys-name-label">Name</FormLabel>
            <Input
              autoFocus
              placeholder="e.g., Production API, CI/CD Pipeline"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              data-testid="api-key-name-input"
              className="project-api-keys-name-input"
            />
          </FormControl>

          {canBillOrg && (
            <FormControl className="project-api-keys-billing-control">
              <FormLabel>Bill usage to</FormLabel>
              <Select
                value={formData.organizationId ?? 'personal'}
                onChange={(_, value) =>
                  setFormData(fd => ({
                    ...fd,
                    organizationId: value && value !== 'personal' ? (value as string) : undefined,
                  }))
                }
                data-testid="api-key-billing-select"
              >
                <Option value="personal">Personal (your credits)</Option>
                {billingOrgs?.map(org => (
                  <Option key={org.id} value={org.id}>
                    {org.name} (organization credits)
                  </Option>
                ))}
              </Select>
              <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 0.5 }}>
                {formData.organizationId
                  ? "This key's AI usage will debit the organization's shared credit pool."
                  : 'This key bills your personal credit balance.'}
              </Typography>
            </FormControl>
          )}

          <FormControl className="project-api-keys-access-level-control">
            <FormLabel>Access level</FormLabel>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {PRESETS.map(preset => {
                const selected = activePreset === preset.id;
                return (
                  <Tooltip key={preset.id} title={preset.description} variant="soft" size="sm">
                    <Chip
                      variant={selected ? 'solid' : 'outlined'}
                      color={selected ? 'primary' : 'neutral'}
                      onClick={() => applyPreset(preset.id)}
                      data-testid={`api-key-preset-${preset.id}`}
                      sx={{ '--Chip-radius': '8px', py: 0.5, px: 1.25 }}
                    >
                      {preset.label}
                    </Chip>
                  </Tooltip>
                );
              })}
              {isCustom && (
                <Chip variant="solid" color="warning" sx={{ '--Chip-radius': '8px' }}>
                  Custom
                </Chip>
              )}
            </Box>
          </FormControl>

          <Box className="project-api-keys-scopes-control">
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography level="title-sm">Permissions</Typography>
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                {formData.scopes.length} of {MODAL_SCOPE_VALUES.length} enabled
              </Typography>
            </Box>
            <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'hidden' }}>
              {SCOPE_GROUPS.map((group, i) => (
                <Box
                  key={group.resource}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    px: 1.5,
                    py: 1.25,
                    borderTop: i === 0 ? 'none' : '1px solid',
                    borderColor: 'divider',
                  }}
                  className="project-api-keys-scope-item"
                >
                  <Typography level="title-sm">{group.resourceLabel}</Typography>
                  <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {group.scopes.map(scope => {
                      const selected = formData.scopes.includes(scope.value);
                      return (
                        <Tooltip key={scope.value} title={scope.description} variant="soft" size="sm">
                          <Chip
                            variant={selected ? 'solid' : 'outlined'}
                            color={selected ? (scope.isMutating ? 'warning' : 'success') : 'neutral'}
                            startDecorator={selected ? <CheckIcon sx={{ fontSize: 14 }} /> : undefined}
                            onClick={() => toggleScope(scope.value)}
                            data-testid={`api-key-scope-${scope.value}`}
                            className="project-api-keys-scope-checkbox"
                            sx={{ '--Chip-radius': '8px' }}
                          >
                            {scope.actionLabel}
                          </Chip>
                        </Tooltip>
                      );
                    })}
                  </Box>
                </Box>
              ))}
            </Sheet>
          </Box>

          <AccordionGroup sx={{ '--Accordion-gap': '0px' }} className="project-api-keys-advanced">
            <Accordion>
              <AccordionSummary>
                <Typography level="title-sm">Advanced settings</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={2} sx={{ pt: 1 }}>
                  <FormControl className="project-api-keys-expiration-control">
                    <FormLabel className="project-api-keys-expiration-label">Expiration</FormLabel>
                    <Select
                      value={expirationDays}
                      onChange={(_, value) => setExpirationDays(value as string)}
                      className="project-api-keys-expiration-select"
                    >
                      <Option value="30">30 days</Option>
                      <Option value="90">90 days</Option>
                      <Option value="365">1 year</Option>
                      <Option value="never">Never expires</Option>
                    </Select>
                  </FormControl>

                  <Box className="project-api-keys-rate-limits-container">
                    <Typography level="title-sm" mb={1} className="project-api-keys-rate-limits-title">
                      Rate Limits
                    </Typography>
                    <Stack direction="row" spacing={2} className="project-api-keys-rate-limits-row">
                      <FormControl sx={{ flex: 1 }} className="project-api-keys-rate-limit-control">
                        <FormLabel className="project-api-keys-rate-limit-label">Requests per minute</FormLabel>
                        <Input
                          type="number"
                          value={formData.rateLimit?.requestsPerMinute}
                          onChange={e => {
                            const val = parseInt(e.target.value);
                            if (!isNaN(val) && val >= 0) {
                              setFormData({
                                ...formData,
                                rateLimit: { ...formData.rateLimit!, requestsPerMinute: val },
                              });
                            }
                          }}
                          className="project-api-keys-rate-limit-input"
                        />
                      </FormControl>
                      <FormControl sx={{ flex: 1 }}>
                        <FormLabel>Requests per day</FormLabel>
                        <Input
                          type="number"
                          value={formData.rateLimit?.requestsPerDay}
                          onChange={e => {
                            const val = parseInt(e.target.value);
                            if (!isNaN(val) && val >= 0) {
                              setFormData({
                                ...formData,
                                rateLimit: { ...formData.rateLimit!, requestsPerDay: val },
                              });
                            }
                          }}
                        />
                      </FormControl>
                    </Stack>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>
          </AccordionGroup>

          <Stack direction="row" spacing={2} justifyContent="flex-end" className="project-api-keys-modal-actions">
            <Button variant="outlined" onClick={onClose} className="project-api-keys-cancel-button">
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              loading={createMutation.isPending}
              disabled={!canSubmit}
              data-testid="api-key-create-btn"
              className="project-api-keys-create-button"
            >
              Create API Key
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}

interface KeyCreatedModalProps {
  open: boolean;
  onClose: () => void;
  apiKey: string;
}

function KeyCreatedModal({ open, onClose, apiKey }: KeyCreatedModalProps) {
  const { copied, handleCopyToClipboard } = useCopyToClipboard();
  const [showKey, setShowKey] = useState(false);
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';

  const handleCopy = () => {
    handleCopyToClipboard(apiKey);
  };

  const exampleCode = `curl -X POST \\
  -H "X-API-Key: ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello! Can you help me with my project?"}' \\
  https://your-deployment.example.com/api/chat`;

  return (
    <Modal open={open} onClose={onClose} className="project-api-keys-created-modal">
      <ModalDialog size="lg" className="project-api-keys-created-dialog">
        <Typography level="h4" mb={2} color="success" className="project-api-keys-created-title">
          🎉 API Key Created Successfully!
        </Typography>

        <Alert
          color="warning"
          startDecorator={<WarningIcon />}
          sx={{ mb: 2 }}
          className="project-api-keys-created-warning"
        >
          <Typography level="body-sm">
            <strong>Important:</strong> This is the only time you&apos;ll see this key. Copy it now and store it
            securely.
          </Typography>
        </Alert>

        <FormControl sx={{ mb: 2 }} className="project-api-keys-created-form">
          <FormLabel className="project-api-keys-created-label">Your API Key</FormLabel>
          <Box sx={{ display: 'flex', gap: 1 }} className="project-api-keys-created-input-group">
            <Input
              value={showKey ? apiKey : '•'.repeat(apiKey.length)}
              readOnly
              sx={{ flex: 1, fontFamily: 'monospace' }}
              className="project-api-keys-created-input"
            />
            <IconButton
              variant="outlined"
              onClick={() => setShowKey(!showKey)}
              size="sm"
              className="project-api-keys-created-visibility-button"
            >
              {showKey ? <VisibilityOffIcon /> : <VisibilityIcon />}
            </IconButton>
            <Button
              startDecorator={<CopyIcon />}
              onClick={handleCopy}
              variant="outlined"
              size="sm"
              className="project-api-keys-created-copy-button"
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </Box>
        </FormControl>

        <Alert
          color="primary"
          startDecorator={<InfoOutlinedIcon />}
          sx={{ mb: 2 }}
          className="project-api-keys-created-info"
        >
          <Stack spacing={1}>
            <Typography level="body-sm">
              <strong>Test your API key:</strong>
            </Typography>
            <Box
              component="pre"
              sx={{
                p: 1,
                bgcolor: isDarkMode ? 'neutral.900' : 'neutral.100',
                borderRadius: 'sm',
                fontSize: 'xs',
                overflow: 'auto',
                fontFamily: 'monospace',
              }}
              className="project-api-keys-documentation-code"
            >
              {exampleCode}
            </Box>
          </Stack>
        </Alert>

        <Stack direction="row" spacing={1} justifyContent="flex-end" className="project-api-keys-created-actions">
          <Button variant="outlined" onClick={onClose} className="project-api-keys-created-cancel-button">
            I&apos;ve Copied My Key
          </Button>
          <Button onClick={onClose} className="project-api-keys-created-continue-button">
            Continue
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}

interface ApiDocumentationProps {
  sampleApiKey?: string;
}

function ApiDocumentation({ sampleApiKey = 'b4m_live_your_api_key_here' }: ApiDocumentationProps) {
  const { handleCopyToClipboard } = useCopyToClipboard();
  const [activeTab, setActiveTab] = useState(0);

  const codeExamples = {
    curl: {
      listSessions: `curl -X GET \\
  -H "X-API-Key: ${sampleApiKey}" \\
  -H "Content-Type: application/json" \\
  https://your-deployment.example.com/api/sessions`,
      createSession: `curl -X POST \\
  -H "X-API-Key: ${sampleApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "My API Session"}' \\
  https://your-deployment.example.com/api/sessions/create`,
      aiChatSimple: `curl -X POST \\
  -H "X-API-Key: ${sampleApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "Hello! Can you help me with my project?",
    "model": "gpt-4o-mini",
    "temperature": 0.7,
    "max_tokens": 500
  }' \\
  https://your-deployment.example.com/api/chat`,
      aiChatSync: `curl -X POST \\
  -H "X-API-Key: ${sampleApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "What is the capital of France?",
    "model": "gpt-4o-mini",
    "wait": true
  }' \\
  https://your-deployment.example.com/api/chat`,
      questStatus: `curl -X GET \\
  -H "X-API-Key: ${sampleApiKey}" \\
  https://your-deployment.example.com/api/quests/quest_123`,
      aiChat: `curl -X POST \\
  -H "X-API-Key: ${sampleApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "sessionId": "your_session_id_here",
    "message": "Hello! Can you help me with my project?",
    "params": {
      "model": "gpt-4o-mini",
      "temperature": 0.7,
      "max_tokens": 500,
      "stream": false
    },
    "historyCount": 10,
    "fabFileIds": [],
    "messageFileIds": [],
    "promptMeta": {
      "session": {
        "id": "your_session_id_here",
        "name": "Your Session Name"
      }
    }
  }' \\
  https://your-deployment.example.com/api/ai/llm`,
    },
    javascript: {
      listSessions: `const response = await fetch('/api/sessions', {
  method: 'GET',
  headers: {
    'X-API-Key': '${sampleApiKey}',
    'Content-Type': 'application/json'
  }
});
const sessions = await response.json();`,
      createSession: `const response = await fetch('/api/sessions/create', {
  method: 'POST',
  headers: {
    'X-API-Key': '${sampleApiKey}',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'My API Session'
  })
});
const newSession = await response.json();`,
      aiChatSimple: `const response = await fetch('/api/chat', {
  method: 'POST',
  headers: {
    'X-API-Key': '${sampleApiKey}',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    message: 'Hello! How can you help me today?',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    max_tokens: 1000
  })
});
const result = await response.json();`,
      aiChatSync: `const response = await fetch('/api/chat', {
  method: 'POST',
  headers: {
    'X-API-Key': '${sampleApiKey}',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    message: 'What is the capital of France?',
    model: 'gpt-4o-mini',
    wait: true
  })
});
const result = await response.json();`,
      questStatus: `const response = await fetch('/api/quests/quest_123', {
  method: 'GET',
  headers: {
    'X-API-Key': '${sampleApiKey}'
  }
});
const quest = await response.json();`,
      aiChat: `const response = await fetch('/api/ai/llm', {
  method: 'POST',
  headers: {
    'X-API-Key': '${sampleApiKey}',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    sessionId: 'your_session_id',
    message: 'Hello! How can you help me today?',
    params: {
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 1000
    }
  })
});
const aiResponse = await response.json();`,
    },
    python: {
      listSessions: `import requests

headers = {
    'X-API-Key': '${sampleApiKey}',
    'Content-Type': 'application/json'
}

response = requests.get('/api/sessions', headers=headers)
sessions = response.json()`,
      createSession: `import requests

headers = {
    'X-API-Key': '${sampleApiKey}',
    'Content-Type': 'application/json'
}

data = {'name': 'My API Session'}
response = requests.post('/api/sessions/create', 
                        headers=headers, json=data)
new_session = response.json()`,
      aiChatSimple: `import requests

headers = {
    'X-API-Key': '${sampleApiKey}',
    'Content-Type': 'application/json'
}

data = {
    'message': 'Hello! How can you help me today?',
    'model': 'gpt-4o-mini',
    'temperature': 0.7,
    'max_tokens': 1000
}

response = requests.post('/api/chat', headers=headers, json=data)
result = response.json()`,
      aiChatSync: `import requests

headers = {
    'X-API-Key': '${sampleApiKey}',
    'Content-Type': 'application/json'
}

data = {
    'message': 'What is the capital of France?',
    'model': 'gpt-4o-mini',
    'wait': True
}

response = requests.post('/api/chat', headers=headers, json=data)
result = response.json()`,
      questStatus: `import requests

headers = {
    'X-API-Key': '${sampleApiKey}'
}

response = requests.get('/api/quests/quest_123', headers=headers)
quest = response.json()`,
      aiChat: `import requests

headers = {
    'X-API-Key': '${sampleApiKey}',
    'Content-Type': 'application/json'
}

data = {
    'sessionId': 'your_session_id',
    'message': 'Hello! How can you help me today?',
    'params': {
        'model': 'gpt-4o-mini',
        'temperature': 0.7,
        'max_tokens': 1000
    }
}

response = requests.post('/api/ai/llm', headers=headers, json=data)
ai_response = response.json()`,
    },
  };

  const scopeDescriptions = USER_API_KEY_SCOPES;

  const copyCode = (code: string) => {
    handleCopyToClipboard(code);
  };

  return (
    <Box className="project-api-keys-documentation-container">
      <Tabs
        value={activeTab}
        onChange={(_, value) => setActiveTab(value as number)}
        className="project-api-keys-documentation-tabs"
      >
        <TabList sx={{ gap: 1, mb: '20px', flexWrap: 'wrap' }}>
          <StyledTab>Quick Start</StyledTab>
          <StyledTab>Endpoints</StyledTab>
          <StyledTab>Scopes</StyledTab>
          <StyledTab>Examples</StyledTab>
        </TabList>

        <TabPanel value={0} className="project-api-keys-documentation-tabpanel">
          <Stack spacing={3}>
            <Alert
              color="primary"
              variant="soft"
              sx={theme => ({
                backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : undefined, // gray[25]
                alignSelf: 'flex-start',
                width: 'fit-content',
                p: 2,
              })}
            >
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                <InfoOutlinedIcon sx={{ fontSize: '20px', color: 'text.primary', mt: 0.5, opacity: 0.5 }} />
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  Use your API key to authenticate requests by adding it to the <code>X-API-Key</code> header. The{' '}
                  <code>/api/chat</code> endpoint supports both asynchronous (returns quest ID for tracking) and
                  synchronous modes (add <code>&quot;wait&quot;: true</code> to get the response immediately). Sessions
                  automatically use your most recent notebook if no <code>sessionId</code> is provided.
                </Typography>
              </Box>
            </Alert>

            <Card
              className="project-api-keys-documentation-card"
              sx={theme => ({
                backgroundColor: 'primary.softBg',
                border: '1px solid',
                borderColor: hairlineBorderColor(theme),
                borderRadius: '8px',
              })}
            >
              <CardContent className="project-api-keys-documentation-card-content">
                <Typography level="title-md" sx={{ mb: 2 }} className="project-api-keys-documentation-card-title">
                  1. Test Your Connection
                </Typography>
                <Box sx={{ position: 'relative' }} className="project-api-keys-documentation-code-container">
                  <Box
                    component="pre"
                    sx={{
                      p: 2,
                      bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                      color: 'text.primary',
                      borderRadius: 'sm',
                      fontSize: 'sm',
                      overflow: 'auto',
                      fontFamily: 'monospace',
                      marginBlock: 0,
                    }}
                    className="project-api-keys-documentation-code"
                  >
                    {codeExamples.curl.listSessions}
                  </Box>
                  <IconButton
                    size="sm"
                    variant="outlined"
                    sx={{ position: 'absolute', top: 8, right: 8 }}
                    onClick={() => copyCode(codeExamples.curl.listSessions)}
                    className="project-api-keys-documentation-copy-button"
                  >
                    <CopyIcon />
                  </IconButton>
                </Box>
              </CardContent>
            </Card>

            <Card
              sx={theme => ({
                backgroundColor: 'primary.softBg',
                border: '1px solid',
                borderColor: hairlineBorderColor(theme),
                borderRadius: '8px',
              })}
            >
              <CardContent>
                <Typography level="title-md" sx={{ mb: 2 }}>
                  2. Create a Notebook
                </Typography>
                <Box sx={{ position: 'relative' }} className="project-api-keys-documentation-example-code-container">
                  <Box
                    component="pre"
                    sx={{
                      p: 2,
                      bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                      color: 'text.primary',
                      borderRadius: 'sm',
                      fontSize: 'sm',
                      overflow: 'auto',
                      fontFamily: 'monospace',
                      marginBlock: 0,
                    }}
                  >
                    {codeExamples.curl.createSession}
                  </Box>
                  <IconButton
                    size="sm"
                    variant="outlined"
                    sx={{ position: 'absolute', top: 8, right: 8 }}
                    onClick={() => copyCode(codeExamples.curl.createSession)}
                  >
                    <CopyIcon />
                  </IconButton>
                </Box>
              </CardContent>
            </Card>

            <Card
              sx={theme => ({
                backgroundColor: 'primary.softBg',
                border: '1px solid',
                borderColor: hairlineBorderColor(theme),
                borderRadius: '8px',
              })}
            >
              <CardContent>
                <Typography level="title-md" sx={{ mb: 2 }}>
                  3. Chat with AI
                </Typography>
                <Box sx={{ position: 'relative' }}>
                  <Box
                    component="pre"
                    sx={{
                      p: 2,
                      bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                      color: 'text.primary',
                      borderRadius: 'sm',
                      fontSize: 'sm',
                      overflow: 'auto',
                      fontFamily: 'monospace',
                      marginBlock: 0,
                    }}
                  >
                    {codeExamples.curl.aiChatSimple}
                  </Box>
                  <IconButton
                    size="sm"
                    variant="outlined"
                    sx={{ position: 'absolute', top: 8, right: 8 }}
                    onClick={() => copyCode(codeExamples.curl.aiChatSimple)}
                  >
                    <CopyIcon />
                  </IconButton>

                  <Typography
                    level="body-xs"
                    sx={{
                      mt: '16px',
                      fontStyle: 'italic',
                      color: theme => alpha(theme.palette.text.primary, 0.5),
                    }}
                  >
                    <strong>Tip:</strong> Add <code>&quot;sessionId&quot;: &quot;your_session_id&quot;</code> to chat
                    with a specific notebook instead of your most recent one.
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          </Stack>
        </TabPanel>

        <TabPanel value={1} className="project-api-keys-documentation-tabpanel">
          <Stack spacing={2} className="project-api-keys-documentation-stack">
            <Box sx={{ overflowX: 'auto' }}>
              <Table
                className="project-api-keys-documentation-table"
                sx={{
                  minWidth: 680,
                  tableLayout: 'auto',
                  '& thead th': { ...tableHeaderSx, whiteSpace: 'nowrap' },
                  '& td:nth-of-type(2)': { whiteSpace: 'nowrap' },
                }}
              >
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Endpoint</th>
                    <th>Description</th>
                    <th>Required Scopes</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <Chip size="sm" color="primary">
                        GET
                      </Chip>
                    </td>
                    <td>
                      <code>/api/sessions</code>
                    </td>
                    <td>List your notebooks</td>
                    <td>
                      <Chip size="sm" variant="soft">
                        notebooks:read
                      </Chip>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <Chip size="sm" color="success">
                        POST
                      </Chip>
                    </td>
                    <td>
                      <code>/api/sessions/create</code>
                    </td>
                    <td>Create a new notebook</td>
                    <td>
                      <Chip size="sm" variant="soft">
                        notebooks:write
                      </Chip>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <Chip size="sm" color="success">
                        POST
                      </Chip>
                    </td>
                    <td>
                      <code>/api/chat</code>
                    </td>
                    <td>Send AI chat message (simplified)</td>
                    <td>
                      <Chip size="sm" variant="soft">
                        ai:chat
                      </Chip>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <Chip size="sm" color="primary">
                        GET
                      </Chip>
                    </td>
                    <td>
                      <code>/api/quests/:id</code>
                    </td>
                    <td>Check quest status and retrieve results</td>
                    <td>
                      <Chip size="sm" variant="soft">
                        ai:chat
                      </Chip>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <Chip size="sm" color="success">
                        POST
                      </Chip>
                    </td>
                    <td>
                      <code>/api/ai/llm</code>
                    </td>
                    <td>Send AI chat message (advanced)</td>
                    <td>
                      <Chip size="sm" variant="soft">
                        ai:chat
                      </Chip>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <Chip size="sm" color="primary">
                        GET
                      </Chip>
                    </td>
                    <td>
                      <code>/api/files</code>
                    </td>
                    <td>List your files</td>
                    <td>
                      <Chip size="sm" variant="soft">
                        files:read
                      </Chip>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <Chip size="sm" color="success">
                        POST
                      </Chip>
                    </td>
                    <td>
                      <code>/api/files</code>
                    </td>
                    <td>Upload a file</td>
                    <td>
                      <Chip size="sm" variant="soft">
                        files:write
                      </Chip>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <Chip size="sm" color="primary">
                        GET
                      </Chip>
                    </td>
                    <td>
                      <code>/api/projects</code>
                    </td>
                    <td>List your projects</td>
                    <td>
                      <Chip size="sm" variant="soft">
                        projects:read
                      </Chip>
                    </td>
                  </tr>
                </tbody>
              </Table>
            </Box>
          </Stack>
        </TabPanel>

        <TabPanel value={2} className="project-api-keys-documentation-tabpanel">
          <Stack spacing={2} className="project-api-keys-documentation-stack">
            <Typography level="body-sm" sx={{ mt: 0, color: 'text.primary' }}>
              Each API key can have different permissions (scopes). Make sure your key has the right scopes for the
              endpoints you want to access.
            </Typography>

            <Stack spacing={2} className="project-api-keys-documentation-scope-list">
              {scopeDescriptions.map(item => (
                <Card
                  key={item.value}
                  variant="outlined"
                  className="project-api-keys-documentation-scope-card"
                  sx={theme => ({
                    backgroundColor: 'primary.softBg',
                    border: '1px solid',
                    borderColor: hairlineBorderColor(theme),
                    borderRadius: '8px',
                  })}
                >
                  <CardContent>
                    <Stack direction="row" alignItems="center" spacing={0} sx={{ mb: 1, gap: '16px' }}>
                      <Chip variant="soft" color="primary" sx={{ p: 0, color: 'text.primary', fontSize: '16px' }}>
                        {item.value}
                      </Chip>
                      <Typography
                        level="body-md"
                        sx={{
                          p: 0,
                          ml: 0,
                          fontSize: '14px',
                          color: theme => alpha(theme.palette.text.primary, 0.5),
                        }}
                      >
                        {item.description}
                      </Typography>
                    </Stack>
                    <Typography level="body-xs" sx={{ color: theme => alpha(theme.palette.text.primary, 0.5) }}>
                      <strong>Endpoints:</strong> {item.endpoints.join(', ')}
                    </Typography>
                  </CardContent>
                </Card>
              ))}
            </Stack>
          </Stack>
        </TabPanel>

        <TabPanel value={3} className="project-api-keys-documentation-tabpanel">
          <Stack spacing={3} className="project-api-keys-documentation-stack">
            <Tabs defaultValue={0} className="project-api-keys-documentation-example-tabs">
              <TabList className="project-api-keys-documentation-example-tablist" sx={{ gap: '2px', mb: '20px' }}>
                <StyledTab className="project-api-keys-documentation-example-tab">cURL</StyledTab>
                <StyledTab className="project-api-keys-documentation-example-tab">JavaScript</StyledTab>
                <StyledTab className="project-api-keys-documentation-example-tab">Python</StyledTab>
              </TabList>

              <TabPanel value={0} className="project-api-keys-documentation-example-tabpanel">
                <Stack spacing={2}>
                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        List Sessions
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                            marginBlock: 0,
                          }}
                        >
                          {codeExamples.curl.listSessions}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.curl.listSessions)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>
                    </CardContent>
                  </Card>

                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        Chat with AI (Simplified)
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                            marginBlock: 0,
                          }}
                        >
                          {codeExamples.curl.aiChatSimple}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.curl.aiChatSimple)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>

                      <Typography
                        level="body-xs"
                        sx={{
                          mt: '16px',
                          fontStyle: 'italic',
                          color: theme => alpha(theme.palette.text.primary, 0.5),
                        }}
                      >
                        <strong>Tip:</strong> Add <code>&quot;sessionId&quot;: &quot;your_session_id&quot;</code> to
                        chat with a specific notebook instead of your most recent one.
                      </Typography>

                      <Typography
                        level="body-xs"
                        sx={{
                          mt: '8px',
                          fontStyle: 'italic',
                          color: theme => alpha(theme.palette.text.primary, 0.5),
                        }}
                      >
                        <strong>Response:</strong>{' '}
                        <code>{`{"id": "quest_123", "status": "queued", "message_received": true}`}</code>
                      </Typography>
                    </CardContent>
                  </Card>

                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        Chat with AI (Synchronous)
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                            marginBlock: 0,
                          }}
                        >
                          {codeExamples.curl.aiChatSync}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.curl.aiChatSync)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>

                      <Typography
                        level="body-xs"
                        sx={{
                          mt: '16px',
                          fontStyle: 'italic',
                          color: theme => alpha(theme.palette.text.primary, 0.5),
                        }}
                      >
                        <strong>Synchronous Mode:</strong> Add <code>&quot;wait&quot;: true</code> to wait for the AI
                        response before the API returns.
                      </Typography>
                    </CardContent>
                  </Card>

                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        Check Quest Status
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                            marginBlock: 0,
                          }}
                        >
                          {codeExamples.curl.questStatus}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.curl.questStatus)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>

                      <Typography
                        level="body-xs"
                        sx={{
                          mt: '16px',
                          fontStyle: 'italic',
                          color: theme => alpha(theme.palette.text.primary, 0.5),
                        }}
                      >
                        <strong>Quest Tracking:</strong> Use the quest ID from async requests to check status and
                        retrieve results.
                      </Typography>
                    </CardContent>
                  </Card>
                </Stack>
              </TabPanel>

              <TabPanel value={1}>
                <Stack spacing={2}>
                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        List Sessions
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            marginBlock: 0,
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                          }}
                        >
                          {codeExamples.javascript.listSessions}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.javascript.listSessions)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>
                    </CardContent>
                  </Card>

                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        Chat with AI (Simplified)
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            marginBlock: 0,
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                          }}
                        >
                          {codeExamples.javascript.aiChatSimple}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.javascript.aiChatSimple)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>
                    </CardContent>
                  </Card>

                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        Chat with AI (Synchronous)
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            marginBlock: 0,
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                          }}
                        >
                          {codeExamples.javascript.aiChatSync}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.javascript.aiChatSync)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>
                    </CardContent>
                  </Card>

                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        Check Quest Status
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            marginBlock: 0,
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                          }}
                        >
                          {codeExamples.javascript.questStatus}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.javascript.questStatus)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>
                    </CardContent>
                  </Card>
                </Stack>
              </TabPanel>

              <TabPanel value={2}>
                <Stack spacing={2}>
                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        List Sessions
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            marginBlock: 0,
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                          }}
                        >
                          {codeExamples.python.listSessions}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.python.listSessions)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>
                    </CardContent>
                  </Card>

                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        Chat with AI (Simplified)
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            marginBlock: 0,
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                          }}
                        >
                          {codeExamples.python.aiChatSimple}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.python.aiChatSimple)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>
                    </CardContent>
                  </Card>

                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        Chat with AI (Synchronous)
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            marginBlock: 0,
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                          }}
                        >
                          {codeExamples.python.aiChatSync}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.python.aiChatSync)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>
                    </CardContent>
                  </Card>

                  <Card
                    sx={theme => ({
                      backgroundColor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: hairlineBorderColor(theme),
                      borderRadius: '8px',
                    })}
                  >
                    <CardContent>
                      <Typography level="title-md" sx={{ mb: 2 }}>
                        Check Quest Status
                      </Typography>
                      <Box sx={{ position: 'relative' }}>
                        <Box
                          component="pre"
                          sx={{
                            p: 2,
                            bgcolor: theme => (theme.palette.mode === 'dark' ? '#0E1214' : '#F4F7F9'),
                            color: 'text.primary',
                            marginBlock: 0,
                            borderRadius: 'sm',
                            fontSize: 'sm',
                            overflow: 'auto',
                            fontFamily: 'monospace',
                          }}
                        >
                          {codeExamples.python.questStatus}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          sx={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => copyCode(codeExamples.python.questStatus)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </Box>
                    </CardContent>
                  </Card>
                </Stack>
              </TabPanel>
            </Tabs>
          </Stack>
        </TabPanel>
      </Tabs>
    </Box>
  );
}

export default function UserApiKeysTab() {
  const { data, isLoading, error, refetch } = useGetUserApiKeys();
  const { data: billingOrgs } = useBillingOrganizations();
  const orgNameById = new Map((billingOrgs ?? []).map(org => [org.id, org.name]));
  const [showNewKeyModal, setShowNewKeyModal] = useState(false);
  const [showKeyCreatedModal, setShowKeyCreatedModal] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState('');
  const [mainTab, setMainTab] = useState(0);

  const rotateMutation = useRotateUserApiKey({
    onSuccess: result => {
      setNewlyCreatedKey(result.key);
      setShowKeyCreatedModal(true);
    },
  });

  const revokeMutation = useRevokeUserApiKey();

  const handleNewKeySuccess = (key: string) => {
    setNewlyCreatedKey(key);
    setShowKeyCreatedModal(true);
  };

  const getStatusColor = (key: IUserApiKeyDocument) => {
    if (key.status === 'disabled') return 'danger';
    if (key.expiresAt && dayjs(key.expiresAt).isBefore(dayjs())) return 'warning';
    return 'success';
  };

  const getStatusText = (key: IUserApiKeyDocument) => {
    if (key.status === 'disabled') return 'Disabled';
    if (key.expiresAt && dayjs(key.expiresAt).isBefore(dayjs())) return 'Expired';
    return 'Active';
  };

  return (
    <Box
      sx={theme => ({
        ...cardSurfaceSx(theme),
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        padding: '1.25rem',
        height: '100%',
        overflow: 'auto',
      })}
    >
      <Tabs value={mainTab} onChange={(_, value) => setMainTab(value as number)}>
        <TabList sx={{ gap: '2px', mb: '20px', flexWrap: 'wrap' }}>
          <StyledTab>My API Keys</StyledTab>
          <StyledTab>API Documentation</StyledTab>
        </TabList>

        <TabPanel value={0}>
          <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1.5} mb={2}>
            <Typography level="title-md" sx={{ color: 'text.primary' }}>
              Manage Your API Keys
            </Typography>
            <Box display="flex" gap={1} flexShrink={0}>
              <Tooltip title="Refresh">
                <IconButton onClick={() => refetch()} variant="outlined">
                  <RefreshIcon />
                </IconButton>
              </Tooltip>
              <Button startDecorator={<AddIcon />} onClick={() => setShowNewKeyModal(true)} variant="solid">
                Create API Key
              </Button>
            </Box>
          </Box>

          {isLoading ? (
            <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
              <CircularProgress />
            </Box>
          ) : error ? (
            <Box p={2}>
              <Typography color="danger">Error loading API keys</Typography>
              <Button onClick={() => refetch()} variant="soft" sx={{ mt: 2 }}>
                Retry
              </Button>
            </Box>
          ) : data?.length === 0 ? (
            <Alert color="neutral" startDecorator={<InfoOutlinedIcon />}>
              <Typography>
                You don&apos;t have any API keys yet. Create one to get started with programmatic access to your
                account.
              </Typography>
            </Alert>
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table
                stickyHeader
                hoverRow
                sx={{
                  minWidth: 860,
                  tableLayout: 'auto',
                  '& th, & td': { whiteSpace: 'nowrap' },
                  '& thead th': tableHeaderSx,
                }}
              >
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Billing</th>
                    <th>Key Prefix</th>
                    <th>Scopes</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Last Used</th>
                    <th>Expires</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.map(key => (
                    <tr key={key.id}>
                      <td>
                        <Typography fontWeight="lg">{key.name}</Typography>
                      </td>
                      <td>
                        {key.organizationId ? (
                          <Tooltip
                            title={`Usage bills the ${orgNameById.get(key.organizationId) ?? 'organization'} credit pool`}
                            variant="soft"
                            size="sm"
                          >
                            <Chip size="sm" variant="soft" color="primary" data-testid="api-key-billing-badge">
                              {orgNameById.get(key.organizationId) ?? 'Organization'}
                            </Chip>
                          </Tooltip>
                        ) : (
                          <Chip size="sm" variant="soft" color="neutral" data-testid="api-key-billing-badge">
                            Personal
                          </Chip>
                        )}
                      </td>
                      <td>
                        <Typography fontFamily="monospace" fontSize="sm">
                          {key.keyPrefix}•••
                        </Typography>
                      </td>
                      <td>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                          {key.scopes.slice(0, 2).map(scope => (
                            <Chip key={scope} size="sm" variant="soft">
                              {scope.split(':')[1]}
                            </Chip>
                          ))}
                          {key.scopes.length > 2 && (
                            <Chip size="sm" variant="soft" color="neutral">
                              +{key.scopes.length - 2}
                            </Chip>
                          )}
                        </Box>
                      </td>
                      <td>
                        <Chip variant="soft" color={getStatusColor(key)}>
                          {getStatusText(key)}
                        </Chip>
                      </td>
                      <td>
                        <Typography level="body-xs">{dayjs(key.createdAt).format('MMM D, YYYY')}</Typography>
                      </td>
                      <td>
                        <Typography level="body-xs" color="neutral">
                          {key.lastUsedAt ? dayjs(key.lastUsedAt).fromNow() : 'Never'}
                        </Typography>
                      </td>
                      <td>
                        <Typography
                          level="body-xs"
                          color={key.expiresAt && dayjs(key.expiresAt).isBefore(dayjs()) ? 'danger' : 'neutral'}
                        >
                          {key.expiresAt ? dayjs(key.expiresAt).format('MMM D, YYYY') : 'Never'}
                        </Typography>
                      </td>
                      <td>
                        <Box display="flex" gap={1}>
                          <Tooltip title="Rotate key">
                            <IconButton
                              size="sm"
                              variant="outlined"
                              onClick={() => rotateMutation.mutate(key.id)}
                              loading={rotateMutation.isPending}
                              disabled={key.status === 'disabled'}
                            >
                              <RotateLeftIcon />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Revoke key">
                            <IconButton
                              size="sm"
                              variant="outlined"
                              color="danger"
                              onClick={() => revokeMutation.mutate({ keyId: key.id, reason: 'Revoked by user' })}
                              loading={revokeMutation.isPending}
                              disabled={key.status === 'disabled'}
                            >
                              <BlockIcon />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Box>
          )}
        </TabPanel>

        <TabPanel value={1}>
          <ApiDocumentation sampleApiKey={data?.[0]?.keyPrefix ? `${data[0].keyPrefix}...` : undefined} />
        </TabPanel>
      </Tabs>

      <NewKeyModal open={showNewKeyModal} onClose={() => setShowNewKeyModal(false)} onSuccess={handleNewKeySuccess} />

      <KeyCreatedModal
        open={showKeyCreatedModal}
        onClose={() => setShowKeyCreatedModal(false)}
        apiKey={newlyCreatedKey}
      />
    </Box>
  );
}
