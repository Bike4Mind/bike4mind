import { Button } from '@mui/joy';
import { useState, type ComponentProps } from 'react';
import ImageContainer from './ImageContainer';

type Props = Pick<ComponentProps<typeof ImageContainer>, 'src' | 'alt' | 'onSendMessage'>;

export function ReplyMarkdownImage({ src, alt, onSendMessage }: Props) {
  const [approvedSource, setApprovedSource] = useState<string | null>(null);
  if (!src || /^(?:\/mnt\/|\/tmp\/|file:|sandbox:)/i.test(src) || src.includes('/mnt/data/')) return null;
  let imageUrl: URL;
  try {
    imageUrl = new URL(src, typeof window === 'undefined' ? 'https://local.invalid' : window.location.origin);
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(imageUrl.protocol)) return null;

  if (approvedSource !== src) {
    return (
      <Button data-testid="reply-image-load-btn" variant="outlined" title={src} onClick={() => setApprovedSource(src)}>
        {`Load image${alt ? `: ${alt}` : ''} (${src.startsWith('/') && !src.startsWith('//') ? 'this site' : imageUrl.host})`}
      </Button>
    );
  }
  return <ImageContainer src={src} index={0} totalImages={1} images={[src]} alt={alt} onSendMessage={onSendMessage} />;
}
