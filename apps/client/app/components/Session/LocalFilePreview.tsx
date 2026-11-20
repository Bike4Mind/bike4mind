import React, { useEffect, useRef, useState } from 'react';
import { Box } from '@mui/joy';
import { isImageAttachment } from '@bike4mind/common';
import { renderPdfFirstPage } from '@client/app/utils/renderPdfFirstPage';
import { useStableCallback } from '@client/app/hooks/useStableCallback';

export type LocalPreviewKind = 'image' | 'pdf' | 'video' | 'text';

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp',
  'hpp', 'cs', 'php', 'sh', 'sql', 'log', 'ini', 'env',
]); // prettier-ignore

// Whole subtypes only: office formats such as `...openxmlformats...` merely contain "xml".
const TEXT_APPLICATION_MIME = /^application\/(json|xml|javascript|x-javascript|yaml|x-yaml|x-sh|sql)$|\+(json|xml)$/;

const TEXT_SAMPLE_BYTES = 2048;

export const fileExtension = (fileName: string) =>
  fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : '';

/** Which in-browser preview a file can get, or null when it only gets its type icon. */
export function localPreviewKind(file: { fileName: string; mimeType?: string }): LocalPreviewKind | null {
  const mime = file.mimeType ?? '';
  if (isImageAttachment(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/') || TEXT_APPLICATION_MIME.test(mime)) return 'text';
  return TEXT_EXTENSIONS.has(fileExtension(file.fileName)) ? 'text' : null;
}

const useObjectUrl = (file: File) => {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(undefined);
    };
  }, [file]);
  return url;
};

const cover = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } as const;

const ImagePreview: React.FC<{ file: File; alt: string }> = ({ file, alt }) => {
  const url = useObjectUrl(file);
  return url ? <Box component="img" src={url} alt={alt} sx={cover} /> : null;
};

const VideoPreview: React.FC<{ file: File; onError: () => void }> = ({ file, onError }) => {
  const url = useObjectUrl(file);
  // `#t=0.1` paints a frame just past the start; the very first one is often black.
  return url ? (
    <Box component="video" src={`${url}#t=0.1`} muted playsInline preload="metadata" onError={onError} sx={cover} />
  ) : null;
};

const PdfPreview: React.FC<{ file: File; size: number; onError: () => void }> = ({ file, size, onError }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    renderPdfFirstPage(file, size, controller.signal)
      .then(rendered => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        canvas.getContext('2d')?.drawImage(rendered, 0, 0);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        console.warn('PDF thumbnail failed, showing the file chip instead:', error);
        onError();
      });
    return () => controller.abort();
  }, [file, size, onError]);

  return <Box component="canvas" ref={canvasRef} sx={{ ...cover, objectPosition: 'top', backgroundColor: '#fff' }} />;
};

const TextPreview: React.FC<{ file: File; onError: () => void }> = ({ file, onError }) => {
  const [text, setText] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    file
      .slice(0, TEXT_SAMPLE_BYTES)
      .text()
      .then(sample => !cancelled && setText(sample))
      .catch(() => !cancelled && onError());
    return () => {
      cancelled = true;
    };
  }, [file, onError]);

  return (
    <Box
      component="pre"
      aria-hidden
      sx={{
        ...cover,
        m: 0,
        p: '6px',
        overflow: 'hidden',
        fontFamily: 'code',
        fontSize: '6.5px',
        lineHeight: 1.35,
        whiteSpace: 'pre',
        color: 'text.secondary',
      }}
    >
      {text}
    </Box>
  );
};

interface LocalFilePreviewProps {
  file: File;
  kind: LocalPreviewKind;
  alt: string;
  size: number;
  onError: () => void;
}

/** A preview of the file the user just attached, drawn from the local copy before (and while) it uploads. */
export const LocalFilePreview: React.FC<LocalFilePreviewProps> = ({ file, kind, alt, size, onError }) => {
  // Stable, so a re-rendering parent does not restart the PDF render or the text read.
  const handleError = useStableCallback(onError);
  switch (kind) {
    case 'image':
      return <ImagePreview file={file} alt={alt} />;
    case 'pdf':
      return <PdfPreview file={file} size={size} onError={handleError} />;
    case 'video':
      return <VideoPreview file={file} onError={handleError} />;
    case 'text':
      return <TextPreview file={file} onError={handleError} />;
  }
};
