import { useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import type { ChatArtifact, ChatArtifactView } from '@shared/chat';
import { HtmlArtifactFrame } from './HtmlArtifactFrame';
import { ChevronIcon } from './icons';
import { type MermaidFailure, renderMermaidDiagram } from './mermaidDiagram';

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
 *  - 'mermaid' is compiled to an SVG string in this process and then loaded through that same
 *    <img>, so it inherits the property rather than earning a second one.
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
export const RENDERED_TYPES = new Set(['html', 'svg', 'mermaid']);

/**
 * What the type chip says. An unlisted type shows its raw value rather than being hidden.
 * Exported so the library panel labels a stored artifact the same way the transcript does.
 */
export const TYPE_LABEL: Record<string, string> = {
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
export const SOURCE_ONLY_NOTE: Record<string, string> = {
  react: 'Interactive React artifacts render in the web app.',
  recharts: 'Charts render in the web app.',
  chess: 'Chess boards render in the web app.',
  lattice: 'Financial models render in the web app.',
};

/**
 * Why a diagram that WAS going to be drawn is showing its source instead. Separate from
 * SOURCE_ONLY_NOTE because the type is a rendered one: something specific went wrong, and
 * "open it in the web app" is only the right advice for one of the two reasons.
 */
const MERMAID_FAILURE_NOTE: Record<MermaidFailure, string> = {
  invalid: 'This diagram could not be drawn - mermaid could not read its source.',
  'html-labels': 'This kind of diagram renders in the web app.',
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
export function SvgArtifact({
  content,
  title,
  maxHeight = 420,
  testId = 'chat-artifact-svg',
  onFailure,
}: {
  content: string;
  title: string;
  maxHeight?: number;
  testId?: string;
  onFailure?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;

  return (
    <Box
      component="img"
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`}
      alt={title}
      onError={() => {
        setFailed(true);
        onFailure?.();
      }}
      sx={{ display: 'block', maxWidth: '100%', maxHeight, m: '0 auto', p: 1.5 }}
      data-testid={testId}
    />
  );
}

/**
 * A mermaid source as the diagram it describes.
 *
 * Compiled here and handed to SvgArtifact, so the picture arrives through the `<img>` path
 * argued for above rather than as markup in this document. Re-compiled when the appearance
 * changes, because mermaid bakes its colors into the SVG and a light diagram on the dark UI
 * is the obvious wrong answer.
 *
 * Taller than a plain SVG artifact is allowed: a flowchart is usually a narrow column of
 * boxes, and at 420 the text in a ten-step one shrinks past reading. Still capped, because the
 * card sits in a transcript the user is scrolling through - past this it scales down, and the
 * web app is where a poster-sized diagram belongs.
 */
function MermaidArtifact({
  content,
  title,
  onFailure,
}: {
  content: string;
  title: string;
  onFailure: (reason: MermaidFailure | undefined) => void;
}) {
  const mode = useTheme().palette.mode === 'dark' ? 'dark' : 'light';
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    // A streaming artifact is malformed until its last line arrives, so every attempt starts
    // from no verdict rather than inheriting the previous one.
    onFailure(undefined);

    void renderMermaidDiagram(content, mode).then(result => {
      if (cancelled) return;
      setSvg(result.ok ? result.svg : null);
      onFailure(result.ok ? undefined : result.reason);
    });

    return () => {
      cancelled = true;
    };
  }, [content, mode, onFailure]);

  if (!svg) return null;

  return (
    <SvgArtifact
      content={svg}
      title={title}
      maxHeight={640}
      testId="chat-artifact-mermaid"
      onFailure={() => onFailure('invalid')}
    />
  );
}

/** Where the server's copy of this artifact ended up, in the words the outcome deserves. */
function SaveStatus({ artifact }: { artifact: ChatArtifactView }) {
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
export function ArtifactCard({ artifact }: { artifact: ChatArtifactView }) {
  const [showSource, setShowSource] = useState(false);
  // Passed straight to MermaidArtifact as its failure callback: a useState setter is stable,
  // so the compile effect is not re-run by this component re-rendering.
  const [diagramFailure, setDiagramFailure] = useState<MermaidFailure | undefined>(undefined);

  const rendered = RENDERED_TYPES.has(artifact.type) && !diagramFailure;
  const note = rendered
    ? undefined
    : diagramFailure
      ? MERMAID_FAILURE_NOTE[diagramFailure]
      : SOURCE_ONLY_NOTE[artifact.type];

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

      {/* Mermaid stays mounted through a failure, unlike the other two: its verdict comes from
          compiling the source, and a streaming artifact's source is malformed until the last
          line lands. Unmounting on the first bad parse would leave the finished diagram
          showing its own error note. */}
      {artifact.type === 'mermaid' ? (
        <Box sx={{ bgcolor: rendered ? 'background.level1' : undefined }}>
          <MermaidArtifact content={artifact.content} title={artifact.title} onFailure={setDiagramFailure} />
        </Box>
      ) : (
        rendered && (
          <Box sx={{ bgcolor: 'background.level1' }}>
            {artifact.type === 'html' ? (
              <HtmlArtifactFrame content={artifact.content} title={artifact.title} />
            ) : (
              <SvgArtifact content={artifact.content} title={artifact.title} />
            )}
          </Box>
        )
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
