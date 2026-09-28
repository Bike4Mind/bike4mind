import type { ReactNode } from 'react';

/**
 * The handful of 16px glyphs the sidebar needs.
 *
 * Inline rather than from an icon package: the desktop app ships no icon dependency today, and
 * adding one to draw seven shapes would pull a few thousand more into the bundle. They inherit
 * `currentColor`, so a Joy button's own colour and variant still decide how they look.
 */
function Glyph({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlusIcon() {
  return (
    <Glyph>
      <path d="M8 3.5v9M3.5 8h9" />
    </Glyph>
  );
}

export function SearchIcon() {
  return (
    <Glyph>
      <circle cx="7" cy="7" r="3.75" />
      <path d="M9.8 9.8l2.7 2.7" />
    </Glyph>
  );
}

export function SlidersIcon() {
  return (
    <Glyph>
      <path d="M2.5 5h11M2.5 11h11" />
      <circle cx="6" cy="5" r="1.6" />
      <circle cx="10" cy="11" r="1.6" />
    </Glyph>
  );
}

export function GearIcon() {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 2.2v1.3M8 12.5v1.3M13.8 8h-1.3M3.5 8H2.2M12.1 3.9l-.9.9M4.8 11.2l-.9.9M12.1 12.1l-.9-.9M4.8 4.8l-.9-.9" />
    </Glyph>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <Glyph>
      <path d={open ? 'M4 10l4-4 4 4' : 'M6 4l4 4-4 4'} />
    </Glyph>
  );
}

export function CloseIcon() {
  return (
    <Glyph>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Glyph>
  );
}

/** The sidebar collapse toggle: a panel with its left column marked off. */
export function PanelLeftIcon() {
  return (
    <Glyph>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6.5 3v10" />
    </Glyph>
  );
}

export function FolderIcon() {
  return (
    <Glyph>
      <path d="M2 4.5A1.5 1.5 0 013.5 3h2.4l1.3 1.6h5.3A1.5 1.5 0 0114 6.1v5.4A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5z" />
    </Glyph>
  );
}

/** A commit on a branch line: the git-branch glyph, for the branch chip. */
export function BranchIcon() {
  return (
    <Glyph>
      <circle cx="4.5" cy="4" r="1.6" />
      <circle cx="4.5" cy="12" r="1.6" />
      <circle cx="11.5" cy="4" r="1.6" />
      <path d="M4.5 5.6v4.8M9.9 4h-.4a5 5 0 00-5 5v1.4" />
    </Glyph>
  );
}

/** Add one more folder to the session's context. */
export function FolderPlusIcon() {
  return (
    <Glyph>
      <path d="M2 4.5A1.5 1.5 0 013.5 3h2.4l1.3 1.6h5.3A1.5 1.5 0 0114 6.1v5.4A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5z" />
      <path d="M8 6.8v3.4M6.3 8.5h3.4" />
    </Glyph>
  );
}

/** Which b4m backend answers. A server, not a laptop: this app's agent always runs here. */
export function ServerIcon() {
  return (
    <Glyph>
      <rect x="2.5" y="3" width="11" height="4" rx="1.2" />
      <rect x="2.5" y="9" width="11" height="4" rx="1.2" />
      <path d="M5 5h.01M5 11h.01" />
    </Glyph>
  );
}

export function MoreIcon() {
  return (
    <Glyph>
      <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
    </Glyph>
  );
}
