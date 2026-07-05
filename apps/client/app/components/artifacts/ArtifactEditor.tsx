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
  Tooltip,
  useTheme,
} from '@mui/joy';
import {
  Save as SaveIcon,
  Preview as PreviewIcon,
  Close as CloseIcon,
  Add as AddIcon,
  Remove as RemoveIcon,
  Undo as UndoIcon,
  Lock as LockIcon,
  Public as PublicIcon,
  Group as GroupIcon,
} from '@mui/icons-material';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { type BaseArtifact } from '@bike4mind/common';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-json';
import { ContextHelpButton } from '@client/app/components/help';

// Types
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

interface UpdateArtifactRequest {
  title?: string;
  description?: string;
  content?: string;
  visibility?: 'private' | 'project' | 'organization' | 'public';
  tags?: string[];
  versionTag?: string;
  status?: 'draft' | 'review' | 'published' | 'archived';
  permissions?: {
    canRead?: string[];
    canWrite?: string[];
    canDelete?: string[];
    isPublic?: boolean;
    inheritFromProject?: boolean;
  };
  metadata?: Record<string, unknown>;
  createNewVersion?: boolean;
  versionMessage?: string;
}

interface ArtifactWithContent extends BaseArtifact {
  content?: string;
  contentSize: number;
  contentHash: string;
  metadata?: Record<string, unknown>;
}

interface ArtifactEditorProps {
  artifact: ArtifactWithContent;
  onClose?: () => void;
  onSave?: (artifact: BaseArtifact) => void;
}

// Syntax highlighting language mapping for SyntaxHighlighter (preview)
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

// Prismjs language mapping for Editor
const getPrismLanguageGrammar = (artifactType: string) => {
  const languageMap: Record<string, string> = {
    react: 'tsx',
    html: 'markup',
    svg: 'markup',
    mermaid: 'javascript',
    python: 'python',
    code: 'javascript',
    javascript: 'javascript',
    typescript: 'typescript',
  };

  const lang = languageMap[artifactType] || 'javascript';
  return { grammar: Prism.languages[lang], language: lang };
};

export const ArtifactEditor: React.FC<ArtifactEditorProps> = ({ artifact, onClose, onSave }) => {
  // Hooks
  const theme = useTheme();

  // State
  const [artifactTypes, setArtifactTypes] = useState<ArtifactTypesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [currentTab, setCurrentTab] = useState(0); // 0 = Edit, 1 = Preview

  // Form state - initialize with artifact data
  const [formData, setFormData] = useState<UpdateArtifactRequest>({
    title: artifact.title,
    description: artifact.description || '',
    content: artifact.content || '',
    visibility: artifact.visibility,
    tags: artifact.tags || [],
    status: artifact.status === 'deleted' ? 'archived' : artifact.status, // Convert deleted to archived for editing
    permissions: artifact.permissions || {
      canRead: [],
      canWrite: [],
      canDelete: [],
      isPublic: false,
      inheritFromProject: true,
    },
    metadata: artifact.metadata || {},
  });

  // Track original values for change detection
  const [originalData] = useState<UpdateArtifactRequest>({
    title: artifact.title,
    description: artifact.description || '',
    content: artifact.content || '',
    visibility: artifact.visibility,
    tags: artifact.tags || [],
    status: artifact.status === 'deleted' ? 'archived' : artifact.status,
    permissions: artifact.permissions,
    metadata: artifact.metadata,
  });

  const [newTag, setNewTag] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Check if there are unsaved changes
  const hasChanges = useMemo(() => {
    return (
      formData.title !== originalData.title ||
      formData.description !== originalData.description ||
      formData.content !== originalData.content ||
      formData.visibility !== originalData.visibility ||
      formData.status !== originalData.status ||
      JSON.stringify(formData.tags) !== JSON.stringify(originalData.tags) ||
      JSON.stringify(formData.permissions) !== JSON.stringify(originalData.permissions)
    );
  }, [formData, originalData]);

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

    if (!formData.title?.trim()) {
      newErrors.title = 'Title is required';
    }

    if (!formData.content?.trim()) {
      newErrors.content = 'Content is required';
    }

    if (formData.title && formData.title.length > 255) {
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
    (field: keyof UpdateArtifactRequest, value: any) => {
      setFormData(prev => ({ ...prev, [field]: value }));

      // Clear error for this field
      if (errors[field]) {
        setErrors(prev => ({ ...prev, [field]: '' }));
      }
    },
    [errors]
  );

  // Handle tag operations
  const addTag = useCallback(() => {
    if (newTag.trim() && !formData.tags?.includes(newTag.trim())) {
      setFormData(prev => ({
        ...prev,
        tags: [...(prev.tags || []), newTag.trim()],
      }));
      setNewTag('');
    }
  }, [newTag, formData.tags]);

  const removeTag = useCallback((tagToRemove: string) => {
    setFormData(prev => ({
      ...prev,
      tags: (prev.tags || []).filter(tag => tag !== tagToRemove),
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

      // Only send changed fields to reduce payload
      const changedFields: UpdateArtifactRequest = {};

      // Check each field individually for changes
      if (formData.title !== originalData.title) changedFields.title = formData.title;
      if (formData.description !== originalData.description) changedFields.description = formData.description;
      if (formData.content !== originalData.content) {
        changedFields.content = formData.content;
        // Always create a new version when content changes
        changedFields.createNewVersion = true;
      }
      if (formData.visibility !== originalData.visibility) changedFields.visibility = formData.visibility;
      if (formData.status !== originalData.status) changedFields.status = formData.status;
      if (JSON.stringify(formData.tags) !== JSON.stringify(originalData.tags)) changedFields.tags = formData.tags;
      if (JSON.stringify(formData.permissions) !== JSON.stringify(originalData.permissions))
        changedFields.permissions = formData.permissions;
      if (JSON.stringify(formData.metadata) !== JSON.stringify(originalData.metadata))
        changedFields.metadata = formData.metadata;

      const response = await api.put<{ artifact: BaseArtifact; content?: any; version?: any }>(
        `/api/artifacts/${artifact.id}`,
        changedFields
      );

      toast.success('Artifact updated successfully!');
      // Extract the artifact from the response (API returns {artifact, content, version})
      onSave?.(response.data.artifact || response.data);
      onClose?.();
    } catch (error: any) {
      console.error('[ARTIFACT EDITOR] Save failed:', error);
      toast.error(error.message || 'Failed to update artifact');
    } finally {
      setSaving(false);
    }
  }, [formData, originalData, validateForm, artifact.id, onSave, onClose, hasChanges]);

  // Handle revert changes
  const handleRevert = useCallback(() => {
    setFormData({
      title: originalData.title,
      description: originalData.description,
      content: originalData.content,
      visibility: originalData.visibility,
      tags: originalData.tags,
      status: originalData.status,
      permissions: originalData.permissions,
      metadata: originalData.metadata,
    });
    setErrors({});
    toast.info('Changes reverted');
  }, [originalData]);

  // Get syntax highlighting language
  const getLanguage = useMemo(() => {
    return LANGUAGE_MAP[artifact.type as keyof typeof LANGUAGE_MAP] || 'text';
  }, [artifact.type]);

  // Syntax highlighting function for Editor
  const highlightCode = useCallback(
    (code: string) => {
      try {
        const { grammar, language } = getPrismLanguageGrammar(artifact.type);
        if (!grammar) {
          console.warn(`No Prism grammar found for ${artifact.type}, using javascript as fallback`);
          return Prism.highlight(code, Prism.languages.javascript, 'javascript');
        }
        return Prism.highlight(code, grammar, language);
      } catch (e) {
        console.error('Error highlighting code:', e);
        return code;
      }
    },
    [artifact.type]
  );

  // Get selected artifact type info
  const selectedTypeInfo = useMemo(() => {
    return artifactTypes?.types.find(t => t.type === artifact.type);
  }, [artifactTypes, artifact.type]);

  // Effects
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
    <Card sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ p: 3, pb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} flex={1}>
          <Typography level="h3">Edit Artifact: {artifact.title}</Typography>
          <ContextHelpButton helpId="features/artifacts-system" tooltipText="Learn about Artifacts" />
        </Stack>

        <Stack direction="row" spacing={1}>
          {hasChanges && (
            <Tooltip title="Revert all changes">
              <Button variant="outlined" color="neutral" startDecorator={<UndoIcon />} onClick={handleRevert}>
                Revert
              </Button>
            </Tooltip>
          )}

          <Button
            variant="outlined"
            startDecorator={<PreviewIcon />}
            onClick={() => setCurrentTab(currentTab === 0 ? 1 : 0)}
          >
            {currentTab === 0 ? 'Preview' : 'Edit'}
          </Button>

          <Button
            startDecorator={<SaveIcon />}
            onClick={handleSave}
            loading={saving}
            disabled={!hasChanges || !formData.title?.trim() || !formData.content?.trim()}
          >
            Save Changes
          </Button>

          {onClose && (
            <IconButton variant="outlined" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          )}
        </Stack>
      </Stack>

      {hasChanges && (
        <Alert color="warning" sx={{ mx: 3, mb: 2 }}>
          <Typography level="body-sm">You have unsaved changes. Don&apos;t forget to save!</Typography>
        </Alert>
      )}

      <Divider />

      {/* Main Content */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Tabs
          value={currentTab}
          onChange={(_, value) => setCurrentTab(value as number)}
          sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}
        >
          <TabList sx={{ display: 'none' }}>
            <Tab>Edit</Tab>
            <Tab>Preview</Tab>
          </TabList>

          {/* Edit Tab */}
          <TabPanel value={0} sx={{ flex: 1, display: 'flex', gap: 2, overflow: 'hidden' }}>
            {/* Left Panel - Form */}
            <Box sx={{ width: '40%', display: 'flex', flexDirection: 'column', gap: 2, overflow: 'auto' }}>
              {/* Basic Info */}
              <Stack spacing={2}>
                <FormControl error={!!errors.title}>
                  <FormLabel>Title</FormLabel>
                  <Input
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

                <FormControl>
                  <FormLabel>Type</FormLabel>
                  <Input
                    value={selectedTypeInfo?.name || artifact.type}
                    disabled
                    startDecorator={
                      <Chip size="sm" variant="soft">
                        {artifact.type}
                      </Chip>
                    }
                  />
                  <Typography level="body-xs" color="neutral">
                    Artifact type cannot be changed after creation
                  </Typography>
                </FormControl>

                <FormControl error={!!errors.description}>
                  <FormLabel>Description (Optional)</FormLabel>
                  <Textarea
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

              {/* Status & Visibility */}
              <Stack spacing={2}>
                <FormControl>
                  <FormLabel>Status</FormLabel>
                  <Select value={formData.status} onChange={(_, value) => value && handleFieldChange('status', value)}>
                    <Option value="draft">Draft</Option>
                    <Option value="review">Review</Option>
                    <Option value="published">Published</Option>
                    <Option value="archived">Archived</Option>
                  </Select>
                </FormControl>

                <FormControl>
                  <FormLabel>Visibility</FormLabel>
                  <Select
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
              <FormControl>
                <FormLabel>Tags</FormLabel>
                <Stack spacing={1}>
                  <Stack direction="row" spacing={1}>
                    <Input
                      placeholder="Add tag..."
                      value={newTag}
                      onChange={e => setNewTag(e.target.value)}
                      onKeyPress={e => e.key === 'Enter' && addTag()}
                      sx={{ flex: 1 }}
                    />
                    <IconButton onClick={addTag} disabled={!newTag.trim()}>
                      <AddIcon />
                    </IconButton>
                  </Stack>

                  {(formData.tags || []).length > 0 && (
                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      {(formData.tags || []).map(tag => (
                        <Chip
                          key={tag}
                          variant="soft"
                          endDecorator={
                            <IconButton size="sm" onClick={() => removeTag(tag)}>
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
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <FormControl error={!!errors.content} sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <FormLabel>Content</FormLabel>
                <Box
                  sx={{
                    flex: 1,
                    border: '1px solid',
                    borderColor: errors.content ? 'danger.outlinedBorder' : 'neutral.outlinedBorder',
                    borderRadius: 'sm',
                    overflow: 'auto',
                    backgroundColor: theme.palette.mode === 'dark' ? '#282c34' : '#fafafa',
                    '&:focus-within': {
                      borderColor: errors.content ? 'danger.outlinedBorder' : 'primary.outlinedBorder',
                    },
                    '& textarea': {
                      outline: 'none',
                    },
                    '& pre': {
                      margin: 0,
                      fontFamily: 'monospace',
                    },
                    // Prism syntax highlighting styles for dark mode (oneDark theme)
                    ...(theme.palette.mode === 'dark' && {
                      '& .token.comment, & .token.prolog, & .token.doctype, & .token.cdata': {
                        color: '#5c6370',
                      },
                      '& .token.punctuation': {
                        color: '#abb2bf',
                      },
                      '& .token.property, & .token.tag, & .token.constant, & .token.symbol, & .token.deleted': {
                        color: '#e06c75',
                      },
                      '& .token.boolean, & .token.number': {
                        color: '#d19a66',
                      },
                      '& .token.selector, & .token.attr-name, & .token.string, & .token.char, & .token.builtin, & .token.inserted':
                        {
                          color: '#98c379',
                        },
                      '& .token.operator, & .token.entity, & .token.url, & .language-css .token.string, & .style .token.string':
                        {
                          color: '#56b6c2',
                        },
                      '& .token.atrule, & .token.attr-value, & .token.keyword': {
                        color: '#c678dd',
                      },
                      '& .token.function, & .token.class-name': {
                        color: '#61afef',
                      },
                      '& .token.regex, & .token.important, & .token.variable': {
                        color: '#e5c07b',
                      },
                    }),
                    // Prism syntax highlighting styles for light mode
                    ...(theme.palette.mode === 'light' && {
                      '& .token.comment, & .token.prolog, & .token.doctype, & .token.cdata': {
                        color: '#008000',
                      },
                      '& .token.punctuation': {
                        color: '#393A34',
                      },
                      '& .token.property, & .token.tag, & .token.boolean, & .token.number, & .token.constant, & .token.symbol, & .token.deleted':
                        {
                          color: '#36acaa',
                        },
                      '& .token.selector, & .token.attr-name, & .token.string, & .token.char, & .token.builtin, & .token.inserted':
                        {
                          color: '#A31515',
                        },
                      '& .token.operator, & .token.entity, & .token.url, & .language-css .token.string, & .style .token.string':
                        {
                          color: '#393A34',
                        },
                      '& .token.atrule, & .token.attr-value, & .token.keyword': {
                        color: '#0000FF',
                      },
                      '& .token.function, & .token.class-name': {
                        color: '#795E26',
                      },
                      '& .token.regex, & .token.important, & .token.variable': {
                        color: '#e90',
                      },
                    }),
                  }}
                >
                  <Editor
                    value={formData.content || ''}
                    onValueChange={code => handleFieldChange('content', code)}
                    highlight={highlightCode}
                    padding={12}
                    placeholder={`Enter your ${artifact.type} content...`}
                    style={{
                      fontFamily: '"Fira Code", "Fira Mono", Consolas, Menlo, Courier, monospace',
                      fontSize: 14,
                      minHeight: '400px',
                      backgroundColor: 'transparent',
                      color: theme.palette.mode === 'dark' ? '#abb2bf' : '#393A34',
                    }}
                    textareaClassName="editor-textarea"
                    preClassName="editor-pre"
                  />
                </Box>
                {errors.content && (
                  <Typography level="body-xs" color="danger">
                    {errors.content}
                  </Typography>
                )}
              </FormControl>
            </Box>
          </TabPanel>

          {/* Preview Tab */}
          <TabPanel value={1} sx={{ flex: 1, overflow: 'auto' }}>
            <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <Typography level="title-md" sx={{ mb: 2 }}>
                Preview: {formData.title || 'Untitled Artifact'}
              </Typography>

              {formData.content ? (
                <Box sx={{ flex: 1, overflow: 'auto' }}>
                  <SyntaxHighlighter
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
                <Alert color="neutral">
                  <Typography level="body-sm">No content to preview. Add some content in the edit tab.</Typography>
                </Alert>
              )}
            </Box>
          </TabPanel>
        </Tabs>
      </Box>
    </Card>
  );
};

export default ArtifactEditor;
