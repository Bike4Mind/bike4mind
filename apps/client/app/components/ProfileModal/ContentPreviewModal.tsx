import React, { useState, memo } from 'react';
import {
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Typography,
  Alert,
  FormControl,
  FormLabel,
  Input,
  Textarea,
  Box,
  Chip,
  IconButton,
  ButtonGroup,
} from '@mui/joy';
import {
  Article,
  Send,
  Edit,
  Close as CloseIcon,
  AutoAwesome,
  AddPhotoAlternate,
  CalendarToday,
  Collections,
} from '@mui/icons-material';
import { toast } from 'sonner';
import { usePublishBlog } from '@client/app/hooks/data/blog';
import { useBlogContentEnhancement } from '@client/app/hooks/useBlogContentEnhancement';
import { useBlogImageGeneration } from '@client/app/hooks/useBlogImageGeneration';
import { api } from '@client/app/contexts/ApiContext';
import ShimmerWrapper from '../ShimmerWrapper';
import dynamic from 'next/dynamic';
import { useUser } from '@client/app/contexts/UserContext';
import { uploadBlogImage, generatePostIdFromTitle } from '@client/app/utils/blogImageUpload';
import { useImageBrowser } from '@client/app/hooks/agent/useImageBrowser';
import ImageBrowserModal from '../Agent/ImageBrowserModal';

// Dynamic import to avoid SSR issues
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

interface ContentPreviewModalProps {
  open: boolean;
  onClose: () => void;
  initialTitle?: string;
  initialContent?: string;
  initialSummary?: string;
  initialTags?: string[];
  /** When true, the modal opens directly in edit mode instead of preview (e.g. the card's edit pencil). */
  initialEditing?: boolean;
}

const ContentPreviewModal: React.FC<ContentPreviewModalProps> = ({
  open,
  onClose,
  initialTitle = '',
  initialContent = '',
  initialSummary = '',
  initialTags = [],
  initialEditing = false,
}) => {
  const { currentUser } = useUser();
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [summary, setSummary] = useState(initialSummary);
  const [tags, setTags] = useState<string[]>(initialTags);
  const [newTagInput, setNewTagInput] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [uploadingImages, setUploadingImages] = useState<Set<string>>(new Set());
  const [featuredImageUrl, setFeaturedImageUrl] = useState<string>('');
  const [isUploadingFeaturedImage, setIsUploadingFeaturedImage] = useState(false);
  const [publishedAt, setPublishedAt] = useState<number | undefined>(undefined);

  const { mutate: publishBlog, isPending: isPublishing } = usePublishBlog({
    onSuccess: data => {
      toast.success(data.message, {
        description: `View at: ${data.url}`,
        duration: 10000,
        action: {
          label: 'Open',
          onClick: () => window.open(data.url, '_blank'),
        },
      });
      handleClose();
    },
    onError: error => {
      toast.error('Failed to publish blog post', {
        description: error.message,
        duration: 10000,
      });
    },
  });

  const { isGeneratingTitle, isGeneratingSummary, shimmeringField, handleGenerateTitle, handleGenerateSummary } =
    useBlogContentEnhancement(content, title, summary, setTitle, setSummary);

  const { generateFeaturedImage, isGeneratingImage } = useBlogImageGeneration({
    content,
    title,
    summary,
    blogApiKey: currentUser?.blogIntegration?.apiKey || '',
    blogBaseUrl: currentUser?.blogIntegration?.baseUrl,
    onImageGenerated: (imageUrl, prompt) => {
      console.log('[ContentPreview] Image generated with prompt:', prompt);
      setFeaturedImageUrl(imageUrl);
    },
  });

  const imageBrowser = useImageBrowser();

  const handleSelectFabFileImage = async (fabFileId: string) => {
    if (!currentUser?.blogIntegration?.apiKey) {
      toast.error('Blog integration not configured. Please set up your blog API key in Settings.');
      return;
    }

    setIsUploadingFeaturedImage(true);
    toast.info('📤 Uploading selected image to blog...');

    try {
      // Proxy endpoint downloads the FabFile image server-side to avoid CORS on S3 signed URLs.
      const proxyResponse = await api.post<{
        success: boolean;
        imageUrl: string;
        mimeType: string;
        message?: string;
      }>('/api/blog/proxy-fabfile-image', { fabFileId });

      if (!proxyResponse.data.success || !proxyResponse.data.imageUrl) {
        throw new Error(proxyResponse.data.message || 'Failed to load image from FabFile');
      }

      // Convert base64 data URL to blob for upload
      const base64ImageUrl = proxyResponse.data.imageUrl;
      const [header, base64Data] = base64ImageUrl.split(',');
      const mimeMatch = header.match(/data:([^;]+)/);
      const mimeType = mimeMatch ? mimeMatch[1] : proxyResponse.data.mimeType || 'image/png';
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mimeType });
      const file = new File([blob], 'featured-image.png', { type: mimeType });

      const postId = title ? generatePostIdFromTitle(title) : 'featured';
      const result = await uploadBlogImage(
        file,
        currentUser.blogIntegration.apiKey,
        postId,
        currentUser.blogIntegration.baseUrl
      );

      setFeaturedImageUrl(result.url);
      toast.success('✅ Featured image uploaded!');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to upload selected image';
      toast.error(errorMessage);
    } finally {
      setIsUploadingFeaturedImage(false);
    }
  };

  // Update state when props change
  React.useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setContent(initialContent);
      setSummary(initialSummary);
      setTags(initialTags);
      setNewTagInput('');
      setIsEditing(initialEditing);
      setFeaturedImageUrl('');
      setPublishedAt(undefined); // Will default to current time on publish
    }
  }, [open, initialTitle, initialContent, initialSummary, initialTags, initialEditing]);

  const handlePublish = (status: 'draft' | 'published') => {
    publishBlog({
      title,
      content,
      summary,
      tags: tags.filter(Boolean),
      status,
      featuredImage: featuredImageUrl || undefined,
      publishedAt: publishedAt, // Optional - if undefined, backend will use current time
    });
  };

  const handleClose = () => {
    setIsEditing(false);
    onClose();
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter(tag => tag !== tagToRemove));
  };

  const handleAddTag = () => {
    const trimmedTag = newTagInput.trim();
    if (trimmedTag && !tags.includes(trimmedTag)) {
      setTags([...tags, trimmedTag]);
      setNewTagInput('');
    }
  };

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  };

  const handleImageUpload = async (file: File): Promise<string> => {
    if (!currentUser?.blogIntegration?.apiKey) {
      toast.error('Blog integration not configured. Please set up your blog API key in Settings.');
      throw new Error('Blog integration not configured');
    }

    const imageId = `${file.name}-${Date.now()}`;
    setUploadingImages(prev => new Set(prev).add(imageId));
    toast.info('📤 Uploading image...');

    try {
      const postId = title ? generatePostIdFromTitle(title) : undefined;
      const result = await uploadBlogImage(
        file,
        currentUser.blogIntegration.apiKey,
        postId,
        currentUser.blogIntegration.baseUrl
      );

      setUploadingImages(prev => {
        const next = new Set(prev);
        next.delete(imageId);
        return next;
      });

      toast.success('✅ Image uploaded!');
      return result.url;
    } catch (error) {
      setUploadingImages(prev => {
        const next = new Set(prev);
        next.delete(imageId);
        return next;
      });

      const errorMessage = error instanceof Error ? error.message : 'Failed to upload image';
      toast.error(errorMessage);
      throw error;
    }
  };

  const handleFeaturedImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!currentUser?.blogIntegration?.apiKey) {
      toast.error('Blog integration not configured. Please set up your blog API key in Settings.');
      return;
    }

    setIsUploadingFeaturedImage(true);
    toast.info('📤 Uploading featured image...');

    try {
      const postId = title ? generatePostIdFromTitle(title) : 'featured';
      const result = await uploadBlogImage(
        file,
        currentUser.blogIntegration.apiKey,
        postId,
        currentUser.blogIntegration.baseUrl
      );

      setFeaturedImageUrl(result.url);
      toast.success('✅ Featured image uploaded!');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to upload featured image';
      toast.error(errorMessage);
    } finally {
      setIsUploadingFeaturedImage(false);
    }
  };

  const insertAtCursor = (markdown: string) => {
    setContent(prevContent => prevContent + '\n' + markdown);
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          try {
            const url = await handleImageUpload(file);
            insertAtCursor(`![Pasted image](${url})`);
          } catch (error) {
            // Error already handled in handleImageUpload
          }
        }
      }
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    const images = files.filter(f => f.type.startsWith('image/'));

    if (images.length === 0) return;

    for (const image of images) {
      try {
        const url = await handleImageUpload(image);
        insertAtCursor(`![${image.name}](${url})`);
      } catch (error) {
        // Error already handled in handleImageUpload
      }
    }
  };

  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const charCount = content.length;
  const imageCount = (content.match(/!\[.*?\]\(.*?\)/g) || []).length;

  return (
    <>
      <Modal open={open} onClose={handleClose}>
        <ModalDialog size="lg" sx={{ width: 900, maxWidth: '95vw', maxHeight: '90vh' }}>
          <DialogTitle>
            <Article sx={{ mr: 1 }} />
            Content Preview {isEditing && '(Editing)'}
          </DialogTitle>

          <DialogContent sx={{ overflow: 'auto' }}>
            <Stack spacing={3}>
              <Alert color="primary" variant="soft">
                <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography level="body-sm">
                    <strong>Preview your transformed content before publishing.</strong>
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, ml: 'auto' }}>
                    <Chip size="sm" variant="soft">
                      {wordCount} words
                    </Chip>
                    <Chip size="sm" variant="soft">
                      {charCount} characters
                    </Chip>
                    {imageCount > 0 && (
                      <Chip size="sm" variant="soft" color="primary">
                        📷 {imageCount} {imageCount === 1 ? 'image' : 'images'}
                      </Chip>
                    )}
                  </Box>
                </Stack>
              </Alert>

              {uploadingImages.size > 0 && (
                <Alert color="primary" variant="soft">
                  📤 Uploading {uploadingImages.size} image{uploadingImages.size === 1 ? '' : 's'}...
                </Alert>
              )}

              {/* Title */}
              <FormControl>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <FormLabel sx={{ mb: 0 }}>Title</FormLabel>
                  <IconButton
                    variant="solid"
                    color="primary"
                    size="sm"
                    onClick={handleGenerateTitle}
                    loading={isGeneratingTitle}
                    disabled={!content || isGeneratingTitle}
                    sx={{
                      width: 20,
                      height: 20,
                      minWidth: 20,
                      minHeight: 20,
                      borderRadius: '4px',
                    }}
                  >
                    <AutoAwesome sx={{ fontSize: 12, color: 'white' }} />
                  </IconButton>
                </Box>
                <ShimmerWrapper isShimmering={shimmeringField === 'title'} fieldName="title">
                  {isEditing ? (
                    <Input
                      value={title}
                      onChange={e => setTitle(e.target.value)}
                      placeholder="Blog post title"
                      data-testid="preview-title-input"
                    />
                  ) : (
                    <Typography level="h3" sx={{ mt: 1 }}>
                      {title}
                    </Typography>
                  )}
                </ShimmerWrapper>
              </FormControl>

              {/* Summary */}
              <FormControl>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <FormLabel sx={{ mb: 0 }}>Summary</FormLabel>
                  <IconButton
                    variant="solid"
                    color="primary"
                    size="sm"
                    onClick={handleGenerateSummary}
                    loading={isGeneratingSummary}
                    disabled={!content || isGeneratingSummary}
                    sx={{
                      width: 20,
                      height: 20,
                      minWidth: 20,
                      minHeight: 20,
                      borderRadius: '4px',
                    }}
                  >
                    <AutoAwesome sx={{ fontSize: 12, color: 'white' }} />
                  </IconButton>
                </Box>
                <ShimmerWrapper isShimmering={shimmeringField === 'summary'} fieldName="summary">
                  {isEditing ? (
                    <Textarea
                      value={summary}
                      onChange={e => setSummary(e.target.value)}
                      placeholder="Brief summary/excerpt"
                      minRows={2}
                      maxRows={4}
                      data-testid="preview-summary-input"
                    />
                  ) : (
                    <Typography level="body-md" sx={{ mt: 1, fontStyle: 'italic', color: 'text.secondary' }}>
                      {summary}
                    </Typography>
                  )}
                </ShimmerWrapper>
              </FormControl>

              {/* Featured Image */}
              <FormControl>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <FormLabel sx={{ mb: 0 }}>Featured Image</FormLabel>
                  <IconButton
                    variant="solid"
                    color="primary"
                    size="sm"
                    onClick={generateFeaturedImage}
                    loading={isGeneratingImage}
                    disabled={!content || isGeneratingImage}
                    sx={{
                      width: 20,
                      height: 20,
                      minWidth: 20,
                      minHeight: 20,
                      borderRadius: '4px',
                    }}
                    title="Generate featured image from blog content with AI"
                  >
                    <AutoAwesome sx={{ fontSize: 12, color: 'white' }} />
                  </IconButton>
                </Box>

                {featuredImageUrl ? (
                  <Box sx={{ position: 'relative', width: '100%', maxWidth: 400 }}>
                    <img
                      src={featuredImageUrl}
                      alt="Featured"
                      style={{ width: '100%', borderRadius: '8px', display: 'block' }}
                    />
                    <IconButton
                      size="sm"
                      color="danger"
                      onClick={() => setFeaturedImageUrl('')}
                      sx={{ position: 'absolute', top: 8, right: 8 }}
                    >
                      <CloseIcon />
                    </IconButton>
                  </Box>
                ) : (
                  <ButtonGroup variant="outlined" sx={{ gap: 1 }}>
                    <Button
                      component="label"
                      startDecorator={<AddPhotoAlternate />}
                      loading={isUploadingFeaturedImage}
                      disabled={isUploadingFeaturedImage || isGeneratingImage}
                    >
                      Upload Featured Image
                      <input
                        type="file"
                        hidden
                        accept="image/*"
                        onChange={handleFeaturedImageUpload}
                        data-testid="featured-image-upload"
                      />
                    </Button>
                    <Button
                      startDecorator={<Collections />}
                      onClick={imageBrowser.openImageBrowser}
                      disabled={isUploadingFeaturedImage || isGeneratingImage}
                      data-testid="browse-fabfiles-btn"
                    >
                      Browse My Images
                    </Button>
                  </ButtonGroup>
                )}
              </FormControl>

              {/* Publish Date */}
              <FormControl>
                <FormLabel>
                  <CalendarToday sx={{ fontSize: 16, mr: 0.5, verticalAlign: 'middle' }} />
                  Publish Date (Optional)
                </FormLabel>
                {isEditing ? (
                  <>
                    <Input
                      type="datetime-local"
                      value={publishedAt ? new Date(publishedAt).toISOString().slice(0, 16) : ''}
                      onChange={e => {
                        const dateValue = e.target.value;
                        if (dateValue) {
                          setPublishedAt(new Date(dateValue).getTime());
                        } else {
                          setPublishedAt(undefined);
                        }
                      }}
                      data-testid="preview-publish-date-input"
                    />
                    <Typography level="body-xs" sx={{ color: 'neutral.500', mt: 0.5 }}>
                      Used for sorting posts. Defaults to current time if not set.
                    </Typography>
                  </>
                ) : (
                  <Typography level="body-md" sx={{ mt: 1 }}>
                    {publishedAt ? new Date(publishedAt).toLocaleDateString() : 'Will be set to current time'}
                  </Typography>
                )}
              </FormControl>

              {/* Tags */}
              <FormControl>
                <FormLabel>Tags</FormLabel>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1, mb: 1 }}>
                  {tags.map((tag, idx) => (
                    <Chip key={idx} size="sm" variant="outlined" color="primary" sx={{ borderRadius: 'sm' }}>
                      <Stack direction="row" alignItems="center" spacing={0.5}>
                        <Typography level="body-sm">{tag}</Typography>
                        <IconButton size="sm" variant="plain" onClick={() => handleRemoveTag(tag)}>
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    </Chip>
                  ))}
                </Box>
                <Input
                  value={newTagInput}
                  onChange={e => setNewTagInput(e.target.value)}
                  onKeyDown={handleTagInputKeyDown}
                  placeholder="Add a tag and press Enter"
                  data-testid="preview-tags-input"
                  size="sm"
                />
              </FormControl>

              {/* Content */}
              <FormControl>
                <FormLabel>Content</FormLabel>
                <Box sx={{ mt: 1 }} onPaste={handlePaste} onDrop={handleDrop} onDragOver={e => e.preventDefault()}>
                  <MDEditor
                    value={content}
                    onChange={(value?: string) => setContent(value || '')}
                    height={500}
                    data-color-mode="light"
                    preview={isEditing ? 'edit' : 'preview'}
                    hideToolbar={!isEditing}
                    data-testid="preview-content-input"
                  />
                </Box>
              </FormControl>
            </Stack>
          </DialogContent>

          <DialogActions>
            <Button variant="plain" color="neutral" onClick={handleClose} startDecorator={<CloseIcon />}>
              Cancel
            </Button>

            {!isEditing && (
              <Button
                variant="outlined"
                color="neutral"
                onClick={() => setIsEditing(true)}
                startDecorator={<Edit />}
                data-testid="edit-content-btn"
              >
                Edit
              </Button>
            )}

            {isEditing && (
              <Button
                variant="outlined"
                color="primary"
                onClick={() => setIsEditing(false)}
                data-testid="done-editing-btn"
              >
                Done Editing
              </Button>
            )}

            <Button
              variant="outlined"
              color="neutral"
              onClick={() => handlePublish('draft')}
              disabled={!title || !content || isPublishing}
              loading={isPublishing}
              data-testid="save-draft-btn"
            >
              Save as Draft
            </Button>

            <Button
              variant="solid"
              color="primary"
              onClick={() => handlePublish('published')}
              startDecorator={<Send />}
              disabled={!title || !content || isPublishing}
              loading={isPublishing}
              data-testid="publish-btn"
            >
              Publish to Blog
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Image Browser Modal for selecting from existing FabFiles */}
      <ImageBrowserModal
        isOpen={imageBrowser.isImageBrowserOpen}
        onClose={imageBrowser.closeImageBrowser}
        imageSearch={imageBrowser.imageSearch}
        onImageSearchChange={imageBrowser.setImageSearch}
        isLoadingImages={imageBrowser.isLoadingImages}
        imageFiles={imageBrowser.imageFiles}
        selectedImage={imageBrowser.selectedImage}
        onSelectImage={imageBrowser.selectImage}
        onApplyImage={file => {
          if (file.id) {
            handleSelectFabFileImage(file.id);
            imageBrowser.closeImageBrowser();
          }
        }}
        onSearch={() => imageBrowser.fetchImageFiles(imageBrowser.imageSearch)}
      />
    </>
  );
};

export default memo(ContentPreviewModal);
