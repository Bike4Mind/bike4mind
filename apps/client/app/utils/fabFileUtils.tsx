import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import axios from 'axios';
import {
  Description,
  Article as ArticleIcon,
  Code as CodeIcon,
  Dashboard as DashboardIcon,
  DataObject as DataObjectIcon,
  InsertDriveFile as InsertDriveFileIcon,
  PictureAsPdf as PictureAsPdfIcon,
  TableChart as TableChartIcon,
  Slideshow as SlideshowIcon,
  TextSnippet as TextSnippetIcon,
  Tag as TagIcon,
} from '@mui/icons-material';
import { Box } from '@mui/joy';
import {
  IFabFileDocument,
  isImageServeable,
  ISessionDocument,
  KnowledgeType,
  SettingKey,
  SupportedFabFileMimeTypes,
} from '@bike4mind/common';
import { FC, useState } from 'react';
import { toast } from 'sonner';
import { useGetSettingsValue } from '../hooks/data/settings';
import { api } from '../contexts/ApiContext';
import { ImageModerationPlaceholder } from '../components/Session/ImageModerationPlaceholder';
import { createFabFileOnServerWithUpload } from './filesAPICalls';

// Cache for settings
let settingsCache: Record<string, any> = {};
let settingsCacheExpiry = 0;

// Default value used as fallback
export const MAX_CONTENT_LENGTH = 50000;

/**
 * Gets a setting value, with caching to avoid too many API calls
 */
export const getSetting = async (key: SettingKey): Promise<any> => {
  const now = Date.now();
  // Refresh cache every 60 seconds
  if (now > settingsCacheExpiry) {
    try {
      const { data } = await api.get('/api/settings/fetch');
      settingsCache = data.reduce((acc: Record<string, any>, setting: any) => {
        acc[setting.settingName] = setting.settingValue;
        return acc;
      }, {});
      settingsCacheExpiry = now + 60000; // Cache for 1 minute
    } catch (error) {
      console.error('Error fetching settings:', error);
    }
  }

  return settingsCache[key] ?? null;
};

/**
 * Gets the max content length setting value with fallback
 */
export const getMaxContentLength = async (): Promise<number> => {
  const maxContentLength = await getSetting('MaxContentLength');
  return maxContentLength ?? MAX_CONTENT_LENGTH;
};

/**
 * Determines if a buffer likely contains text content
 */
function isBufferLikelyText(buffer: Buffer): boolean {
  // Allowed control characters
  const allowedControlChars = new Set([0x09, 0x0a, 0x0d]); // tab, LF, CR
  // Binary threshold - if more than 10% is binary, assume it's not text
  const binaryThreshold = 0.1;
  let binaryCount = 0;

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    // Check for control characters that aren't in our allowed set
    if (byte < 0x20 && !allowedControlChars.has(byte)) {
      binaryCount++;
      if (binaryCount / buffer.length > binaryThreshold) {
        return false;
      }
    }
  }
  return true;
}

export async function extractTextFromFile(type: string, arrayBuffer: ArrayBuffer): Promise<string> {
  // When called from the browser, buffer is of type ArrayBuffer
  // When called from the server, buffer is of type Buffer
  const clientSide = typeof window !== 'undefined';
  let content = '';
  switch (type) {
    case SupportedFabFileMimeTypes.PDF: {
      const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(arrayBuffer)));
      const { text } = await extractText(pdf, { mergePages: true });
      content = text as string; // Text should be a string due to mergePages: true
      break;
    }
    case SupportedFabFileMimeTypes.DOCX:
      try {
        const options = clientSide ? { arrayBuffer } : { buffer: Buffer.from(arrayBuffer) };
        const result = await mammoth.extractRawText(options);
        content = result.value; // The raw text
        // Handle any warnings
        const messages = result.messages;
        if (messages.length > 0) {
          console.warn('Mammoth message: ', messages);
        }
      } catch (error) {
        console.error('Error extracting text from docx:', error);
      }
      break;
    case SupportedFabFileMimeTypes.XLS:
    case SupportedFabFileMimeTypes.XLSX:
      try {
        const XLSX = await import('xlsx');
        const buffer = Buffer.from(arrayBuffer);
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        // Convert all sheets to text
        content = workbook.SheetNames.map(name => {
          const sheet = workbook.Sheets[name];
          return `Sheet: ${name}\n${XLSX.utils.sheet_to_txt(sheet)}`;
        }).join('\n\n');
      } catch (error) {
        console.error('Error extracting text from Excel file:', error);
        throw new Error('Failed to extract text from Excel file');
      }
      break;
    case SupportedFabFileMimeTypes.TXT_MARKDOWN:
    case SupportedFabFileMimeTypes.TXT_MD_LEGACY:
    case SupportedFabFileMimeTypes.JSON:
    case SupportedFabFileMimeTypes.HTML:
    case SupportedFabFileMimeTypes.CSV:
    case SupportedFabFileMimeTypes.TXT_PLAIN:
    case SupportedFabFileMimeTypes.TS:
    case SupportedFabFileMimeTypes.JS:
    case SupportedFabFileMimeTypes.JSX:
    case SupportedFabFileMimeTypes.PY:
    case SupportedFabFileMimeTypes.JAVA:
    case SupportedFabFileMimeTypes.CPP:
    case SupportedFabFileMimeTypes.CS:
    case SupportedFabFileMimeTypes.PHP:
    case SupportedFabFileMimeTypes.RUBY:
    case SupportedFabFileMimeTypes.GO:
    case SupportedFabFileMimeTypes.SWIFT:
    case SupportedFabFileMimeTypes.KOTLIN:
    case SupportedFabFileMimeTypes.RUST:
    case SupportedFabFileMimeTypes.CSS:
    case SupportedFabFileMimeTypes.LESS:
    case SupportedFabFileMimeTypes.SASS:
    case SupportedFabFileMimeTypes.SCSS:
    case SupportedFabFileMimeTypes.YAML:
    case SupportedFabFileMimeTypes.TOML:
    case SupportedFabFileMimeTypes.SH:
    case SupportedFabFileMimeTypes.BASH:
      content = Buffer.from(arrayBuffer).toString();
      break;
    case SupportedFabFileMimeTypes.JPG:
    case SupportedFabFileMimeTypes.PNG:
    case SupportedFabFileMimeTypes.WEBP:
    case SupportedFabFileMimeTypes.GIF:
    case SupportedFabFileMimeTypes.SVG:
      // Images don't have text to extract
      break;
    default: {
      const buffer = Buffer.from(arrayBuffer);
      // Try to handle as plain text only if it looks like text
      if (buffer.length > 0 && isBufferLikelyText(buffer)) {
        content = buffer.toString();
        console.log(`Treating unknown MIME type ${type} as plain text`);
      } else {
        console.error(`Cannot safely treat file as text`);
        throw new Error(`Unsupported file type: ${type}`);
      }
    }
  }

  // Get the max content length from settings or fallback to default
  const maxLength = await getMaxContentLength();

  // Apply content length limit to all text content
  return truncateContent(content, maxLength);
}

export function truncateContent(content: string, maxLength: number = MAX_CONTENT_LENGTH) {
  if (content.length > maxLength) {
    content = content.substring(0, maxLength);
    // Append ellipsis unless content already ends in } or ]
    if (content[content.length - 1] !== '}' && content[content.length - 1] !== ']') {
      content += '...';
    }
  }
  return content;
}

// Hook to get the max content length from settings
export function useMaxContentLength() {
  const maxContentLength = useGetSettingsValue('MaxContentLength');
  return maxContentLength ?? MAX_CONTENT_LENGTH; // Fallback to default if not set
}

export const getContentFromFabfile = async ({
  fileUrl,
  mimeType,
  bustCache = false,
}: {
  fileUrl?: string;
  mimeType?: string;
  bustCache?: boolean;
}) => {
  if (!fileUrl || !mimeType) {
    console.warn('Missing fileUrl or mimeType:', { fileUrl, mimeType });
    return '';
  }
  try {
    // Only add cache-busting headers when explicitly requested (e.g., after AI edits)
    // Can't modify the URL query string for S3 signed URLs - it would break the signature
    const headers = bustCache
      ? {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        }
      : {};

    const fileBuffer = await axios.get<ArrayBuffer>(fileUrl, {
      responseType: 'arraybuffer',
      headers,
    });
    const content = await extractTextFromFile(mimeType, fileBuffer.data);
    // No need to truncate here as extractTextFromFile already does it
    return content;
  } catch (error) {
    console.error('Error fetching file:', error);
    return '';
  }
};

/**
 * Renames duplicate files by appending a numerical suffix to the file name.
 * This ensures that all file names in the array are unique.
 *
 * @param items - An array of items, each containing a fileName property.
 * @returns A new array of items with unique file names.
 */
export function renameDuplicateFiles<T extends { fileName: string }>(items: T[]): T[] {
  const nameCount: { [key: string]: number } = {};

  return items.map(item => {
    const name = item.fileName;
    if (!nameCount[name]) {
      nameCount[name] = 1;
    } else {
      nameCount[name] += 1;
    }

    const count = nameCount[name];
    if (count > 1) {
      item.fileName = `${name}(${count - 1})`;
    }

    return item;
  });
}

export const convertFileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(reader.result as string);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

interface GetFileIconProps {
  file: IFabFileDocument;
  size?: number;
  previewSize?: number;
  color?: string | ((theme: any) => string);
}

export const GetFileIcon: FC<GetFileIconProps> = ({ file, size = 48, previewSize = 48, color }) => {
  const [imageError, setImageError] = useState(false);

  // Check if it's an image file
  if (file.mimeType?.startsWith('image/')) {
    // Content-moderation gating: a blocked image never gets a
    // serveable URL; a pending (not-yet-clean) image may briefly have one
    // cached but must not be shown until the scan completes.
    if (file.moderationStatus === 'blocked') {
      return <ImageModerationPlaceholder status="blocked" size={previewSize} />;
    }
    if (!isImageServeable(file)) {
      return <ImageModerationPlaceholder status="scanning" size={previewSize} />;
    }

    // Only render image if fileUrl or presignedUrl exists and no error occurred
    const imageUrl = file.fileUrl || file.presignedUrl;

    if (imageUrl && !imageError) {
      return (
        <Box
          component="img"
          src={imageUrl}
          alt={file.fileName}
          loading="lazy"
          sx={{
            width: `${previewSize}px`,
            height: `${previewSize}px`,
            objectFit: 'cover',
            borderRadius: '4px',
          }}
          onError={() => {
            setImageError(true);
          }}
        />
      );
    }
    // Fallback to generic image icon if URL is not available or image failed to load
    return <InsertDriveFileIcon sx={{ fontSize: size, fill: color }} />;
  }

  // For non-image files, use the existing icon logic
  const IconComponent =
    file.type === KnowledgeType.URL
      ? InsertDriveFileIcon
      : {
          // Documents
          [SupportedFabFileMimeTypes.PDF]: PictureAsPdfIcon,
          [SupportedFabFileMimeTypes.DOCX]: TextSnippetIcon,
          [SupportedFabFileMimeTypes.PPTX]: SlideshowIcon,
          [SupportedFabFileMimeTypes.XLS]: TableChartIcon,
          [SupportedFabFileMimeTypes.XLSX]: TableChartIcon,
          // Text / markup
          [SupportedFabFileMimeTypes.TXT_PLAIN]: ArticleIcon,
          [SupportedFabFileMimeTypes.TXT_MARKDOWN]: DashboardIcon,
          [SupportedFabFileMimeTypes.TXT_MD_LEGACY]: DashboardIcon,
          [SupportedFabFileMimeTypes.HTML]: CodeIcon,
          [SupportedFabFileMimeTypes.XML]: TagIcon,
          // Data
          [SupportedFabFileMimeTypes.JSON]: Description,
          [SupportedFabFileMimeTypes.CSV]: DataObjectIcon,
          [SupportedFabFileMimeTypes.YAML]: DataObjectIcon,
          [SupportedFabFileMimeTypes.TOML]: DataObjectIcon,
        }[file.mimeType] || InsertDriveFileIcon;

  return <IconComponent sx={{ fontSize: size, fill: color }} />;
};

export const saveToFileAndWorkbench = async (
  contentType: string,
  fileName: string,
  content: string,
  workBenchFiles: IFabFileDocument[],
  currentSessionId: string | null,
  currentSession: ISessionDocument | null,
  autoRename: boolean = true
) => {
  const mimeType =
    contentType === 'Markdown' ? SupportedFabFileMimeTypes.TXT_MARKDOWN : SupportedFabFileMimeTypes.TXT_PLAIN;

  const file = new File([content], fileName, { type: mimeType });

  const data = {
    type: KnowledgeType.FILE,
    fileName,
    mimeType,
    fileSize: file.size,
  };

  let fabFile = await createFabFileOnServerWithUpload(data, file);

  // Auto-rename the file if enabled
  if (autoRename) {
    try {
      // Call auto-rename API to get suggested name
      const renameResponse = await api.post<{
        fileId: string;
        currentName: string;
        suggestedName: string;
        model: string;
      }>(`/api/fabfiles/${fabFile.id}/auto-rename`);

      const { suggestedName } = renameResponse.data;

      // Apply the suggested rename
      const updatedFileResponse = await api.post<IFabFileDocument>(`/api/fabfiles/${fabFile.id}/apply-auto-rename`, {
        newFileName: suggestedName,
      });

      fabFile = updatedFileResponse.data;

      // Notify user of successful rename
      toast.success(`File renamed to: ${fabFile.fileName}`, {
        duration: 4000,
      });
    } catch (error) {
      // If auto-rename fails, just continue with the original file
      console.warn('Auto-rename failed, using original filename:', error);
      toast.success(`Saved as ${contentType} file`);
    }
  } else {
    // Auto-rename disabled, show generic success message
    toast.success(`Saved as ${contentType} file`);
  }

  // Add to workbench
  const newWorkBenchFiles = [...workBenchFiles, fabFile];

  return newWorkBenchFiles;
};
