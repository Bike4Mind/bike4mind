import React, { useState, ChangeEvent, useRef, useEffect } from 'react';
import { FormControl, Button, FormLabel, Typography, Stack, Box, styled, Checkbox, Divider } from '@mui/joy';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import Compressor from 'compressorjs';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useUpdateSettings, useConfig } from '@client/app/hooks/data/settings';
import { LogoSettings } from '@bike4mind/common';
import { useQueryClient } from '@tanstack/react-query';
import {
  ADMIN_SETTINGS_QUERY_KEY,
  ADMIN_SETTINGS_ARRAY_QUERY_KEY,
  BRANDING_SETTINGS_QUERY_KEY,
} from '@client/app/hooks/data/queryKeys';

export async function compressAdminLogo(file: File, quality: number = 0.8): Promise<File | Blob> {
  return new Promise((resolve, reject) => {
    new Compressor(file, {
      quality,
      maxWidth: 200,
      maxHeight: 200,
      success(blob) {
        resolve(blob);
      },
      error(err) {
        reject(err);
      },
    });
  });
}

const VisuallyHiddenInput = styled('input')`
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  bottom: 0;
  left: 0;
  white-space: nowrap;
  width: 1px;
`;

const AdminLogoUpload: React.FC = () => {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { getSettingObject, refetch } = useAdminSettings();
  const { data: config } = useConfig();
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const darkLogoInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();

  const cdnUrl = config?.cdnUrl || process.env.NEXT_PUBLIC_CDN_URL || '';

  const serverLogoSettings = getSettingObject<LogoSettings>('logoSettings', {
    customLogoUrl: '',
    customDarkLogoUrl: '',
    useBothLogos: false,
  });

  const serverLogoUrl = serverLogoSettings?.customLogoUrl;
  const serverDarkLogoUrl = serverLogoSettings?.customDarkLogoUrl;
  const serverUseBothLogos = serverLogoSettings?.useBothLogos;

  const [localUseBothLogos, setLocalUseBothLogos] = useState(serverUseBothLogos);
  const [localLogoUrl, setLocalLogoUrl] = useState(serverLogoUrl);
  const [localDarkLogoUrl, setLocalDarkLogoUrl] = useState(serverDarkLogoUrl);

  // Helper to construct the full URL, handling both old (full path) and new (filename only) formats
  const buildLogoUrl = (logoPath: string | undefined) => {
    if (!logoPath) return '';
    if (logoPath.startsWith('blob:') || /^https?:\/\//.test(logoPath)) return logoPath;
    // Strip legacy full-path prefix so both stored formats resolve to the same CDN path
    const filename = logoPath.startsWith('admin/logos/') ? logoPath.slice('admin/logos/'.length) : logoPath;
    return `${cdnUrl}/admin-logos/${filename}`;
  };

  const useBothLogos = localUseBothLogos;
  const currentLogoUrl = buildLogoUrl(localLogoUrl);
  const currentDarkLogoUrl = buildLogoUrl(localDarkLogoUrl);

  const accessToken = useAccessToken(s => s.accessToken);
  const updateSettingsMutation = useUpdateSettings();

  // Sync local state with server state when server state changes
  useEffect(() => {
    setLocalUseBothLogos(serverUseBothLogos);
  }, [serverUseBothLogos]);

  useEffect(() => {
    setLocalLogoUrl(serverLogoUrl);
  }, [serverLogoUrl]);

  useEffect(() => {
    setLocalDarkLogoUrl(serverDarkLogoUrl);
  }, [serverDarkLogoUrl]);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      if (localLogoUrl && localLogoUrl.startsWith('blob:')) {
        URL.revokeObjectURL(localLogoUrl);
      }
      if (localDarkLogoUrl && localDarkLogoUrl.startsWith('blob:')) {
        URL.revokeObjectURL(localDarkLogoUrl);
      }
    };
  }, [localLogoUrl, localDarkLogoUrl]);

  const handleUploadLogo = async (e: ChangeEvent<HTMLInputElement>, isDarkMode: boolean = false) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadError(null);

    // Create a preview URL for immediate UI update
    const previewUrl = URL.createObjectURL(file);

    // Optimistically update the UI immediately
    if (isDarkMode) {
      setLocalDarkLogoUrl(previewUrl);
    } else {
      setLocalLogoUrl(previewUrl);
    }

    try {
      const compressedFile = await compressAdminLogo(file);

      // Generate presigned URL and upload
      const response = await fetch('/api/admin/upload-logo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        credentials: 'include', // Include cookies for authentication
        body: JSON.stringify({
          fileName: file.name,
          fileSize: compressedFile.size,
          mimeType: compressedFile.type || file.type,
          isDarkMode,
          useBothLogos: false, // Always false for individual uploads when useBothLogos is true
        }),
      });

      if (!response.ok) {
        // Read as text first; the error body may not be JSON
        const errorText = await response.text();
        console.error('Upload API error response:', errorText);

        let errorMessage = 'Upload failed';
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.message || errorMessage;
        } catch (parseError) {
          // If it's not JSON, use the text as the error message
          errorMessage = `Server error: ${response.status} ${response.statusText}`;
        }

        throw new Error(errorMessage);
      }

      const responseData = await response.json();

      if (responseData.useBothLogos) {
        // Handle dual upload for both light and dark modes
        const { urls, logoUrls } = responseData;

        const lightUploadResponse = await fetch(urls.light, {
          method: 'PUT',
          body: compressedFile,
          headers: {
            'Content-Type': compressedFile.type || file.type,
          },
        });

        const darkUploadResponse = await fetch(urls.dark, {
          method: 'PUT',
          body: compressedFile,
          headers: {
            'Content-Type': compressedFile.type || file.type,
          },
        });

        if (!lightUploadResponse.ok || !darkUploadResponse.ok) {
          throw new Error('Failed to upload file to S3');
        }

        console.log('Both logos uploaded successfully:', logoUrls);

        // Update both local URLs with the final server URLs
        setLocalLogoUrl(logoUrls.light);
        setLocalDarkLogoUrl(logoUrls.dark);
      } else {
        // Handle single upload
        const { url: presignedUrl, fileKey } = responseData;

        const uploadResponse = await fetch(presignedUrl, {
          method: 'PUT',
          body: compressedFile,
          headers: {
            'Content-Type': compressedFile.type || file.type,
          },
        });

        if (!uploadResponse.ok) {
          throw new Error('Failed to upload file to S3');
        }

        // Update with the S3 key (not full URL - will be combined with cdnUrl later)
        if (isDarkMode) {
          setLocalDarkLogoUrl(fileKey);
        } else {
          setLocalLogoUrl(fileKey);
        }
      }

      URL.revokeObjectURL(previewUrl);

      // Refresh admin settings so logo updates show immediately
      await refetch();

      // Invalidate all admin settings queries to update other components
      await queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_ARRAY_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: BRANDING_SETTINGS_QUERY_KEY });

      // Reset the file input(s)
      if (responseData.useBothLogos) {
        // Reset both inputs when uploading to both modes
        if (logoInputRef.current) {
          logoInputRef.current.value = '';
        }
        if (darkLogoInputRef.current) {
          darkLogoInputRef.current.value = '';
        }
      } else {
        // Reset only the relevant input
        if (isDarkMode && darkLogoInputRef.current) {
          darkLogoInputRef.current.value = '';
        } else if (!isDarkMode && logoInputRef.current) {
          logoInputRef.current.value = '';
        }
      }

      // Refresh admin settings to get the new logo URL(s)
      await refetch();

      // Invalidate all admin settings queries to update other components
      await queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_ARRAY_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: BRANDING_SETTINGS_QUERY_KEY });
    } catch (error) {
      console.error('Logo upload error:', error);
      setUploadError(error instanceof Error ? error.message : 'Upload failed');

      // Revert optimistic update on error
      URL.revokeObjectURL(previewUrl);
      if (isDarkMode) {
        setLocalDarkLogoUrl(serverDarkLogoUrl);
      } else {
        setLocalLogoUrl(serverLogoUrl);
      }
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveLogo = async (isDarkMode: boolean = false) => {
    setIsUploading(true);
    setUploadError(null);

    // Store current URL for potential revert
    const currentUrl = isDarkMode ? currentDarkLogoUrl : currentLogoUrl;

    // Optimistically update the UI immediately
    if (isDarkMode) {
      setLocalDarkLogoUrl('');
    } else {
      setLocalLogoUrl('');
    }

    try {
      const response = await fetch('/api/admin/upload-logo', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          isDarkMode,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to remove logo');
      }

      // Refresh admin settings
      await refetch();

      // Invalidate all admin settings queries to update other components
      await queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_ARRAY_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: BRANDING_SETTINGS_QUERY_KEY });
    } catch (error) {
      console.error('Logo removal error:', error);
      setUploadError(error instanceof Error ? error.message : 'Failed to remove logo');

      // Revert optimistic update on error
      if (isDarkMode) {
        setLocalDarkLogoUrl(currentUrl);
      } else {
        setLocalLogoUrl(currentUrl);
      }
    } finally {
      setIsUploading(false);
    }
  };

  const handleToggleUseBothLogos = async () => {
    const newValue = !useBothLogos;

    // Immediately update local state for instant UI feedback
    setLocalUseBothLogos(newValue);

    setIsUploading(true);
    setUploadError(null);

    try {
      // Save to server
      const updatedSettings = {
        customLogoUrl: serverLogoSettings?.customLogoUrl || '',
        customDarkLogoUrl: serverLogoSettings?.customDarkLogoUrl || '',
        useBothLogos: newValue,
      };
      await updateSettingsMutation.mutateAsync({
        key: 'logoSettings',
        value: updatedSettings,
      });

      // Turning on useBothLogos: drop the dark logo since the light logo covers both
      if (newValue && currentDarkLogoUrl) {
        await handleRemoveLogo(true);
      }

      // Refresh admin settings
      await refetch();

      // Invalidate all admin settings queries to update other components
      await queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_ARRAY_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: BRANDING_SETTINGS_QUERY_KEY });
    } catch (error) {
      console.error('Toggle setting error:', error);
      setUploadError(error instanceof Error ? error.message : 'Failed to update setting');

      // Revert local state on error
      setLocalUseBothLogos(!newValue);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <FormControl>
      <FormLabel>Custom Logo</FormLabel>
      <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
        Upload custom logos to replace the default application logo. Recommended size: 200x200px or smaller.
      </Typography>

      <Stack direction="column" spacing={3}>
        {/* Toggle for using both light and dark mode logos */}
        <Box>
          <Checkbox
            checked={useBothLogos}
            onChange={handleToggleUseBothLogos}
            disabled={isUploading}
            label="Use same logo for light and dark modes"
          />
          <Typography level="body-sm" sx={{ mt: 0.5, color: 'text.secondary' }}>
            When checked, you can upload same logo for light and dark themes. When unchecked, you can upload separate
            logos for light and dark themes.
          </Typography>
        </Box>

        <Divider />

        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            gap: { xs: 3, md: 8 },
          }}
        >
          {/* Light Mode Logo Section */}
          <Box sx={{ flex: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <LightModeOutlinedIcon sx={{ fontSize: 16 }} />
              <Typography level="title-sm">Light Mode Logo</Typography>
            </Stack>

            {currentLogoUrl && (
              <Box
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 'sm',
                  p: 2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  maxWidth: '200px',
                  mb: 2,
                  backgroundColor: 'background.surface',
                }}
              >
                <img
                  src={currentLogoUrl}
                  alt="Current light mode logo"
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100px',
                    objectFit: 'contain',
                  }}
                />
              </Box>
            )}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Button
                component="label"
                role={undefined}
                tabIndex={-1}
                startDecorator={<CloudUploadOutlinedIcon />}
                loading={isUploading}
                variant="outlined"
                sx={{ width: { xs: '100%', sm: 'auto' } }}
              >
                {currentLogoUrl ? 'Replace Light Logo' : 'Upload Light Logo'}
                <VisuallyHiddenInput
                  type="file"
                  accept="image/*"
                  onChange={e => handleUploadLogo(e, false)}
                  ref={logoInputRef}
                />
              </Button>

              {currentLogoUrl && (
                <Button
                  variant="soft"
                  color="danger"
                  loading={isUploading}
                  onClick={() => handleRemoveLogo(false)}
                  sx={{ width: { xs: '100%', sm: 'auto' } }}
                >
                  Remove
                </Button>
              )}
            </Stack>
          </Box>

          <Divider sx={{ display: { xs: 'block', md: 'none' } }} />
          <Divider orientation="vertical" sx={{ display: { xs: 'none', md: 'block' } }} />

          {/* Dark Mode Logo Section */}
          {/* Only show dark mode upload sections when useBothLogos is FALSE (unchecked) */}
          {!useBothLogos && (
            <Box sx={{ flex: 1 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                <DarkModeOutlinedIcon sx={{ fontSize: 16 }} />
                <Typography level="title-sm">Dark Mode Logo</Typography>
              </Stack>

              {currentDarkLogoUrl && (
                <Box
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 'sm',
                    p: 2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    maxWidth: '200px',
                    mb: 2,
                    backgroundColor: 'neutral.900',
                  }}
                >
                  {}
                  <img
                    src={currentDarkLogoUrl}
                    alt="Current dark mode logo"
                    style={{
                      maxWidth: '100%',
                      maxHeight: '100px',
                      objectFit: 'contain',
                    }}
                  />
                </Box>
              )}

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <Button
                  component="label"
                  role={undefined}
                  tabIndex={-1}
                  startDecorator={<CloudUploadOutlinedIcon />}
                  loading={isUploading}
                  variant="outlined"
                  sx={{ width: { xs: '100%', sm: 'auto' } }}
                >
                  {currentDarkLogoUrl ? 'Replace Dark Logo' : 'Upload Dark Logo'}
                  <VisuallyHiddenInput
                    type="file"
                    accept="image/*"
                    onChange={e => handleUploadLogo(e, true)}
                    ref={darkLogoInputRef}
                  />
                </Button>

                {currentDarkLogoUrl && (
                  <Button
                    variant="soft"
                    color="danger"
                    loading={isUploading}
                    onClick={() => handleRemoveLogo(true)}
                    sx={{ width: { xs: '100%', sm: 'auto' } }}
                  >
                    Remove
                  </Button>
                )}
              </Stack>
            </Box>
          )}
        </Box>

        {uploadError && (
          <Typography level="body-sm" color="danger">
            {uploadError}
          </Typography>
        )}
      </Stack>
    </FormControl>
  );
};

export default AdminLogoUpload;
