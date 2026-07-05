import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Box,
  Typography,
  Stack,
  Card,
  Input,
  Textarea,
  Select,
  Option,
  Button,
  FormControl,
  FormLabel,
  Chip,
  Alert,
  CircularProgress,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Switch,
  Divider,
  IconButton,
} from '@mui/joy';
import {
  Save as SaveIcon,
  Preview as PreviewIcon,
  Close as CloseIcon,
  Add as AddIcon,
  Remove as RemoveIcon,
  Lock as LockIcon,
  Public as PublicIcon,
  Group as GroupIcon,
} from '@mui/icons-material';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { type BaseArtifact } from '@bike4mind/common';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface ArtifactType {
  type: string;
  name: string;
  description: string;
  category: string;
}

interface ArtifactTypesResponse {
  types: ArtifactType[];
  categories: string[];
}

interface CreateArtifactRequest {
  type: string;
  title: string;
  description?: string;
  content: string;
  projectId?: string;
  organizationId?: string;
  visibility: 'private' | 'project' | 'organization' | 'public';
  tags: string[];
  versionTag?: string;
  sourceQuestId?: string;
  sessionId?: string;
  parentArtifactId?: string;
  permissions?: {
    canRead: string[];
    canWrite: string[];
    canDelete: string[];
    isPublic: boolean;
    inheritFromProject: boolean;
  };
  metadata?: Record<string, unknown>;
}

interface ArtifactCreatorProps {
  onClose?: () => void;
  onSave?: (artifact: BaseArtifact) => void;
  projectId?: string;
  sessionId?: string;
  sourceQuestId?: string;
  parentArtifactId?: string;
  defaultType?: string;
  defaultContent?: string;
}

// Content templates for different artifact types
const CONTENT_TEMPLATES = {
  react: `import React, { useState } from 'react';

const MyComponent: React.FC = () => {
  const [count, setCount] = useState(0);

  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <h1>My React Component</h1>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </div>
  );
};

export default MyComponent;`,

  html: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My HTML Page</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Welcome to My Page</h1>
        <p>This is a beautiful HTML page</p>
    </div>
</body>
</html>`,

  svg: `<svg width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#667eea;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#764ba2;stop-opacity:1" />
    </linearGradient>
  </defs>
  
  <circle cx="100" cy="100" r="80" fill="url(#gradient)" />
  <text x="100" y="110" text-anchor="middle" fill="white" font-size="20" font-family="Arial">
    SVG Art
  </text>
</svg>`,

  mermaid: `graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[End]
    D --> E`,

  python: `def hello_world():
    """A simple Python function."""
    print("Hello, World!")
    return "Success"

def calculate_fibonacci(n):
    """Calculate the nth Fibonacci number."""
    if n <= 1:
        return n
    return calculate_fibonacci(n-1) + calculate_fibonacci(n-2)

# Example usage
if __name__ == "__main__":
    hello_world()
    print(f"Fibonacci(10) = {calculate_fibonacci(10)}")`,

  code: `// Generic code template
function greetUser(name) {
    return \`Hello, \${name}! Welcome to the application.\`;
}

const users = ['Alice', 'Bob', 'Charlie'];
users.forEach(user => {
    console.log(greetUser(user));
});`,
};

// Syntax highlighting language mapping
const LANGUAGE_MAP = {
  react: 'tsx',
  html: 'html',
  svg: 'xml',
  mermaid: 'mermaid',
  python: 'python',
  code: 'javascript',
  javascript: 'javascript',
  typescript: 'typescript',
} as const;

export const ArtifactCreator: React.FC<ArtifactCreatorProps> = ({
  onClose,
  onSave,
  projectId,
  sessionId,
  sourceQuestId,
  parentArtifactId,
  defaultType = 'react',
  defaultContent = '',
}) => {
  const [artifactTypes, setArtifactTypes] = useState<ArtifactTypesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [currentTab, setCurrentTab] = useState(0); // 0 = Edit, 1 = Preview

  // Form state
  const [formData, setFormData] = useState<CreateArtifactRequest>({
    type: defaultType,
    title: '',
    description: '',
    content: defaultContent || CONTENT_TEMPLATES[defaultType as keyof typeof CONTENT_TEMPLATES] || '',
    projectId,
    sessionId,
    sourceQuestId,
    parentArtifactId,
    visibility: 'private',
    tags: [],
    permissions: {
      canRead: [],
      canWrite: [],
      canDelete: [],
      isPublic: false,
      inheritFromProject: true,
    },
    metadata: {},
  });

  const [newTag, setNewTag] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Fetch artifact types
  const fetchArtifactTypes = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get<ArtifactTypesResponse>('/api/artifacts/types');
      setArtifactTypes(response.data);
    } catch (error) {
      console.error('Failed to fetch artifact types:', error);
      toast.error('Failed to load artifact types');
    } finally {
      setLoading(false);
    }
  }, []);

  // Validate form
  const validateForm = useCallback(() => {
    const newErrors: Record<string, string> = {};

    if (!formData.title.trim()) {
      newErrors.title = 'Title is required';
    }

    if (!formData.content.trim()) {
      newErrors.content = 'Content is required';
    }

    if (formData.title.length > 255) {
      newErrors.title = 'Title must be less than 255 characters';
    }

    if (formData.description && formData.description.length > 1000) {
      newErrors.description = 'Description must be less than 1000 characters';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData]);

  // Handle form field changes
  const handleFieldChange = useCallback(
    (field: keyof CreateArtifactRequest, value: any) => {
      setFormData(prev => ({ ...prev, [field]: value }));

      // Clear error for this field
      if (errors[field]) {
        setErrors(prev => ({ ...prev, [field]: '' }));
      }
    },
    [errors]
  );

  // Handle type change
  const handleTypeChange = useCallback((newType: string) => {
    setFormData(prev => ({
      ...prev,
      type: newType,
      content: prev.content || CONTENT_TEMPLATES[newType as keyof typeof CONTENT_TEMPLATES] || '',
    }));
  }, []);

  // Handle tag operations
  const addTag = useCallback(() => {
    if (newTag.trim() && !formData.tags.includes(newTag.trim())) {
      setFormData(prev => ({
        ...prev,
        tags: [...prev.tags, newTag.trim()],
      }));
      setNewTag('');
    }
  }, [newTag, formData.tags]);

  const removeTag = useCallback((tagToRemove: string) => {
    setFormData(prev => ({
      ...prev,
      tags: prev.tags.filter(tag => tag !== tagToRemove),
    }));
  }, []);

  // Handle save
  const handleSave = useCallback(async () => {
    if (!validateForm()) {
      toast.error('Please fix the form errors');
      return;
    }

    try {
      setSaving(true);
      const response = await api.post<BaseArtifact>('/api/artifacts', formData);

      toast.success('Artifact created successfully!');
      onSave?.(response.data);
      onClose?.();
    } catch (error: any) {
      toast.error(error.message || 'Failed to create artifact');
    } finally {
      setSaving(false);
    }
  }, [formData, validateForm, onSave, onClose]);

  // Get syntax highlighting language
  const getLanguage = useMemo(() => {
    return LANGUAGE_MAP[formData.type as keyof typeof LANGUAGE_MAP] || 'text';
  }, [formData.type]);

  // Get selected artifact type info
  const selectedTypeInfo = useMemo(() => {
    return artifactTypes?.types.find(t => t.type === formData.type);
  }, [artifactTypes, formData.type]);

  useEffect(() => {
    fetchArtifactTypes();
  }, [fetchArtifactTypes]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Card
      className="artifact-creator-card"
      sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {/* Header */}
      <Stack className="artifact-creator-header" direction="row" spacing={2} alignItems="center" sx={{ p: 3, pb: 2 }}>
        <Typography className="artifact-creator-title" level="h3" flex={1}>
          Create New Artifact
        </Typography>

        <Stack className="artifact-creator-actions" direction="row" spacing={1}>
          <Button
            className="artifact-creator-preview-button"
            variant="outlined"
            startDecorator={<PreviewIcon />}
            onClick={() => setCurrentTab(currentTab === 0 ? 1 : 0)}
          >
            {currentTab === 0 ? 'Preview' : 'Edit'}
          </Button>

          <Button
            className="artifact-creator-save-button"
            startDecorator={<SaveIcon />}
            onClick={handleSave}
            loading={saving}
            disabled={!formData.title.trim() || !formData.content.trim()}
          >
            Create
          </Button>

          {onClose && (
            <IconButton className="artifact-creator-close-button" variant="outlined" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          )}
        </Stack>
      </Stack>

      <Divider />

      {/* Main Content */}
      <Box
        className="artifact-creator-content"
        sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <Tabs
          className="artifact-creator-tabs"
          value={currentTab}
          onChange={(_, value) => setCurrentTab(value as number)}
          sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}
        >
          <TabList className="artifact-creator-tab-list" sx={{ display: 'none' }}>
            <Tab className="artifact-creator-edit-tab">Edit</Tab>
            <Tab className="artifact-creator-preview-tab">Preview</Tab>
          </TabList>

          {/* Edit Tab */}
          <TabPanel
            className="artifact-creator-edit-panel"
            value={0}
            sx={{ flex: 1, display: 'flex', gap: 2, overflow: 'hidden' }}
          >
            {/* Left Panel - Form */}
            <Box
              className="artifact-creator-form-panel"
              sx={{ width: '40%', display: 'flex', flexDirection: 'column', gap: 2, overflow: 'auto' }}
            >
              {/* Basic Info */}
              <Stack className="artifact-creator-basic-info" spacing={2}>
                <FormControl className="artifact-creator-title-control" error={!!errors.title}>
                  <FormLabel className="artifact-creator-title-label">Title</FormLabel>
                  <Input
                    className="artifact-creator-title-input"
                    placeholder="Enter artifact title..."
                    value={formData.title}
                    onChange={e => handleFieldChange('title', e.target.value)}
                  />
                  {errors.title && (
                    <Typography level="body-xs" color="danger">
                      {errors.title}
                    </Typography>
                  )}
                </FormControl>

                <FormControl className="artifact-creator-type-control">
                  <FormLabel className="artifact-creator-type-label">Type</FormLabel>
                  <Select
                    className="artifact-creator-type-select"
                    value={formData.type}
                    onChange={(_, value) => value && handleTypeChange(value)}
                  >
                    {artifactTypes?.types.map(type => (
                      <Option key={type.type} value={type.type}>
                        {type.name}
                      </Option>
                    ))}
                  </Select>
                  {selectedTypeInfo && (
                    <Typography level="body-xs" color="neutral">
                      {selectedTypeInfo.description}
                    </Typography>
                  )}
                </FormControl>

                <FormControl className="artifact-creator-description-control" error={!!errors.description}>
                  <FormLabel className="artifact-creator-description-label">Description (Optional)</FormLabel>
                  <Textarea
                    className="artifact-creator-description-textarea"
                    placeholder="Describe your artifact..."
                    minRows={2}
                    maxRows={4}
                    value={formData.description}
                    onChange={e => handleFieldChange('description', e.target.value)}
                  />
                  {errors.description && (
                    <Typography level="body-xs" color="danger">
                      {errors.description}
                    </Typography>
                  )}
                </FormControl>
              </Stack>

              <Divider />

              {/* Visibility & Permissions */}
              <Stack className="artifact-creator-permissions" spacing={2}>
                <FormControl className="artifact-creator-visibility-control">
                  <FormLabel className="artifact-creator-visibility-label">Visibility</FormLabel>
                  <Select
                    className="artifact-creator-visibility-select"
                    value={formData.visibility}
                    onChange={(_, value) => value && handleFieldChange('visibility', value)}
                    startDecorator={
                      formData.visibility === 'public' ? (
                        <PublicIcon />
                      ) : formData.visibility === 'organization' ? (
                        <GroupIcon />
                      ) : formData.visibility === 'project' ? (
                        <GroupIcon />
                      ) : (
                        <LockIcon />
                      )
                    }
                  >
                    <Option value="private">Private</Option>
                    <Option value="project">Project</Option>
                    <Option value="organization">Organization</Option>
                    <Option value="public">Public</Option>
                  </Select>
                </FormControl>

                <FormControl>
                  <Stack direction="row" spacing={2} alignItems="center">
                    <FormLabel>Inherit Project Permissions</FormLabel>
                    <Switch
                      checked={formData.permissions?.inheritFromProject}
                      onChange={e =>
                        handleFieldChange('permissions', {
                          ...formData.permissions,
                          inheritFromProject: e.target.checked,
                        })
                      }
                    />
                  </Stack>
                </FormControl>
              </Stack>

              <Divider />

              {/* Tags */}
              <FormControl className="artifact-creator-tags-control">
                <FormLabel className="artifact-creator-tags-label">Tags</FormLabel>
                <Stack className="artifact-creator-tags-stack" spacing={1}>
                  <Stack className="artifact-creator-tag-input-row" direction="row" spacing={1}>
                    <Input
                      className="artifact-creator-tag-input"
                      placeholder="Add tag..."
                      value={newTag}
                      onChange={e => setNewTag(e.target.value)}
                      onKeyPress={e => e.key === 'Enter' && addTag()}
                      sx={{ flex: 1 }}
                    />
                    <IconButton className="artifact-creator-add-tag-button" onClick={addTag} disabled={!newTag.trim()}>
                      <AddIcon />
                    </IconButton>
                  </Stack>

                  {formData.tags.length > 0 && (
                    <Stack className="artifact-creator-tags-list" direction="row" spacing={1} flexWrap="wrap">
                      {formData.tags.map(tag => (
                        <Chip
                          className="artifact-creator-tag-chip"
                          key={tag}
                          variant="soft"
                          endDecorator={
                            <IconButton
                              className="artifact-creator-remove-tag-button"
                              size="sm"
                              onClick={() => removeTag(tag)}
                            >
                              <RemoveIcon />
                            </IconButton>
                          }
                        >
                          {tag}
                        </Chip>
                      ))}
                    </Stack>
                  )}
                </Stack>
              </FormControl>
            </Box>

            {/* Right Panel - Content Editor */}
            <Box className="artifact-creator-editor-panel" sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <FormControl
                className="artifact-creator-content-control"
                error={!!errors.content}
                sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}
              >
                <FormLabel className="artifact-creator-content-label">Content</FormLabel>
                <Textarea
                  className="artifact-creator-content-textarea"
                  placeholder={`Enter your ${formData.type} content...`}
                  value={formData.content}
                  onChange={e => handleFieldChange('content', e.target.value)}
                  sx={{
                    flex: 1,
                    fontFamily: 'monospace',
                    fontSize: 'sm',
                    '& textarea': {
                      resize: 'none',
                    },
                  }}
                  slotProps={{
                    textarea: {
                      style: { minHeight: '400px' },
                    },
                  }}
                />
                {errors.content && (
                  <Typography className="artifact-creator-content-error" level="body-xs" color="danger">
                    {errors.content}
                  </Typography>
                )}
              </FormControl>
            </Box>
          </TabPanel>

          {/* Preview Tab */}
          <TabPanel className="artifact-creator-preview-panel" value={1} sx={{ flex: 1, overflow: 'auto' }}>
            <Box
              className="artifact-creator-preview-container"
              sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
            >
              <Typography className="artifact-creator-preview-title" level="title-md" sx={{ mb: 2 }}>
                Preview: {formData.title || 'Untitled Artifact'}
              </Typography>

              {formData.content ? (
                <Box className="artifact-creator-preview-content" sx={{ flex: 1, overflow: 'auto' }}>
                  <SyntaxHighlighter
                    className="artifact-creator-syntax-highlighter"
                    language={getLanguage}
                    style={oneDark}
                    customStyle={{
                      margin: 0,
                      borderRadius: '8px',
                      fontSize: '14px',
                      minHeight: '100%',
                    }}
                  >
                    {formData.content}
                  </SyntaxHighlighter>
                </Box>
              ) : (
                <Alert className="artifact-creator-preview-alert" color="neutral">
                  <Typography className="artifact-creator-preview-alert-text" level="body-sm">
                    No content to preview. Add some content in the edit tab.
                  </Typography>
                </Alert>
              )}
            </Box>
          </TabPanel>
        </Tabs>
      </Box>
    </Card>
  );
};

export default ArtifactCreator;
