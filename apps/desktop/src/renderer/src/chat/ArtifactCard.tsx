import { useState } from 'react';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatArtifact } from '@shared/chat';
import { HtmlArtifactFrame } from './HtmlArtifactFrame';
import { ChevronIcon } from './icons';

/**
 * The artifact types this client DISPLAYS, as opposed to the ones it stores.
 *
 * Every type is parsed, saved and shown - this decides only whether the body is executed to
 * draw something. An artifact body is code a model wrote, and the two things that could run it
 * here are this renderer (which holds the preload bridge to a filesystem and a shell) and a
 * frame. So a type is on this list only when its content can be shown with no path from the
 * content to this process:
 *
 *  - 'html' runs in an opaque-origin frame with its own no-network CSP (HtmlArtifactFrame).
 *  - 'svg' is loaded through <img>, which does not execute script in an SVG at all - so a
 *    <script> or an onload= inside one is inert without needing a sanitizer to have caught it.
 *
 * Everything else is source text, which React escapes. 'react' and 'recharts' are the notable
 * absences: rendering them needs React and a JSX transpiler INSIDE the sandbox, which the web
 * app gets from a CDN (/api/react-artifact-sandbox) and this client cannot - its frame admits
 * no remote origin, and a bundled transpiler would mean 'unsafe-eval' inside the sandbox. They
 * are stored, so the web app renders them properly; here they read as source.
 *
 * MUST STAY IN STEP with DESKTOP_ARTIFACT_PROMPT in main/chat/artifacts/prompt.ts, which
 * advertises the MIME types this app can show.
 */
const RENDERED_TYPES = new Set(['html', 'svg']);

/** What the type chip says. An unlisted type shows its raw value rather than being hidden. */
const TYPE_LABEL: Record<string, string> = {
  html: 'HTML',
  svg: 'SVG',
  react: 'React',
  recharts: 'Chart',
  mermaid: 'Diagram',
  python: 'Python',
  code: 'Code',
  chess: 'Chess',
  lattice: 'Model',
  questmaster: 'Questmaster',
  quest: 'Quest',
  file: 'File',
  'blog-draft': 'Draft',
};

/**
 * Why a stored-but-unrendered type is only source here, said once on the card.
 *
 * Only for the types the web app genuinely does render: the user is looking at source where
 * they might reasonably have expected a picture, and "open it in the web app" is the actual
 * remedy. A plain code or python artifact gets nothing, because source is what it IS.
 */
const SOURCE_ONLY_NOTE: Record<string, string> = {
  react: 'Interactive React artifacts render in the web app.',
  recharts: 'Charts render in the web app.',
  mermaid: 'Diagrams render in the web app.',
  chess: 'Chess boards render in the web app.',
  lattice: 'Financial models render in the web app.',
};

/**
 * An SVG as a picture rather than as markup.
 *
 * Through `src`, never `dangerouslySetInnerHTML`: inlined into this document an SVG is live
 * markup in the renderer's own origin, and its `<script>` and event handlers run with the
 * preload bridge in reach. Loaded as an image it is a static picture - the format's scripting
 * and external references are inert by specification, so this needs no sanitizer to be right.
 * The renderer's CSP admits `data:` on img-src for exactly this shape.
 */
function SvgArtifact({ content, title }: { content: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;

  return (
    <Box
      component="img"
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`}
      alt={title}
      onError={() => setFailed(true)}
      sx={{ display: 'block', maxWidth: '100%', maxHeight: 420, m: '0 auto', p: 1.5 }}
      data-testid="chat-artifact-svg"
    />
  );
}

/** Where the server's copy of this artifact ended up, in the words the outcome deserves. */
function SaveStatus({ artifact }: { artifact: ChatArtifact }) {
  const save = artifact.save;
  if (!save) return null;

  const text =
    save.status === 'saved'
      ? 'Saved to Bike4Mind'
      : save.status === 'disabled'
        ? (save.reason ?? 'Not saved')
        : `Saved on this machine only - ${save.reason ?? 'the server did not take a copy.'}`;

  return (
    <Typography
      level="body-xs"
      textColor={save.status === 'saved' ? 'text.tertiary' : 'warning.plainColor'}
      data-testid={`chat-artifact-save-${save.status}`}
    >
      {text}
    </Typography>
  );
}

/**
 * One artifact, as a card in the transcript.
 *
 * Boxed rather than set as a muted row, which is what separates it from the tool rows above it:
 * a tool call is something the reply DID on the way to an answer and collapses to one grey
 * line, while an artifact is the deliverable itself. The source disclosure below it borrows the
 * tool row's shape - a summary line and a chevron - so the two read as the same family.
 */
export function ArtifactCard({ artifact }: { artifact: ChatArtifact }) {
  const [showSource, setShowSource] = useState(false);
  const rendered = RENDERED_TYPES.has(artifact.type);
  const note = rendered ? undefined : SOURCE_ONLY_NOTE[artifact.type];

  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'sm', overflow: 'hidden', my: 1 }}
      data-testid="chat-artifact-card"
      data-artifact-type={artifact.type}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ px: 1.5, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        <Typography level="body-sm" fontWeight="lg" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {artifact.title}
        </Typography>
        <Chip size="sm" variant="soft" color="neutral" data-testid="chat-artifact-type">
          {TYPE_LABEL[artifact.type] ?? artifact.type}
        </Chip>
      </Stack>

      {rendered && (
        <Box sx={{ bgcolor: 'background.level1' }}>
          {artifact.type === 'html' ? (
            <HtmlArtifactFrame content={artifact.content} title={artifact.title} />
          ) : (
            <SvgArtifact content={artifact.content} title={artifact.title} />
          )}
        </Box>
      )}

      <Box sx={{ px: 1.5, py: 1 }}>
        {note && (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }} data-testid="chat-artifact-note">
            {note}
          </Typography>
        )}

        <Box
          component="details"
          open={showSource}
          onToggle={event => setShowSource(event.currentTarget.open)}
          data-testid="chat-artifact-source"
        >
          <Stack
            component="summary"
            direction="row"
            spacing={0.75}
            alignItems="center"
            sx={{
              cursor: 'pointer',
              listStyle: 'none',
              color: 'text.tertiary',
              '&::-webkit-details-marker': { display: 'none' },
              '&:hover': { color: 'text.secondary' },
            }}
            data-testid="chat-artifact-source-summary"
          >
            <Typography level="body-xs" textColor="inherit">
              {rendered ? 'Source' : `${artifact.content.split('\n').length} lines`}
            </Typography>
            <Box sx={{ display: 'flex', opacity: 0.6 }}>
              <ChevronIcon open={showSource} />
            </Box>
          </Stack>

          {/* Plain text in a Typography, so React escapes it. The one place an artifact body is
              allowed into this document is as characters nobody parses as markup. */}
          <Typography
            level="body-xs"
            fontFamily="monospace"
            sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 360, overflowY: 'auto', mt: 0.5 }}
            textColor="text.secondary"
            data-testid="chat-artifact-source-text"
          >
            {artifact.content}
          </Typography>
        </Box>

        <Box sx={{ mt: 0.5 }}>
          <SaveStatus artifact={artifact} />
        </Box>
      </Box>
    </Sheet>
  );
}

export function ArtifactList({ artifacts }: { artifacts: ChatArtifact[] }) {
  if (artifacts.length === 0) return null;

  return (
    <Box data-testid="chat-artifact-list">
      {artifacts.map(artifact => (
        <ArtifactCard key={artifact.id} artifact={artifact} />
      ))}
    </Box>
  );
}
