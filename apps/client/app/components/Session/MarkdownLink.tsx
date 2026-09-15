import { ComponentProps } from 'react';
import { ExtraProps } from 'react-markdown';

/**
 * Anchor renderer for chat-reply markdown (`a:` component in ReactMarkdown).
 *
 * Branches on the href:
 * - In-page anchors (`#...`) scroll within the SPA via `getElementById` instead of
 *   opening a new browser tab. These are GFM footnote markers: an inline ref links
 *   down to its definition (`href="#...-fn-N"`) and a back-ref links back up to the
 *   originating ref (`href="#...-fnref-N"`). Using the default `target="_blank"` here
 *   would open a fresh app instance in a new tab instead of scrolling.
 * - All other links open in a new tab (`target="_blank" rel="noopener noreferrer"`).
 *
 * `...props` is spread onto the rendered `<a>` so the `id` / `data-footnote-*` /
 * `aria-describedby` attributes that remark-gfm puts on footnote refs survive -
 * without them the back-ref scroll targets (`id="...-fnref-N"`) would not exist. In the
 * external branch the spread comes *before* `target`/`rel` so caller props can never
 * clobber those security-critical attributes.
 */
export const link = ({ node, ref, href, children, ...props }: ComponentProps<'a'> & ExtraProps) => {
  if (href?.startsWith('#')) {
    return (
      <a
        href={href}
        {...props}
        onClick={e => {
          e.preventDefault();
          // Reusable across arbitrary markdown content, so guard against a malformed
          // hash (a stray `%` makes decodeURIComponent throw); fall back to the raw id.
          let id: string;
          try {
            id = decodeURIComponent(href.slice(1));
          } catch {
            id = href.slice(1);
          }
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }}
      >
        {children}
      </a>
    );
  }

  return (
    <a href={href} {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
};
