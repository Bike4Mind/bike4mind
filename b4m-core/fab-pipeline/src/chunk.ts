import {
  BedrockEmbeddingModel,
  countCodePoints,
  getEmbeddingModelCapabilities,
  isSupportedEmbeddingModel,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  DocumentDateSource,
  IFabFile,
  MIN_CHUNK_CHARS_FLOOR,
  MIN_PASSAGE_TOKEN_TARGET,
  isMediaOnlyMimeType,
  OpenAIEmbeddingModel,
  SupportedEmbeddingModel,
  SupportedFabFileMimeTypes,
  VoyageAIEmbeddingModel,
  readZipEntryBounded,
  type BoundedZipEntry,
} from '@bike4mind/common';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import {
  acceptDocumentDate,
  parseFrontmatterDate,
  parseOoxmlCoreCreated,
  parsePdfInfoDate,
  type ExtractedDocumentDate,
} from './documentDate';
import { parseLenientJson, stripBom } from './lenientJson';
import { measureZipContainer } from './zipBudget';
import type { Tiktoken } from 'tiktoken';
import type { WorkBook, WorkSheet } from 'xlsx';
import { getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import { S3Storage } from './storage';

/**
 * Bounds on PPTX zip extraction. A .pptx is a zip; a crafted one can pack far more slide
 * entries than any real deck, and each entry can inflate ~1000x when decompressed (zip-bomb
 * shape). The slide-count and per-entry caps bound each item, but an attacker controls their
 * PRODUCT, so two aggregate budgets bound the extraction as a whole:
 *
 * - MAX_PPTX_TOTAL_XML_BYTES caps the decompression one upload can drive, letting the per-item
 *   numbers stay generous. 32 MB is ~1,000 slides of real slide XML, which runs tens of KB per
 *   slide (media lives in separate zip entries).
 * - MAX_EXTRACTED_TEXT_CHARS caps the extracted text accumulated across slides. This is NOT
 *   implied by the XML budget (see its own comment).
 *
 * Crossing either stops the walk with a warning rather than failing the file, so a deck that is
 * merely huge still contributes everything read up to that point.
 */
const MAX_PPTX_SLIDES = 5_000;
const MAX_SLIDE_XML_BYTES = 16 * 1024 * 1024;
const MAX_PPTX_TOTAL_XML_BYTES = 32 * 1024 * 1024;

/**
 * Caps the text any one file's extractor hands to chunkText (PDF, DOCX, XLSX, PPTX). tiktoken traps
 * rather than returning on a string of tens of MB, so the text has to be bounded before it is
 * tokenized. 2M characters is ~500k tokens, orders of magnitude past any real document. Crossing it
 * truncates with a warning, so a huge file still contributes everything read up to that point.
 */
const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;

/**
 * Backstop on the chunks one file can produce, whatever its format - including the plain-text, CSV
 * and JSON paths, which carry no extractor cap of their own. Every chunk is embedded, so this bounds
 * the embedding work one upload can drive. 2M characters at the 64-token passage floor is ~8k
 * chunks, so this binds only on output the per-format caps did not already bound.
 */
const MAX_CHUNKS_PER_FILE = 10_000;

/**
 * Budget on what a DOCX or XLSX container may inflate to, across every entry, before its parser is
 * allowed to run. Unlike the PPTX walk, mammoth and SheetJS each inflate the whole container in one
 * call, so a cap applied to their OUTPUT comes too late to bound memory: the container is measured
 * first (measureZipContainer) and one over budget is not parsed at all. Media entries count too and
 * inflate to roughly their stored size, so this leaves room for an upload at several times the
 * default size limit on top of the few MB of XML a real document carries.
 */
const MAX_OOXML_INFLATED_BYTES = 128 * 1024 * 1024;

/**
 * Caps the cells read out of a workbook, across all sheets. Each sheet's walked range is first
 * trimmed to its populated extent where that does not change the output, then clamped to what is
 * left of this budget.
 */
const MAX_XLSX_CELLS = 2_000_000;

/** Real PDFs top out in the low thousands of pages; each page is parsed and held as text. */
const MAX_PDF_PAGES = 2_000;

/** Where docx, xlsx and pptx all keep the authored-date property (#3048). */
const OOXML_CORE_PROPERTIES_PATH = 'docProps/core.xml';
/** Real core properties run to a few hundred bytes; a megabyte of them is a bomb, not metadata. */
const MAX_OOXML_CORE_XML_BYTES = 256 * 1024;

/**
 * Is this an OOXML container (a zip), as opposed to a legacy OLE workbook or a bare CSV?
 *
 * Read from the bytes rather than from the mime type because the spreadsheet path is handed both:
 * a `.xlsx` keeps its authored date in `docProps/core.xml`, a `.xls` in an OLE summary stream, and
 * they need different readers. `PK\x03\x04` is the zip local file header, which every OOXML
 * container starts with.
 */
function isZipContainer(content: Buffer): boolean {
  return (
    content.length >= 4 && content[0] === 0x50 && content[1] === 0x4b && content[2] === 0x03 && content[3] === 0x04
  );
}

/**
 * Would SheetJS read these bytes as a zip? Its format sniff routes `PK` followed by two bytes below
 * 9 to its zip reader without checking the full local-header signature, so this is deliberately
 * looser than isZipContainer: any `PK` lead counts.
 */
function startsLikeZip(content: Buffer): boolean {
  return content.length >= 2 && content[0] === 0x50 && content[1] === 0x4b;
}

/** unpdf's document proxy, named here so the metadata side-read reads as one thing. */
type PdfDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy['getPage']>>;

/** A pdf.js text item; marked-content items carry no `str` and contribute no text. */
const isPdfTextItem = (item: unknown): item is { str: string; hasEOL?: boolean } =>
  typeof item === 'object' && item !== null && typeof (item as { str?: unknown }).str === 'string';

const pdfTextChunkItems = (value: unknown): unknown[] => {
  const items = (value as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
};

/**
 * One page's text, joined as unpdf's `getPageText` joins it, read from pdf.js's text-content stream
 * so the read stops once `maxChars` is reached instead of materializing every item on the page.
 * `getTextContent` is this same stream collected in full, so the text is identical under the cap.
 */
async function readPdfPageTextBounded(page: PdfPageProxy, maxChars: number): Promise<string> {
  const reader = page.streamTextContent().getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const item of pdfTextChunkItems(value)) {
      if (isPdfTextItem(item)) text += item.str + (item.hasEOL ? '\n' : '');
    }
    if (text.length >= maxChars) {
      // pdf.js rejects a cancel without an Error reason.
      await reader.cancel(new Error('Extracted text cap reached'));
      break;
    }
  }
  return text;
}

type XlsxUtils = typeof import('xlsx').utils;
type XlsxRange = ReturnType<XlsxUtils['decode_range']>;

/** Length of `--- Sheet:  ---\n` plus `\n--- End of Sheet:  ---` plus the join newline, sans names. */
const SHEET_MARKER_OVERHEAD_CHARS = 40;

/**
 * The last populated row and column of a (sparse-mode) sheet, read from its cell keys rather than
 * its declared `!ref`. Bounded by the cells actually present, which the container budget bounds.
 */
function populatedExtent(sheet: WorkSheet, utils: XlsxUtils): { maxRow: number; maxColumn: number } | undefined {
  let maxRow = -1;
  let maxColumn = -1;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue;
    const { r, c } = utils.decode_cell(key);
    maxRow = Math.max(maxRow, r);
    maxColumn = Math.max(maxColumn, c);
  }
  return maxRow < 0 ? undefined : { maxRow, maxColumn };
}
type BoundedSheetRow = { cells: unknown[]; json: string };
type BoundedSheet = { name: string; rows: BoundedSheetRow[] };

/**
 * Formats where a leading `---` fence means frontmatter. Deliberately NOT widened to the
 * text-shaped application/* types the switch also routes through chunkText: in YAML `---` is a
 * document separator and a top-level `date:` is the file's own content, so reading one as the
 * document's vintage would be a guess rather than a signal.
 */
const FRONTMATTER_MIME_TYPES = new Set<string>([
  SupportedFabFileMimeTypes.TXT_MARKDOWN,
  SupportedFabFileMimeTypes.TXT_MD_LEGACY,
  SupportedFabFileMimeTypes.TXT_PLAIN,
]);

// Pull the bodies of `<a:t>` text runs out of a PPTX slide's XML with a linear scan.
// The equivalent regex (`/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g`) is quadratic on XML that
// opens runs it never closes: every `<a:t` restarts a lazy scan to the end of the input.
// A .pptx is a zip, so the uploader picks the decompressed size, which made that a CPU
// sink up to the per-slide byte cap. Scanning with indexOf is linear in the XML length,
// so the cost is bounded without a parse cap that would truncate a real slide's markup.
// A run body can hold further `<a:t...>` opens when the XML nests runs or leaves one
// unclosed. Slicing to the first `</a:t>` keeps them where the regex this replaced
// stripped them, and the literal markup would otherwise reach the chunk text and the
// embedding built from it.
const RUN_OPEN_TAG_RE = /<a:t(?:\s[^>]*)?>/g;

const extractSlideRunTexts = (xml: string): string[] => {
  const CLOSE = '</a:t>';
  const texts: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf('<a:t', cursor);
    if (open === -1 || open + 4 >= xml.length) break;
    // `<a:tbl>`, `<a:tc>` and `<a:tab/>` share the prefix; a run's name ends at `>` or
    // whitespace (runs frequently carry attributes, e.g. `<a:t xml:space="preserve">`).
    const afterName = xml[open + 4];
    if (afterName !== '>' && !/\s/.test(afterName)) {
      cursor = open + 4;
      continue;
    }
    const openEnd = xml.indexOf('>', open + 4);
    if (openEnd === -1) break;
    const close = xml.indexOf(CLOSE, openEnd + 1);
    if (close === -1) break;
    texts.push(xml.slice(openEnd + 1, close).replace(RUN_OPEN_TAG_RE, ''));
    cursor = close + CLOSE.length;
  }
  return texts;
};

export const ChunkSchema = z.object({
  text: z.string(),
  tokenCount: z.number(),
});
export type Chunk = z.infer<typeof ChunkSchema>;

/** Longest stretch (ms) the chunker holds the event loop before yielding it. */
const CHUNK_YIELD_INTERVAL_MS = 50;

// Canonical in @bike4mind/common (see constants/chunking) so the admin-settings schema and the
// React controls can share them without importing this module, which pulls in mammoth, JSZip,
// tiktoken, unpdf and the S3 client. Re-exported so existing `from './chunk'` importers are
// unaffected.
export { DEFAULT_PASSAGE_TOKEN_TARGET, MIN_PASSAGE_TOKEN_TARGET };

export interface SmartChunkerOptions {
  /** Buffer as a percent (0-1) or absolute value (if >= 1) to subtract from maxTokens. */
  bufferPercentOrValue?: number;
  /** Soft target chunk size in tokens; clamped to [MIN_PASSAGE_TOKEN_TARGET, model limit]. */
  passageTokenTarget?: number;
}

type Storage = Pick<S3Storage, 'getContentAsBuffer'>;

const isEmbeddingModel = <T extends SupportedEmbeddingModel>(
  model: string,
  modelEnum: Record<string, T>
): model is T => {
  return Object.values(modelEnum).includes(model as T);
};

/**
 * The embedding model's context window in tokens - the HARD ceiling an embedding call accepts.
 * Extracted from SmartChunker so a caller (the chunk queue handler, #1662) can compute the same
 * effective passage limit for owner-altitude policy resolution and cross-lake conflict reporting
 * without constructing a chunker. Throws on an unsupported model, exactly as the chunker does.
 */
export function embeddingModelContextWindow(model: string): number {
  if (!isSupportedEmbeddingModel(model)) throw new Error(`Unsupported embedding model: ${model}`);
  return getEmbeddingModelCapabilities(model).maxInputTokens;
}

/**
 * The buffer subtracted from the model window to absorb cross-provider tokenizer differences
 * (char/4 approximations can undercount by ~8-10% vs tiktoken). A value < 1 is a percent of the
 * window (floored to >= 32 tokens); a value >= 1 is an absolute token count.
 */
export function embeddingWindowBuffer(maxTokens: number, bufferPercentOrValue = 0.2): number {
  return bufferPercentOrValue < 1
    ? Math.max(Math.floor(maxTokens * bufferPercentOrValue), 32)
    : Math.floor(bufferPercentOrValue);
}

/**
 * The effective per-chunk token limit the chunker will actually use: the SOFT passage target
 * (retrieval granularity) hard-capped to the buffered model window (an oversized chunk fails the
 * embedding call). THE single source of truth for that clamp - SmartChunker's constructor and the
 * chunk handler's conflict/observability logic (#1662) both derive from it, so a resolved policy
 * value can never drift from the granularity it actually produces. An omitted/invalid target falls
 * back to DEFAULT_PASSAGE_TOKEN_TARGET; a supplied one is floored to MIN_PASSAGE_TOKEN_TARGET.
 */
export function effectiveChunkTokenLimit(opts: {
  model: string;
  passageTokenTarget?: number;
  bufferPercentOrValue?: number;
}): number {
  const maxTokens = embeddingModelContextWindow(opts.model);
  const hardLimit = maxTokens - embeddingWindowBuffer(maxTokens, opts.bufferPercentOrValue ?? 0.2);
  const { passageTokenTarget } = opts;
  const target =
    passageTokenTarget !== undefined && Number.isFinite(passageTokenTarget) && passageTokenTarget > 0
      ? Math.max(Math.floor(passageTokenTarget), MIN_PASSAGE_TOKEN_TARGET)
      : DEFAULT_PASSAGE_TOKEN_TARGET;
  return Math.min(hardLimit, target);
}

// The SmartChunker class handles chunking of various file types into smaller pieces suitable for processing by an embedding model
export class SmartChunker {
  private model: string;
  private maxTokens: number;
  private chunkTokenLimit: number;
  private encoder?: Tiktoken;
  private storage: Storage;
  private bufferPercentOrValue: number;
  // Canonical extracted document text from the most recent chunkFile() call, captured BEFORE any
  // size-driven splitting, data-URL redaction, or structural (JSON/CSV/XLSX) enveloping - i.e. the
  // text as extracted, independent of chunkTokenLimit/model. The lake admission contract hashes this
  // (see computeServerTextHash) so the fingerprint is stable across chunk-policy changes; the chunk
  // OUTPUT is not. Undefined for a file with no extractable text (image/audio/unsupported/empty).
  private lastExtractedText: string | undefined;
  // The document's own vintage from the most recent chunkFile() call, when the format carried one
  // (#3048). Rides the chunking pass because that is the one place the decoded bytes are already in
  // hand - re-reading the file just to look at its metadata would double the ingest read for a
  // field most documents do not have. Undefined whenever no source offered a plausible date.
  private lastDocumentDate: ExtractedDocumentDate | undefined;
  private lastYieldAt = Date.now();

  /**
   * @param model - The embedding model name
   * @param storage - Storage instance for file content
   * @param logger - Logger instance
   * @param options - Either a bare number (legacy: bufferPercentOrValue) or a SmartChunkerOptions
   *   object. Buffer default: 0.2 (20%) or 32 tokens, whichever is greater. Passage target
   *   default: DEFAULT_PASSAGE_TOKEN_TARGET.
   */
  constructor(
    model: string,
    storage: Storage,
    private readonly logger: Logger,
    options?: number | SmartChunkerOptions
  ) {
    const { bufferPercentOrValue, passageTokenTarget } =
      typeof options === 'number' ? { bufferPercentOrValue: options, passageTokenTarget: undefined } : (options ?? {});
    this.model = model;
    this.maxTokens = embeddingModelContextWindow(model);

    // 20% buffer absorbs cross-provider tokenizer differences: char/4 approximations
    // (Bedrock, Voyage) can undercount by ~8-10% vs actual OpenAI tiktoken. The buffered model
    // limit is the HARD cap (an oversized chunk fails the embedding call); the passage target is a
    // SOFT cap for retrieval granularity. effectiveChunkTokenLimit is the shared source of truth
    // for that clamp so the handler's owner-altitude resolution can't drift from it (#1662).
    this.bufferPercentOrValue = bufferPercentOrValue ?? 0.2;
    this.chunkTokenLimit = effectiveChunkTokenLimit({
      model,
      passageTokenTarget,
      bufferPercentOrValue: this.bufferPercentOrValue,
    });

    this.storage = storage;

    this.logger.updateMetadata({
      model,
      maxTokens: this.maxTokens,
      chunkTokenLimit: this.chunkTokenLimit,
      bufferPercentOrValue: this.bufferPercentOrValue,
      passageTokenTarget,
    });
  }

  private async initializeEncoder() {
    if (!this.encoder) {
      // Only initialize tiktoken encoder for OpenAI models
      if (isEmbeddingModel(this.model, OpenAIEmbeddingModel)) {
        const { encoding_for_model, get_encoding } = await import('tiktoken');
        // Use model-specific tokenizer for OpenAI models when available
        try {
          this.encoder = encoding_for_model(this.model as any);
        } catch {
          // Fallback to cl100k_base encoding used by most modern OpenAI models
          this.encoder = get_encoding('cl100k_base');
        }
      }
      // For VoyageAI and Bedrock models, we'll use approximation methods in countTokens
    }
  }

  /**
   * Free the encoder after use to avoid memory leaks.
   * Only OpenAI models use a tiktoken encoder that needs freeing.
   */
  public freeEncoder() {
    if (this.encoder) {
      this.encoder.free();
      this.encoder = undefined;
    }
  }

  /**
   * The canonical extracted text from the most recent chunkFile() call - policy-independent, unlike
   * the returned chunks. Undefined when the file yielded no extractable text. See lastExtractedText.
   */
  public getExtractedText(): string | undefined {
    return this.lastExtractedText;
  }

  /**
   * The document's own vintage from the most recent chunkFile() call, or undefined when the format
   * carried none that survived the plausibility window. See lastDocumentDate.
   */
  public getDocumentDate(): ExtractedDocumentDate | undefined {
    return this.lastDocumentDate;
  }

  /**
   * Chunk a file into smaller pieces that can be processed by the model
   * Overloaded method that accepts either an IFabFile or a Buffer with mimeType
   */
  public async chunkFile(file: Pick<IFabFile, 'filePath' | 'mimeType'>): Promise<Chunk[]>;
  public async chunkFile(content: Buffer, mimeType: string): Promise<Chunk[]>;
  public async chunkFile(
    fileOrContent: Pick<IFabFile, 'filePath' | 'mimeType'> | Buffer,
    mimeType?: string
  ): Promise<Chunk[]> {
    let content: Buffer;

    if (Buffer.isBuffer(fileOrContent)) {
      // If content is a Buffer, use it directly
      content = fileOrContent;
    } else {
      // If an IFabFile is provided, fetch its content
      content = await this.fetchFileContent(fileOrContent);
      mimeType = fileOrContent.mimeType;
    }

    this.logger.updateMetadata({ mimeType });
    this.logger.log(`Chunking file with type: ${mimeType}`);

    // Cleared per call; each format handler below sets it to the text it extracted. Anything that
    // returns no chunks (audio/image/unsupported) leaves it undefined.
    this.lastExtractedText = undefined;
    this.lastDocumentDate = undefined;

    // Audio and video (generated media) are intentionally not vectorizable -
    // there is nothing to chunk. Short-circuit quietly so reprocess/on-demand
    // paths don't log it as an "Unsupported file type" error. The normal ingest
    // path already skips the chunk-queue enqueue for media-only files (objectCreated.ts).
    if (isMediaOnlyMimeType(mimeType)) {
      this.logger.log(`Skipping chunking for media-only file type: ${mimeType}`);
      return [];
    }

    let chunks: Chunk[];

    switch (mimeType) {
      case SupportedFabFileMimeTypes.CSV:
        chunks = await this.chunkCSV(content);
        break;

      case SupportedFabFileMimeTypes.PDF:
        chunks = await this.chunkPDF(content);
        break;

      case SupportedFabFileMimeTypes.JSON:
        chunks = await this.chunkJSON(content);
        break;

      case SupportedFabFileMimeTypes.DOCX:
        chunks = await this.chunkDOCX(content);
        break;

      case SupportedFabFileMimeTypes.PPTX:
        chunks = await this.chunkPPTX(content);
        break;

      case SupportedFabFileMimeTypes.XLS:
      case SupportedFabFileMimeTypes.XLSX:
        chunks = await this.chunkExcel(content);
        break;

      case SupportedFabFileMimeTypes.PNG:
      case SupportedFabFileMimeTypes.JPG:
      case SupportedFabFileMimeTypes.WEBP:
      case SupportedFabFileMimeTypes.GIF:
      case SupportedFabFileMimeTypes.SVG:
        return this.chunkImage(content);

      // Text-based application/* MIME types that should be chunked as plain text
      case SupportedFabFileMimeTypes.YAML:
      case SupportedFabFileMimeTypes.TOML:
      case SupportedFabFileMimeTypes.XML:
      case SupportedFabFileMimeTypes.JS:
      case SupportedFabFileMimeTypes.PHP:
      case SupportedFabFileMimeTypes.RUBY:
      case SupportedFabFileMimeTypes.SH:
      case SupportedFabFileMimeTypes.BASH: {
        const textContent = content.toString();
        this.lastExtractedText = textContent;
        chunks = await this.chunkText(textContent);
        break;
      }

      default:
        if (mimeType && mimeType.startsWith('text/')) {
          const textContent = content.toString();
          this.lastExtractedText = textContent;
          if (FRONTMATTER_MIME_TYPES.has(mimeType)) {
            this.lastDocumentDate = acceptDocumentDate(
              parseFrontmatterDate(textContent),
              DocumentDateSource.FRONTMATTER
            );
          }
          chunks = await this.chunkText(textContent);
          break;
        }
        this.logger.warn(`Unsupported file type: ${mimeType}`);
        return [];
    }

    // Post-chunking validation: guarantee no chunk exceeds the token limit
    const validated = await this.validateAndResplitChunks(chunks);
    if (validated.length > MAX_CHUNKS_PER_FILE) {
      this.logger.warn(`File produced ${validated.length} chunks; only the first ${MAX_CHUNKS_PER_FILE} are kept`);
      return validated.slice(0, MAX_CHUNKS_PER_FILE);
    }
    return validated;
  }

  /** Truncates `text` at MAX_EXTRACTED_TEXT_CHARS, warning when it does. */
  private capExtractedText(text: string, format: string): string {
    if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return text;
    this.logger.warn(
      `${format} extracted text exceeds the ${MAX_EXTRACTED_TEXT_CHARS}-character cap; the rest is not chunked`
    );
    return text.slice(0, MAX_EXTRACTED_TEXT_CHARS);
  }

  // Fetches the content of a file from storage as a Buffer
  private async fetchFileContent(file: Pick<IFabFile, 'filePath'>): Promise<Buffer> {
    return await this.storage.getContentAsBuffer(file.filePath!);
  }

  // Chunks CSV content into pieces that fit within the model's token limit
  private async chunkCSV(content: Buffer): Promise<Chunk[]> {
    const csvString = content.toString('utf8');
    // Fingerprint the raw CSV text, not the token-split row chunks (whose boundaries move with
    // chunkTokenLimit and whose oversized-row path splits on commas).
    this.lastExtractedText = csvString;
    // Split by newlines (optionally handle \r\n)
    const rows = csvString.split(/\r?\n/).filter(row => row.trim().length > 0);

    const chunks: Chunk[] = [];
    let currentChunk: string[] = [];
    let currentTokens = 0;

    for (const row of rows) {
      const rowTokens = await this.countTokens(row);

      if (currentTokens + rowTokens > this.chunkTokenLimit) {
        if (currentChunk.length > 0) {
          chunks.push({
            text: currentChunk.join('\n'),
            tokenCount: currentTokens,
          });
          currentChunk = [];
          currentTokens = 0;
        }
      }

      // If a single row is too large, split by cell or by character
      if (rowTokens > this.chunkTokenLimit) {
        const cells = row.split(',');
        let cellChunk = '';
        let cellTokens = 0;
        for (const cell of cells) {
          const cellTokensCount = await this.countTokens(cell);
          if (cellTokens + cellTokensCount > this.chunkTokenLimit) {
            if (cellChunk.length > 0) {
              chunks.push({
                text: cellChunk,
                tokenCount: cellTokens,
              });
              cellChunk = '';
              cellTokens = 0;
            }
          }
          cellChunk += cell + ',';
          cellTokens += cellTokensCount;
        }
        if (cellChunk.length > 0) {
          chunks.push({
            text: cellChunk,
            tokenCount: cellTokens,
          });
        }
        continue;
      }

      currentChunk.push(row);
      currentTokens += rowTokens;
    }

    if (currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.join('\n'),
        tokenCount: currentTokens,
      });
    }

    return chunks;
  }

  /**
   * Per-page text, walked one page at a time under MAX_PDF_PAGES and MAX_EXTRACTED_TEXT_CHARS.
   * Replaces unpdf's `extractText`, which parses every page in parallel with no bound on either;
   * the per-page join matches its `getPageText`, so extracted text (and the fingerprint over it) is
   * unchanged for a PDF under both caps.
   */
  private async extractPdfPageTexts(pdf: PdfDocumentProxy): Promise<string[]> {
    if (pdf.numPages > MAX_PDF_PAGES) {
      this.logger.warn(`PDF declares ${pdf.numPages} pages; only the first ${MAX_PDF_PAGES} are chunked`);
    }
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const pageTexts: string[] = [];
    let totalChars = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const pageText = await readPdfPageTextBounded(page, MAX_EXTRACTED_TEXT_CHARS - totalChars);
      page.cleanup();
      const kept = pageText.slice(0, MAX_EXTRACTED_TEXT_CHARS - totalChars);
      pageTexts.push(kept);
      totalChars += kept.length;
      if (totalChars >= MAX_EXTRACTED_TEXT_CHARS) {
        this.logger.warn(
          `PDF extracted text reached the ${MAX_EXTRACTED_TEXT_CHARS}-character cap at page ${pageNumber}; remaining pages are not chunked`
        );
        break;
      }
    }
    return pageTexts;
  }

  /**
   * The PDF's own `CreationDate`, if it carries a plausible one.
   *
   * Metadata is a best-effort side read: the text is already extracted by the time this runs, so a
   * malformed info dictionary must cost the file its vintage and nothing else. It is logged rather
   * than swallowed because getMetadata() throwing is genuinely exceptional - a PDF with no dates
   * returns an empty info dictionary, it does not raise.
   */
  private async readPdfDocumentDate(pdf: PdfDocumentProxy): Promise<ExtractedDocumentDate | undefined> {
    try {
      const { info } = await pdf.getMetadata();
      const creationDate = (info as unknown as Record<string, unknown> | undefined)?.CreationDate;
      return acceptDocumentDate(parsePdfInfoDate(creationDate), DocumentDateSource.PDF_METADATA);
    } catch (error) {
      this.logger.warn(`Could not read PDF metadata for a document date: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * `dcterms:created` from an OOXML container's `docProps/core.xml` - the date Word/PowerPoint
   * stamp when the document is first saved.
   *
   * Takes an already-open zip so the PPTX path does not pay for a second load. Read through
   * readZipEntryBounded like every other entry in this file: core.xml is a few hundred bytes in
   * any real document, so anything claiming more than the cap is a compression bomb, not metadata.
   *
   * Guarded like its sibling readPdfDocumentDate, and for the same reason: this is a best-effort
   * side read of an AUXILIARY part. readZipEntryBounded rejects when jszip's inflater errors, so
   * without the boundary one corrupt core.xml entry would cost the document every one of its
   * chunks - the exact opposite of this function's contract.
   */
  private async readOoxmlDocumentDate(zip: JSZip): Promise<ExtractedDocumentDate | undefined> {
    const entry = zip.files[OOXML_CORE_PROPERTIES_PATH];
    if (!entry) return undefined;
    try {
      const read = await readZipEntryBounded(entry as unknown as BoundedZipEntry, MAX_OOXML_CORE_XML_BYTES);
      if (!read.ok) {
        this.logger.warn(
          `${OOXML_CORE_PROPERTIES_PATH} exceeded ${MAX_OOXML_CORE_XML_BYTES} bytes; no document date read`
        );
        return undefined;
      }
      return acceptDocumentDate(parseOoxmlCoreCreated(read.text), DocumentDateSource.DOCUMENT_PROPERTIES);
    } catch (error) {
      this.logger.warn(`Could not read ${OOXML_CORE_PROPERTIES_PATH} for a document date: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * The bytes SheetJS may parse for this workbook, or undefined when it must not be parsed. SheetJS
   * `read()` inflates a zip container in one call with its own zip reader, so a zip is measured with
   * JSZip against MAX_OOXML_INFLATED_BYTES and SheetJS is handed a STORE repack of exactly the
   * entries JSZip measured: whatever its reader would accept beyond them (other signatures,
   * duplicate names, misdeclared sizes) never reaches it. Entries that failed to inflate are dropped
   * from the repack. Bytes without the `PK` lead pass through unchanged and never reach JSZip:
   * SheetJS will not read them as a zip, and a legacy OLE .xls or a CSV is not compressed, so what
   * SheetJS holds is bounded by the upload itself. A `PK`-led container JSZip cannot open is refused.
   */
  private async boundedWorkbookBytes(content: Buffer): Promise<Buffer | undefined> {
    if (!startsLikeZip(content)) return content;
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(content);
    } catch (error) {
      this.logger.warn(`Workbook zip could not be opened to bound its size; not chunked: ${(error as Error).message}`);
      return undefined;
    }
    const measured = await measureZipContainer(zip, MAX_OOXML_INFLATED_BYTES);
    if (!measured.ok) {
      this.logger.warn(`Workbook exceeds the ${MAX_OOXML_INFLATED_BYTES}-byte decompressed budget; not chunked`);
      return undefined;
    }
    for (const name of measured.failedEntries) zip.remove(name);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  }

  /**
   * Every sheet's rows, under MAX_XLSX_CELLS and MAX_EXTRACTED_TEXT_CHARS across the workbook. The
   * cell budget clamps each sheet's declared range before SheetJS walks it, so a spoofed dimension
   * tag costs nothing; the character budget stops at the first row that would cross it. Rows keep
   * their JSON so the fingerprint and the chunker serialize each row once.
   */
  private readBoundedSheets(workbook: WorkBook, utils: XlsxUtils): BoundedSheet[] {
    const sheets: BoundedSheet[] = [];
    let cellBudget = MAX_XLSX_CELLS;
    let charBudget = MAX_EXTRACTED_TEXT_CHARS;
    for (const name of workbook.SheetNames) {
      // The sheet's start and end marker lines in the extracted text, charged like its rows.
      const headerChars = 2 * name.length + SHEET_MARKER_OVERHEAD_CHARS;
      if (headerChars > charBudget) {
        this.logger.warn(`Workbook text reached the ${MAX_EXTRACTED_TEXT_CHARS}-character cap before sheet "${name}"`);
        break;
      }
      charBudget -= headerChars;

      const sheet = workbook.Sheets[name];
      const ref = sheet?.['!ref'];
      if (!ref) {
        sheets.push({ name, rows: [] });
        continue;
      }
      const declared = utils.decode_range(ref);
      // A reversed range (a malformed dimension record) holds no cells. Charged as walked, its
      // negative area would refund the budget and let the next sheet walk its whole grid.
      if (declared.e.r < declared.s.r || declared.e.c < declared.s.c) {
        sheets.push({ name, rows: [] });
        continue;
      }
      const range = this.budgetedSheetRange(sheet, declared, cellBudget, utils);
      if (!range) {
        this.logger.warn(
          `Workbook reached the ${MAX_XLSX_CELLS}-cell cap at sheet "${name}"; remaining sheets are not chunked`
        );
        break;
      }
      cellBudget -= (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);

      const rows: BoundedSheetRow[] = [];
      let charCapReached = false;
      for (const cells of utils.sheet_to_json<unknown[]>(sheet, { header: 1, range })) {
        // Skip non-array rows (shouldn't happen with header: 1)
        if (!Array.isArray(cells)) continue;
        const json = JSON.stringify(cells);
        // Plus the newline that joins it to the next row in the extracted text.
        const rowChars = json.length + 1;
        if (rowChars > charBudget) {
          charCapReached = true;
          break;
        }
        charBudget -= rowChars;
        rows.push({ cells, json });
      }
      sheets.push({ name, rows });
      if (charCapReached) {
        this.logger.warn(
          `Workbook text reached the ${MAX_EXTRACTED_TEXT_CHARS}-character cap at sheet "${name}"; the rest is not chunked`
        );
        break;
      }
    }
    return sheets;
  }

  /**
   * The range to walk for one sheet within `cellBudget`, or undefined when not even one row fits.
   * Columns past the last populated one are always trimmed: `sheet_to_json` emits nothing for them,
   * so the output is unchanged. Rows past the last populated one are trimmed only when the declared
   * range would not fit, because each emits an empty row that ordinary output keeps.
   */
  private budgetedSheetRange(
    sheet: WorkSheet,
    declared: XlsxRange,
    cellBudget: number,
    utils: XlsxUtils
  ): XlsxRange | undefined {
    const range = { s: { ...declared.s }, e: { ...declared.e } };
    const extent = populatedExtent(sheet, utils);
    range.e.c = Math.max(range.s.c, Math.min(range.e.c, extent?.maxColumn ?? range.s.c));
    const columns = range.e.c - range.s.c + 1;
    if ((range.e.r - range.s.r + 1) * columns > cellBudget) {
      range.e.r = Math.max(range.s.r, Math.min(range.e.r, extent?.maxRow ?? range.s.r));
    }
    const rowsInBudget = Math.floor(cellBudget / columns);
    if (rowsInBudget === 0) return undefined;
    if (range.e.r - range.s.r + 1 > rowsInBudget) {
      this.logger.warn(
        `A sheet exceeds the ${MAX_XLSX_CELLS}-cell cap; only its first ${rowsInBudget} rows are chunked`
      );
      range.e.r = range.s.r + rowsInBudget - 1;
    }
    return range;
  }

  /**
   * A workbook's authored date, read from whichever place its container actually keeps one.
   *
   * An `.xlsx` goes through `readOoxmlDocumentDate` like the docx and pptx paths rather than
   * through SheetJS's parsed `Props`, because the two disagree on an offset-bearing date and only
   * one of them matches what the header renders. SheetJS builds `Props.CreatedDate` with
   * `new Date(...)`, i.e. a true UTC instant, so `<dcterms:created>2019-03-04T00:00:00+08:00` came
   * back as 2019-03-03 - while the byte-identical `core.xml` inside a `.docx` rendered 2019-03-04.
   * `parseOoxmlCoreCreated` ignores the offset, which is what makes one authored date render the
   * same day whatever container carried it (see parsePdfInfoDate for the same contract). It also
   * picks up the `dc:date` fallback that SheetJS's property reader does not.
   *
   * Legacy `.xls` keeps the SheetJS read: it has no `core.xml` at all - its created date lives in
   * an OLE summary stream - and that reader returns the date as an ISO STRING despite the
   * `CreatedDate?: Date` declaration, which is why acceptDocumentDate takes `Date | string`. Do
   * not narrow this to the declared type.
   */
  private async readWorkbookDocumentDate(
    content: Buffer,
    sheetJsCreatedDate: Date | string | undefined
  ): Promise<ExtractedDocumentDate | undefined> {
    try {
      // Tried unconditionally, not gated on isZipContainer's position-0 byte sniff: a zip with a
      // few bytes prepended (a stray BOM, a mangled preamble) fails that sniff even though JSZip -
      // which scans from the end for the central directory - still finds the entry.
      return await this.readOoxmlDocumentDate(await JSZip.loadAsync(content));
    } catch (error) {
      // Guarded for the same reason readOoxmlDocumentDate guards its own read: SheetJS has already
      // parsed the workbook by this point, so a container this second opener chokes on must cost
      // the file its vintage and nothing else. A legacy .xls hits this on every file - it is not a
      // zip at all - so only worth a warning when the leading bytes actually claimed to be one.
      if (isZipContainer(content)) {
        this.logger.warn(`Could not open the workbook container for a document date: ${(error as Error).message}`);
      }
      return acceptDocumentDate(sheetJsCreatedDate ?? null, DocumentDateSource.DOCUMENT_PROPERTIES);
    }
  }

  // Chunks PDF content into pieces that fit within the model's token limit
  private async chunkPDF(content: Buffer): Promise<Chunk[]> {
    // Convert the Buffer to Uint8Array and get the PDF document proxy
    const pdf = await getDocumentProxy(new Uint8Array(content));
    const text = await this.extractPdfPageTexts(pdf);

    // The extracted text, page-joined - captured before size-chunking so the fingerprint is stable.
    this.lastExtractedText = text.join('\n');

    this.lastDocumentDate = await this.readPdfDocumentDate(pdf);

    const chunks: Chunk[] = [];
    let currentChunk = '';
    let currentTokens = 0;

    // If text is an array (e.g., pages), iterate over each page
    for (const page of text) {
      const pageTokens = await this.countTokens(page);

      if (currentTokens + pageTokens > this.chunkTokenLimit) {
        // If adding the page exceeds the token limit, create a chunk object and add to chunks
        if (currentChunk.trim().length > 0) {
          chunks.push({
            text: currentChunk.trim(),
            tokenCount: currentTokens,
          });
          currentChunk = '';
          currentTokens = 0;
        }
      }

      // If a single page exceeds the token limit, split it using the text chunker
      if (pageTokens > this.chunkTokenLimit) {
        const pageChunks = await this.chunkText(page);
        chunks.push(...pageChunks);
        continue;
      }

      // Add the page to the current chunk
      currentChunk += page + ' ';
      currentTokens += pageTokens;
    }

    // Add the last chunk if it's not empty
    if (currentChunk.trim().length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        tokenCount: currentTokens,
      });
    }

    return chunks;
  }

  // Chunks JSON content into pieces that fit within the model's token limit
  private async chunkJSON(content: Buffer): Promise<Chunk[]> {
    const jsonString = content.toString();
    // Fingerprint the raw JSON source, not chunkObject's `JSON.stringify({ path: value })` envelopes
    // whose keys and `[i]` sub-indices are a function of chunkTokenLimit.
    this.lastExtractedText = jsonString;
    let json: unknown;
    try {
      json = parseLenientJson(jsonString);
    } catch (error) {
      // A file that is not JSON even leniently is deterministic: throwing would only retry it into the DLQ.
      this.logger.warn(`Could not parse JSON, chunking it as text: ${(error as Error).message}`);
      return this.chunkText(stripBom(jsonString));
    }
    return this.chunkObject(json);
  }

  // Chunks a JSON object while preserving structure. Large values become indexed
  // chunks (e.g. "path.to.value[0]", "path.to.value[1]") to keep split pieces related.
  private async chunkObject(obj: any): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    // Use a stack for iterative traversal instead of recursion to handle deeply nested objects
    const stack = [{ obj, path: '' }];

    while (stack.length > 0) {
      const { obj, path } = stack.pop()!;

      if (typeof obj === 'object' && obj !== null) {
        // Handle objects (including arrays) by processing each property
        for (const [key, value] of Object.entries(obj)) {
          // Build a dot-notation path to maintain the object structure
          const newPath = path ? `${path}.${key}` : key;

          // Long string values (over 100 chars) get chunked carefully.
          if (typeof value === 'string' && value.length > 100) {
            // Use the text chunker which handles sentence and word boundaries
            const textChunks = await this.chunkText(value);
            // Create indexed chunks to maintain order and relationship
            for (let i = 0; i < textChunks.length; i++) {
              chunks.push({
                text: JSON.stringify({
                  [`${newPath}[${i}]`]: textChunks[i].text,
                }),
                tokenCount: await this.countTokens(JSON.stringify({ [`${newPath}[${i}]`]: textChunks[i].text })),
              });
            }
            continue;
          }

          // Try to keep the value whole if it fits within token limits
          const chunkText = JSON.stringify({ [newPath]: value });
          const tokenCount = await this.countTokens(chunkText);

          if (tokenCount <= this.chunkTokenLimit) {
            // If it fits, keep it as one piece to maintain context
            chunks.push({
              text: chunkText,
              tokenCount: tokenCount,
            });
          } else if (typeof value === 'object' && value !== null) {
            // For large objects, push them to the stack for further processing
            // This maintains the parent-child relationships in the JSON structure
            stack.push({ obj: value, path: newPath });
          } else {
            // For large primitive values, convert to string and chunk
            // This handles numbers, booleans, etc. that might be too large when stringified
            const stringValue = String(value);
            const textChunks = await this.chunkText(stringValue);
            for (let i = 0; i < textChunks.length; i++) {
              chunks.push({
                text: JSON.stringify({
                  [`${newPath}[${i}]`]: textChunks[i].text,
                }),
                tokenCount: await this.countTokens(JSON.stringify({ [`${newPath}[${i}]`]: textChunks[i].text })),
              });
            }
          }
        }
      } else if (typeof obj === 'string' && obj.length > 100) {
        // Handle root-level long strings
        const textChunks = await this.chunkText(obj);
        for (let i = 0; i < textChunks.length; i++) {
          chunks.push({
            text: JSON.stringify({ [`${path}[${i}]`]: textChunks[i].text }),
            tokenCount: await this.countTokens(JSON.stringify({ [`${path}[${i}]`]: textChunks[i].text })),
          });
        }
      } else {
        // Handle root-level primitive values
        const chunkText = JSON.stringify({ [path]: obj });
        const tokenCount = await this.countTokens(chunkText);

        if (tokenCount <= this.chunkTokenLimit) {
          chunks.push({
            text: chunkText,
            tokenCount: tokenCount,
          });
        } else {
          // Split large primitive values
          const stringValue = String(obj);
          const textChunks = await this.chunkText(stringValue);
          for (let i = 0; i < textChunks.length; i++) {
            chunks.push({
              text: JSON.stringify({ [`${path}[${i}]`]: textChunks[i].text }),
              tokenCount: await this.countTokens(JSON.stringify({ [`${path}[${i}]`]: textChunks[i].text })),
            });
          }
        }
      }
    }

    return chunks;
  }

  // Chunks DOCX (Word document) content into pieces that fit within the model's token limit
  private async chunkDOCX(content: Buffer): Promise<Chunk[]> {
    // Opened before mammoth, which inflates the whole container in one call, so its XML can be
    // bounded first. mammoth reads the zip with this same library, so a container that fails to
    // open here would fail there too. The same open serves the date: mammoth has no metadata API.
    const zip = await JSZip.loadAsync(content);
    if (!(await measureZipContainer(zip, MAX_OOXML_INFLATED_BYTES)).ok) {
      this.logger.warn(`DOCX exceeds the ${MAX_OOXML_INFLATED_BYTES}-byte decompressed budget; not chunked`);
      return [];
    }
    const result = await mammoth.extractRawText({ buffer: content });
    const text = this.capExtractedText(result.value, 'DOCX');
    this.lastExtractedText = text;
    this.lastDocumentDate = await this.readOoxmlDocumentDate(zip);
    return this.chunkText(text);
  }

  // Chunks PPTX (PowerPoint) content. A .pptx is a zip of XML; slide text lives in
  // ppt/slides/slideN.xml inside <a:t> runs. We pull those runs per slide, in slide
  // order, and chunk the concatenated text. Notes slides are intentionally skipped.
  private async chunkPPTX(content: Buffer): Promise<Chunk[]> {
    const zip = await JSZip.loadAsync(content);
    this.lastDocumentDate = await this.readOoxmlDocumentDate(zip);
    const allSlidePaths = Object.keys(zip.files)
      .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10);
        const nb = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10);
        return na - nb;
      });
    const slidePaths = allSlidePaths.slice(0, MAX_PPTX_SLIDES);
    if (allSlidePaths.length > slidePaths.length) {
      this.logger.warn(`PPTX declares ${allSlidePaths.length} slides; only the first ${MAX_PPTX_SLIDES} are chunked`);
    }

    const decodeXmlEntities = (s: string): string =>
      s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');

    const slideTexts: string[] = [];
    let totalXmlBytes = 0;
    let totalTextChars = 0;
    for (let i = 0; i < slidePaths.length; i++) {
      const entry = zip.files[slidePaths[i]];
      // Bound the decompressed XML as it inflates rather than trusting the entry's self-declared
      // uncompressed size, which comes from the zip's own headers. Cap this read at whatever is
      // left of the aggregate budget too, so an exhausted budget stops the walk rather than
      // inflating one more full-sized slide first.
      const entryCap = Math.min(MAX_SLIDE_XML_BYTES, MAX_PPTX_TOTAL_XML_BYTES - totalXmlBytes);
      // `internalStream` is documented ZipObject API but is missing from the `jszip` types.
      const read = await readZipEntryBounded(entry as unknown as BoundedZipEntry, entryCap);
      if (!read.ok) {
        if (entryCap < MAX_SLIDE_XML_BYTES) {
          this.logger.warn(
            `PPTX slide XML exhausted the ${MAX_PPTX_TOTAL_XML_BYTES}-byte total budget at slide ${i + 1}; remaining slides are not chunked`
          );
          break;
        }
        this.logger.warn(`Skipping oversized PPTX slide ${i + 1} (over ${MAX_SLIDE_XML_BYTES} bytes decompressed)`);
        continue;
      }
      totalXmlBytes += read.byteLength;
      const text = extractSlideRunTexts(read.text)
        .map(r => decodeXmlEntities(r))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        // Truncate rather than push whole, so one text-heavy slide cannot overshoot the cap.
        const kept = text.slice(0, MAX_EXTRACTED_TEXT_CHARS - totalTextChars);
        slideTexts.push(`Slide ${i + 1}: ${kept}`);
        totalTextChars += kept.length;
        if (totalTextChars >= MAX_EXTRACTED_TEXT_CHARS) {
          this.logger.warn(
            `PPTX extracted text reached the ${MAX_EXTRACTED_TEXT_CHARS}-character cap at slide ${i + 1}; remaining slides are not chunked`
          );
          break;
        }
      }
    }

    const fullText = slideTexts.join('\n\n');
    if (!fullText.trim()) {
      this.logger.warn('PPTX contained no extractable slide text');
      return [];
    }
    this.lastExtractedText = fullText;
    return this.chunkText(fullText);
  }

  // Chunks text content into smaller pieces while trying to maintain semantic meaning
  // Uses a multi-level approach:
  // 1. First tries to split by sentences
  // 2. If a sentence is too large, splits it into words
  // 3. If words are still too large (rare), they will be split by the model's token limit
  private async chunkText(content: string): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    // Remove data URLs as they're not meaningful for text analysis
    const processedContent = content.replace(/data:[^;\s]+;base64,[a-zA-Z0-9+/]+=*/g, '[DATA_URL_OMITTED]');
    // Split into sentences while preserving the sentence-ending punctuation
    const sentences = processedContent.split(/(?<=[.!?])\s+/);
    let currentChunk = '';
    let currentTokens = 0;

    for (const sentence of sentences) {
      const sentenceTokens = await this.countTokens(sentence);

      // Handle sentences that exceed the token limit (rare; prevents oversized chunks).
      if (sentenceTokens > this.chunkTokenLimit) {
        // First, save any accumulated content
        if (currentChunk.trim().length > 0) {
          chunks.push({
            text: currentChunk.trim(),
            tokenCount: currentTokens,
          });
          currentChunk = '';
          currentTokens = 0;
        }

        // Split the large sentence into words and create sub-chunks
        const words = sentence.split(/\s+/);
        let subChunk = '';
        let subChunkTokens = 0;

        // Process each word, ensuring no sub-chunk exceeds the token limit
        for (const word of words) {
          const wordWithSpace = word + ' ';
          const wordTokens = await this.countTokens(wordWithSpace);

          // If a single word exceeds the limit (e.g., no whitespace in input,
          // minified code, base64, CJK text), use encode-slice-decode fallback
          if (wordTokens > this.chunkTokenLimit) {
            // Flush any accumulated sub-chunk first
            if (subChunk.trim().length > 0) {
              chunks.push({
                text: subChunk.trim(),
                tokenCount: subChunkTokens,
              });
              subChunk = '';
              subChunkTokens = 0;
            }
            const wordChunks = await this.splitOversizedSegment(word);
            chunks.push(...wordChunks);
            continue;
          }

          // If adding this word would exceed the limit, create a new sub-chunk
          if (subChunkTokens + wordTokens > this.chunkTokenLimit) {
            if (subChunk.trim().length > 0) {
              chunks.push({
                text: subChunk.trim(),
                tokenCount: subChunkTokens,
              });
            }
            subChunk = '';
            subChunkTokens = 0;
          }

          // Add the word to the current sub-chunk
          subChunk += wordWithSpace;
          subChunkTokens += wordTokens;
        }

        // Save any remaining content in the sub-chunk
        if (subChunk.trim().length > 0) {
          chunks.push({
            text: subChunk.trim(),
            tokenCount: subChunkTokens,
          });
        }
        continue;
      }

      // Normal case: sentence fits within limits
      // Check if adding this sentence would exceed the chunk limit
      if (currentTokens + sentenceTokens > this.chunkTokenLimit) {
        chunks.push({
          text: currentChunk.trim(),
          tokenCount: currentTokens,
        });
        currentChunk = '';
        currentTokens = 0;
      }

      // Add the sentence to the current chunk
      currentChunk += sentence + ' ';
      currentTokens += sentenceTokens;
    }

    // Save any remaining content
    if (currentChunk.trim().length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        tokenCount: currentTokens,
      });
    }

    return chunks;
  }

  // Chunks Excel content while maintaining the structure of sheets, rows, and cells
  // Uses a hierarchical approach:
  // 1. Tries to keep rows together
  // 2. If a row is too large, splits it into individual cells
  // 3. If a cell is too large, uses the text chunker to split it
  private async chunkExcel(content: Buffer): Promise<Chunk[]> {
    // Lazy load XLSX to improve initial load time
    const { read, utils } = await import('xlsx');

    const workbookBytes = await this.boundedWorkbookBytes(content);
    if (!workbookBytes) return [];

    const workbook = read(workbookBytes, { type: 'buffer' });

    this.lastDocumentDate = await this.readWorkbookDocumentDate(content, workbook.Props?.CreatedDate);

    const sheets = this.readBoundedSheets(workbook, utils);

    // Canonical extracted text for the fingerprint: every sheet's rows serialized deterministically,
    // independent of chunkTokenLimit. The chunk OUTPUT below flips between whole-row and per-cell
    // (`{column,value}`) JSON at the token limit, so it cannot be the hash input.
    this.lastExtractedText = sheets
      .map(({ name, rows }) => {
        const rowText = rows.map(row => row.json).join('\n');
        return `--- Sheet: ${name} ---\n${rowText}\n--- End of Sheet: ${name} ---`;
      })
      .join('\n');

    const chunks: Chunk[] = [];
    let currentChunk = '';
    let currentTokens = 0;

    for (const { name: sheetName, rows } of sheets) {
      // Add sheet header to maintain structure
      const sheetHeader = `--- Sheet: ${sheetName} ---\n`;
      currentChunk += sheetHeader;
      currentTokens += await this.countTokens(sheetHeader);

      for (const { cells: row, json: rowString } of rows) {
        const rowTokens = await this.countTokens(rowString);

        // Handle rows that exceed the token limit
        if (rowTokens > this.chunkTokenLimit) {
          // Save any accumulated content
          if (currentChunk.trim().length > 0) {
            chunks.push({
              text: currentChunk.trim(),
              tokenCount: currentTokens,
            });
            currentChunk = '';
            currentTokens = 0;
          }

          // Process each cell individually to maintain row structure
          let cellChunk = '';
          let cellTokens = 0;

          for (let i = 0; i < row.length; i++) {
            const cell = row[i];
            // Include column index to maintain structure
            const cellString = JSON.stringify({ column: i, value: cell });
            const cellStringTokens = await this.countTokens(cellString);

            // Handle cells that exceed the token limit
            if (cellStringTokens > this.chunkTokenLimit) {
              // Use text chunker for large cell content
              const textChunks = await this.chunkText(String(cell));
              for (const chunk of textChunks) {
                chunks.push({
                  text: JSON.stringify({ column: i, value: chunk.text }),
                  tokenCount: chunk.tokenCount,
                });
              }
            } else if (cellTokens + cellStringTokens > this.chunkTokenLimit) {
              // Save current cell chunk if adding this cell would exceed limit
              if (cellChunk.trim().length > 0) {
                chunks.push({
                  text: cellChunk.trim(),
                  tokenCount: cellTokens,
                });
              }
              cellChunk = cellString + '\n';
              cellTokens = cellStringTokens;
            } else {
              // Add cell to current chunk
              cellChunk += cellString + '\n';
              cellTokens += cellStringTokens;
            }
          }

          // Save any remaining cell content
          if (cellChunk.trim().length > 0) {
            chunks.push({
              text: cellChunk.trim(),
              tokenCount: cellTokens,
            });
          }
          continue;
        }

        // Normal case: row fits within limits
        if (currentTokens + rowTokens > this.chunkTokenLimit) {
          chunks.push({
            text: currentChunk.trim(),
            tokenCount: currentTokens,
          });
          currentChunk = '';
          currentTokens = 0;
        }

        currentChunk += rowString + '\n';
        currentTokens += rowTokens;
      }

      // Add sheet footer to maintain structure
      const sheetFooter = `--- End of Sheet: ${sheetName} ---\n`;
      const footerTokens = await this.countTokens(sheetFooter);

      // Handle case where footer would exceed limit
      if (currentTokens + footerTokens > this.chunkTokenLimit) {
        chunks.push({
          text: currentChunk.trim(),
          tokenCount: currentTokens,
        });
        currentChunk = sheetFooter;
        currentTokens = footerTokens;
      } else {
        currentChunk += sheetFooter;
        currentTokens += footerTokens;
      }
    }

    // Save any remaining content
    if (currentChunk.trim().length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        tokenCount: currentTokens,
      });
    }

    return chunks;
  }

  private async chunkImage(_content: Buffer): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    Logger.globalInstance.log('Skipping image chunking as AI models can accept file image urls');
    return chunks;
  }

  /**
   * Encode text into token IDs. Uses tiktoken for OpenAI models,
   * falls back to character-based splitting for VoyageAI/Bedrock.
   */
  private async encodeTokens(text: string): Promise<number[]> {
    await this.yieldIfBusy();
    if (isEmbeddingModel(this.model, OpenAIEmbeddingModel)) {
      await this.initializeEncoder();
      // encode_ordinary, not encode: file content is untrusted and a special-token literal in it
      // ("<|endoftext|>") makes encode reject, failing the whole ingest. See TiktokenTokenizer in
      // @bike4mind/utils for the full reasoning; the same call is used everywhere we tokenize.
      return Array.from(this.encoder!.encode_ordinary(text));
    }
    // For non-OpenAI models, pseudo-token IDs are character offsets into the original text.
    // decodeTokens() uses these offsets to slice the original string back out.
    // This coupling is intentional - these two methods must be used as a pair.
    const charsPerToken = isEmbeddingModel(this.model, VoyageAIEmbeddingModel) ? 3.7 : 4;
    const groupSize = Math.max(1, Math.round(charsPerToken));
    const tokens: number[] = [];
    for (let i = 0; i < text.length; i += groupSize) {
      tokens.push(i);
    }
    return tokens;
  }

  /**
   * Decode token IDs back to text. Uses tiktoken for OpenAI models,
   * falls back to character-based reconstruction for VoyageAI/Bedrock.
   *
   * For non-OpenAI models, originalText is REQUIRED - the pseudo-token IDs from
   * encodeTokens() are character offsets, so decoding reconstructs by slicing
   * the original string. Returns '' if originalText is omitted for non-OpenAI models.
   *
   * splitOversizedSegment() uses character slicing directly for non-OpenAI models
   * and does not call this method, so this is only used in the OpenAI path today.
   */
  private async decodeTokens(tokens: number[], originalText?: string): Promise<string> {
    if (isEmbeddingModel(this.model, OpenAIEmbeddingModel)) {
      await this.initializeEncoder();
      const decoded = this.encoder!.decode(new Uint32Array(tokens));
      // tiktoken decode may return Uint8Array or string depending on version
      if (typeof decoded === 'string') return decoded;
      return new TextDecoder().decode(decoded as unknown as Uint8Array);
    }
    // For non-OpenAI models, reconstruct from character offsets
    if (!originalText) return '';
    const charsPerToken = isEmbeddingModel(this.model, VoyageAIEmbeddingModel) ? 3.7 : 4;
    const groupSize = Math.max(1, Math.round(charsPerToken));
    const startIdx = tokens[0] ?? 0;
    const endIdx = (tokens[tokens.length - 1] ?? 0) + groupSize;
    return originalText.slice(startIdx, Math.min(endIdx, originalText.length));
  }

  /**
   * Split an oversized text segment using encode-slice-decode for guaranteed correct splitting.
   * Works with any model: tiktoken for OpenAI, character-based for others.
   */
  private async splitOversizedSegment(text: string): Promise<Chunk[]> {
    const chunks: Chunk[] = [];

    if (isEmbeddingModel(this.model, OpenAIEmbeddingModel)) {
      // Use tiktoken encode-slice-decode for guaranteed correct splits
      const encoded = await this.encodeTokens(text);
      for (let j = 0; j < encoded.length; j += this.chunkTokenLimit) {
        const segmentTokens = encoded.slice(j, j + this.chunkTokenLimit);
        const segment = await this.decodeTokens(segmentTokens);
        if (segment.trim().length > 0) {
          chunks.push({ text: segment, tokenCount: segmentTokens.length });
        }
      }
    } else {
      // For non-OpenAI models, split by character count based on chars-per-token ratio
      const charsPerToken = isEmbeddingModel(this.model, VoyageAIEmbeddingModel) ? 3.7 : 4;
      const charsPerChunk = Math.floor(this.chunkTokenLimit * charsPerToken);
      for (let j = 0; j < text.length; j += charsPerChunk) {
        const segment = text.slice(j, j + charsPerChunk);
        if (segment.trim().length > 0) {
          const tokenCount = await this.countTokens(segment);
          chunks.push({ text: segment, tokenCount });
        }
      }
    }

    return chunks;
  }

  /**
   * Post-chunking validation: re-split any chunks that still exceed the token limit, then merge or
   * drop chunks too short to carry a useful embedding (see mergeOrDropNearEmptyChunks).
   * Bounded to max 3 passes to prevent infinite loops.
   */
  private async validateAndResplitChunks(chunks: Chunk[]): Promise<Chunk[]> {
    let result = chunks;
    for (let pass = 0; pass < 3; pass++) {
      let allValid = true;
      const validated: Chunk[] = [];
      for (const chunk of result) {
        const actualTokens = await this.countTokens(chunk.text);
        if (actualTokens > this.chunkTokenLimit) {
          allValid = false;
          this.logger.warn(
            `Chunk exceeds limit (${actualTokens} > ${this.chunkTokenLimit}), re-splitting (pass ${pass + 1})`
          );
          const resplit = await this.splitOversizedSegment(chunk.text);
          validated.push(...resplit);
        } else {
          validated.push({ ...chunk, tokenCount: actualTokens });
        }
      }
      result = validated;
      if (allValid) break;
    }
    return this.mergeOrDropNearEmptyChunks(result.filter(c => c.text.trim().length > 0));
  }

  /**
   * A chunk under MIN_CHUNK_CHARS_FLOOR carries no useful embedding (#2817). Tries the FOLLOWING
   * chunk first, so a run of several under-floor chunks in a row keeps accumulating until it
   * clears the floor, hits the limit, or runs out of chunks; falls back to merging into the
   * PRECEDING chunk when the forward merge doesn't fit - load-bearing, because a chunk produced by
   * splitOversizedSegment sits exactly at chunkTokenLimit, so a forward merge into one always
   * overflows even when the chunk just emitted before the short one has plenty of headroom. Drop
   * it only when NEITHER neighbor can absorb it AND the file has other real content - never drop
   * the last chunk standing, since chunkCount 0 reads downstream as "no extractable text" rather
   * than "hard to embed usefully".
   */
  private async mergeOrDropNearEmptyChunks(chunks: Chunk[]): Promise<Chunk[]> {
    const merged: Chunk[] = [];
    let pendingShort: Chunk | undefined;

    // Merges `shortChunk` into the last emitted chunk in-place, if there is one and it fits.
    const tryMergeBackward = async (shortChunk: Chunk): Promise<boolean> => {
      const prev = merged[merged.length - 1];
      if (!prev) return false;
      const combinedText = `${prev.text} ${shortChunk.text}`.trim();
      const combinedTokens = await this.countTokens(combinedText);
      if (combinedTokens > this.chunkTokenLimit) return false;
      merged[merged.length - 1] = { text: combinedText, tokenCount: combinedTokens };
      return true;
    };

    for (const chunk of chunks) {
      let current = chunk;
      if (pendingShort) {
        const combinedText = `${pendingShort.text} ${current.text}`.trim();
        const combinedTokens = await this.countTokens(combinedText);
        if (combinedTokens <= this.chunkTokenLimit) {
          current = { text: combinedText, tokenCount: combinedTokens };
        } else if (!(await tryMergeBackward(pendingShort))) {
          // No eligible neighbor (either there's nothing preceding it yet, or the forward/backward
          // merge would overflow the token limit), and more content follows in this loop, so
          // dropping here cannot leave the file chunkless.
          this.logger.warn(
            `Dropping near-empty chunk - no eligible neighbor to absorb it within the token limit (${countCodePoints(pendingShort.text)} chars)`
          );
        }
        pendingShort = undefined;
      }

      if (countCodePoints(current.text) < MIN_CHUNK_CHARS_FLOOR) {
        pendingShort = current;
        continue;
      }
      merged.push(current);
    }

    if (pendingShort) {
      if (merged.length === 0) {
        merged.push(pendingShort);
      } else if (!(await tryMergeBackward(pendingShort))) {
        this.logger.warn(
          `Dropping trailing near-empty chunk - no mergeable neighbor within the token limit (${countCodePoints(pendingShort.text)} chars)`
        );
      }
    }

    return merged;
  }

  // The tokenizer is synchronous and every await around it resolves as a microtask, so without this
  // a large file holds the event loop for the whole chunk. Tens of seconds of that starves the
  // database driver's monitors until it drops the connection the commit then needs.
  private async yieldIfBusy(): Promise<void> {
    if (Date.now() - this.lastYieldAt < CHUNK_YIELD_INTERVAL_MS) return;
    await new Promise<void>(resolve => setImmediate(resolve));
    this.lastYieldAt = Date.now();
  }

  // Counts the number of tokens in the given text using the appropriate tokenization method
  private async countTokens(text: string): Promise<number> {
    await this.yieldIfBusy();
    if (isEmbeddingModel(this.model, OpenAIEmbeddingModel)) {
      // Use tiktoken for OpenAI models. encode_ordinary for the same reason as encodeTokens above:
      // a special-token literal in file content must be counted, not rejected.
      await this.initializeEncoder();
      const tokens = this.encoder!.encode_ordinary(text);
      return tokens.length;
    } else if (isEmbeddingModel(this.model, VoyageAIEmbeddingModel)) {
      // VoyageAI uses transformers-style subword tokenization unavailable in JS;
      // approximate at ~1 token per 3.7 chars for English text.
      return Math.ceil(text.length / 3.7);
    } else if (isEmbeddingModel(this.model, BedrockEmbeddingModel)) {
      // Bedrock models vary; approximate at ~1 token per 4 chars.
      return Math.ceil(text.length / 4);
    } else {
      // Fallback approximation for unknown models
      return Math.ceil(text.length / 4);
    }
  }
}
