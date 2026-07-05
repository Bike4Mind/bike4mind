import React, { useEffect, useState, useCallback } from 'react';
import Script from 'next/script';
import { unique } from '@client/app/utils/themes/colors';

// Type assertion for Script component with proper typing
interface ScriptComponentProps {
  strategy?: string;
  onLoad?: () => void;
  onError?: () => void;
}
const ScriptComponent = Script as React.ComponentType<ScriptComponentProps>;
import { Button, Select, Option, IconButton, Input, CircularProgress } from '@mui/joy';
import {
  Google as GoogleIcon,
  Folder,
  Description,
  Image,
  FilePresent,
  MoreVert,
  Download,
  Share,
  BorderAll,
  Slideshow,
  Search,
  Upload,
} from '@mui/icons-material';
import { toast } from 'sonner';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { IFabFileDocument, IShareableDocument, KnowledgeType } from '@bike4mind/common';
import { useConfig } from '@client/app/hooks/data/settings';

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents';

interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
}

declare global {
  interface Window {
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: any) => void;
          }) => google.accounts.oauth2.TokenClient;
          revoke: (token: string, callback: () => void) => void;
        };
      };
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace google {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace accounts {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace oauth2 {
      interface TokenClient {
        requestAccessToken: (options: { prompt?: string }) => void;
        access_token: string;
      }
    }
  }
}

// Mapping of MIME types to friendly names and icons
const mimeTypeInfo: { [key: string]: { name: string; icon: React.ReactElement } } = {
  'application/vnd.google-apps.folder': { name: 'Folder', icon: <Folder /> },
  'application/vnd.google-apps.document': { name: 'Google Docs', icon: <Description /> },
  'application/vnd.google-apps.spreadsheet': { name: 'Google Sheets', icon: <BorderAll /> },
  'application/vnd.google-apps.presentation': { name: 'Google Slides', icon: <Slideshow /> },
  'application/pdf': { name: 'PDF', icon: <Description /> },
  'image/jpeg': { name: 'JPEG Image', icon: <Image titleAccess="JPEG Image" /> },
  'image/png': { name: 'PNG Image', icon: <Image titleAccess="PNG Image" /> },
  'text/plain': { name: 'Plain Text', icon: <Description /> },
  'application/zip': { name: 'ZIP Archive', icon: <FilePresent /> },
};

const getFileInfo = (mimeType: string) => {
  return mimeTypeInfo[mimeType] || { name: 'Other', icon: <FilePresent /> };
};

interface FileRowProps {
  file: GoogleDriveFile;
}

interface GoogleDriveProps {
  onFileProcessed?: (fabFile: IFabFileDocument | IShareableDocument) => void;
  existingAccessToken?: string;
  tokenExpiry?: string;
}

const GoogleDrive: React.FC<GoogleDriveProps> = ({ onFileProcessed, existingAccessToken, tokenExpiry }) => {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [files, setFiles] = useState<GoogleDriveFile[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<any[]>([]);
  const [fileTypes, setFileTypes] = useState<string[]>([]);
  const [selectedFileType, setSelectedFileType] = useState<string>('All');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [tokenClient, setTokenClient] = useState<google.accounts.oauth2.TokenClient | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [processingFile, setProcessingFile] = useState<string | null>(null);
  const { data: config } = useConfig();

  const googleClientId = config?.googleClientId;

  const listFiles = useCallback(async (token: string, searchQuery: string = '') => {
    try {
      // Build the API URL with search query if provided
      let apiUrl = 'https://www.googleapis.com/drive/v3/files?fields=files(id,name,mimeType,thumbnailLink)';
      if (searchQuery.trim()) {
        const encodedQuery = encodeURIComponent(`name contains '${searchQuery.trim()}'`);
        apiUrl += `&q=${encodedQuery}`;
      }

      const response = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (data.files) {
        setFiles(data.files);
        setFilteredFiles(data.files);
      } else {
        setError('No files found or error in response');
        console.error('API Response:', data);
      }
    } catch (error) {
      if (error instanceof Error) {
        setError(`Error listing files: ${error.message}`);
        console.error('Fetch error:', error);
      } else {
        setError('Error listing files: An unknown error occurred');
        console.error('Fetch error: An unknown error occurred', error);
      }
    }
  }, []);

  const handleCredentialResponse = useCallback(
    async (tokenResponse: any) => {
      console.log('Received token response:', tokenResponse);
      if (tokenResponse && tokenResponse.access_token) {
        setIsSignedIn(true);
        setAccessToken(tokenResponse.access_token);
        await listFiles(tokenResponse.access_token, searchTerm);
      } else {
        setError('Failed to get access token');
        console.error('Token response error:', tokenResponse);
      }
    },
    [searchTerm, listFiles]
  );

  const filterFiles = useCallback(() => {
    let filtered = files;

    if (selectedFileType !== 'All') {
      filtered = filtered.filter(file => getFileInfo(file.mimeType).name === selectedFileType);
    }

    if (searchTerm) {
      const lowerSearchTerm = searchTerm.toLowerCase();
      filtered = filtered.filter(file => file.name.toLowerCase().includes(lowerSearchTerm));
    }

    setFilteredFiles(filtered);
  }, [files, selectedFileType, searchTerm]);

  useEffect(() => {
    if (!googleClientId) return; // Exit if clientId is not yet available

    const initializeGoogleSignIn = () => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        try {
          const client = window.google.accounts.oauth2.initTokenClient({
            client_id: googleClientId,
            scope: SCOPES,
            callback: handleCredentialResponse,
          });
          setTokenClient(client);
        } catch (err) {
          setError(`Failed to initialize Google Sign-In: ${err}`);
          console.error('Initialization error:', err);
        }
      } else {
        setError('Google Identity Services library not loaded properly');
      }
    };

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = initializeGoogleSignIn;
    script.onerror = () => {
      setError('Failed to load Google Identity Services script');
      console.error('Script loading error');
    };
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, [googleClientId, handleCredentialResponse]);

  useEffect(() => {
    if (files.length > 0) {
      const types = Array.from(new Set(files.map(file => getFileInfo(file.mimeType).name)));
      setFileTypes(['All', ...types].sort((a, b) => (a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b))));
      filterFiles();
    }
  }, [files, filterFiles]);

  const handleSignInClick = () => {
    if (tokenClient) {
      tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
      setError('Token client not initialized');
    }
  };

  const handleSignOutClick = () => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2 && tokenClient) {
      window.google.accounts.oauth2.revoke(tokenClient.access_token, () => {
        setIsSignedIn(false);
        setFiles([]);
        setFilteredFiles([]);
        setSelectedFileType('All');
        setSearchTerm('');
      });
    }
  };

  const handleFileTypeChange = (event: React.SyntheticEvent | null, newValue: string | null) => {
    if (newValue !== null) {
      setSelectedFileType(newValue);
    }
  };

  const handleSearchChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const newSearchTerm = event.target.value;
    setSearchTerm(newSearchTerm);

    // Perform live search with Google Drive API
    if (accessToken) {
      await listFiles(accessToken, newSearchTerm);
    }
  };

  const onFileProcessComplete = useCallback(
    (fabfile: IFabFileDocument | IShareableDocument) => {
      console.log('File process completed:', fabfile);
      if (onFileProcessed) {
        onFileProcessed(fabfile);
      }
    },
    [onFileProcessed]
  );

  const exportAndProcessGoogleDoc = useCallback(
    async (fileId: string, fileName: string) => {
      setProcessingFile(fileId);
      try {
        if (!accessToken) {
          throw new Error('Access token is not available');
        }

        // Step 1: Export the Google Doc to plain text
        console.log(`Exporting with token: ${accessToken}`);
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const textContent = await response.text();

        // Step 2: Process the text content
        const buffer = Buffer.from(textContent);

        const data = {
          type: KnowledgeType.FILE,
          fileName: fileName,
          mimeType: 'text/plain',
          fileSize: buffer.length,
        };

        // Create a File object instead of a Blob
        const file = new File([buffer], fileName, { type: 'text/plain', lastModified: Date.now() });

        // Step 3: Upload to your knowledge processor
        const fabFile = await createFabFileOnServerWithUpload(data, file);
        onFileProcessComplete(fabFile);
        toast.success('File processed and uploaded successfully');
      } catch (error) {
        console.error('Error processing Google Doc:', error);
        setError(`Error processing ${fileName}: ${error}`);
        toast.error('Failed to process and upload file');
      } finally {
        setProcessingFile(null);
      }
    },
    [accessToken, onFileProcessComplete]
  );

  const FileRow: React.FC<FileRowProps> = ({ file }) => {
    const fileRowClassName = 'google-drive-file-row';
    const fileInfo = getFileInfo(file.mimeType);
    const [thumbnailError, setThumbnailError] = useState(false);

    const handleProcessClick = () => {
      if (file.mimeType === 'application/vnd.google-apps.document') {
        exportAndProcessGoogleDoc(file.id, file.name);
      }
    };

    const handleThumbnailError = (e: any) => {
      console.error(
        'Thumbnail failed to load for:',
        file.name,
        'URL:',
        `${file.thumbnailLink}?access_token=${accessToken?.substring(0, 20)}...`
      );
      setThumbnailError(true);
    };

    return (
      <div
        className={fileRowClassName}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px',
          margin: '5px 0',
          borderRadius: '8px',
          backgroundColor: unique.lightGrayBackground,
        }}
      >
        <div
          style={{
            marginRight: '10px',
            width: '32px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {file.thumbnailLink && !thumbnailError ? (
            <img
              className="google-drive-file-thumbnail"
              src={file.thumbnailLink}
              alt={file.name}
              style={{ width: '32px', height: '32px', objectFit: 'cover', borderRadius: '4px' }}
              onError={handleThumbnailError}
              onLoad={() => console.log('Thumbnail loaded successfully for:', file.name)}
            />
          ) : (
            <div
              className="google-drive-file-icon"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: '#f5f5f5',
                borderRadius: '4px',
                width: '32px',
                height: '32px',
              }}
            >
              {fileInfo.icon}
            </div>
          )}
        </div>
        <div
          className="google-drive-file-name"
          style={{ flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {file.name}
        </div>
        <div className="google-drive-files-container">
          {file.mimeType === 'application/vnd.google-apps.document' && (
            <IconButton
              className="google-drive-process-button"
              size="sm"
              variant="plain"
              color="neutral"
              title="Process and Upload to Knowledge Base"
              onClick={handleProcessClick}
              disabled={processingFile === file.id}
            >
              {processingFile === file.id ? <CircularProgress size="sm" /> : <Upload />}
            </IconButton>
          )}
          <IconButton
            className="google-drive-download-button"
            size="sm"
            variant="plain"
            color="neutral"
            title="Download"
          >
            <Download />
          </IconButton>
          <IconButton className="google-drive-share-button" size="sm" variant="plain" color="neutral" title="Share">
            <Share />
          </IconButton>
          <IconButton
            className="google-drive-more-options-button"
            size="sm"
            variant="plain"
            color="neutral"
            title="More options"
          >
            <MoreVert />
          </IconButton>
        </div>
      </div>
    );
  };

  if (!googleClientId) {
    return null;
  }

  return (
    <div
      className="google-drive-container"
      style={{ width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
    >
      <ScriptComponent
        strategy="afterInteractive"
        onLoad={() => {
          console.log('Google Identity Services script loaded');
          if (window.google) {
            setTokenClient(
              window.google.accounts.oauth2.initTokenClient({
                client_id: googleClientId,
                scope: SCOPES,
                callback: handleCredentialResponse,
              })
            );
          }
        }}
        onError={() => {
          setError('Failed to load Google Identity Services script');
          console.error('Script loading error');
        }}
      />
      {error && (
        <p className="google-drive-error" style={{ color: 'red' }}>
          {error}
        </p>
      )}
      <Button
        className={isSignedIn ? 'google-drive-signout-button' : 'google-drive-signin-button'}
        variant="outlined"
        onClick={isSignedIn ? handleSignOutClick : handleSignInClick}
        disabled={!googleClientId}
        sx={{
          width: '100%',
          textAlign: 'center',
          backgroundColor: isSignedIn ? 'neutral.main' : 'transparent',
          color: isSignedIn ? 'success.main' : 'neutral.main',
          border: '1px solid',
          borderColor: isSignedIn ? 'success.main' : 'transparent',
          '&:hover': {
            backgroundColor: isSignedIn ? 'neutral.light' : 'transparent',
            borderColor: isSignedIn ? 'success.main' : 'neutral.main',
          },
        }}
      >
        <GoogleIcon sx={{ marginRight: '0.5vw' }} color={isSignedIn ? 'success' : 'secondary'} />
        {isSignedIn ? 'Sign Out' : 'Sign In with Google'}
      </Button>
      {isSignedIn && (
        <div>
          <h2 className="google-drive-files-title">Your Files:</h2>
          <div
            className="google-drive-controls"
            style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}
          >
            <Input
              className="google-drive-search-input"
              startDecorator={<Search />}
              placeholder="Search files..."
              value={searchTerm}
              onChange={handleSearchChange}
              sx={{ width: '60%' }}
            />
            <Select
              className="google-drive-file-type-select"
              value={selectedFileType}
              onChange={handleFileTypeChange}
              sx={{ width: '35%' }}
            >
              {fileTypes.map(type => (
                <Option key={type} value={type}>
                  {type}
                </Option>
              ))}
            </Select>
          </div>
          {filteredFiles.length > 0 ? (
            <div className="google-drive-file-list">
              {filteredFiles.map(file => (
                <FileRow key={file.id} file={file} />
              ))}
            </div>
          ) : (
            <p className="google-drive-no-files">No files found matching the selected criteria.</p>
          )}
        </div>
      )}
    </div>
  );
};

export default GoogleDrive;
