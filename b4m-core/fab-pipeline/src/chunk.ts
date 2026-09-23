import {
  BedrockEmbeddingModel,
  countCodePoints,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  DocumentDateSource,
  IFabFile,
  MIN_CHUNK_CHARS_FLOOR,
  MIN_PASSAGE_TOKEN_TARGET,
  OllamaEmbeddingModel,
  isAudioMimeType,
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
import type { Tiktoken } from 'tiktoken';
import { extractText, getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import {
  BEDROCK_EMBEDDING_MODEL_MAP,
  OLLAMA_EMBEDDING_MODEL_MAP,
  OPENAI_EMBEDDING_MODEL_MAP,
  VOYAGEAI_EMBEDDING_MODEL_MAP,
} from './embeddings';
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
 * - MAX_PPTX_TEXT_CHARS caps the extracted text accumulated across slides. This is NOT implied by
 *   the XML budget: tiktoken traps on a string of that size, so `fullText` has to be bounded on
 *   its own before chunkText tokenizes it. 2M characters is ~500k tokens, orders of magnitude past
 *   any real deck.
 *
 * Crossing either stops the walk with a warning rather than failing the file, so a deck that is
 * merely huge still contributes everything read up to that point.
 */
const MAX_PPTX_SLIDES = 5_000;
const MAX_SLIDE_XML_BYTES = 16 * 1024 * 1024;
const MAX_PPTX_TOTAL_XML_BYTES = 32 * 1024 * 1024;
const MAX_PPTX_TEXT_CHARS = 2_000_000;

/** Where docx, xlsx and pptx all keep the authored-date property (#3048). */
const OOXML_CORE_PROPERTIES_PATH = 'docProps/core.xml';
/** Real core properties run to a few hundred bytes; a megabyte of them is a bomb, not metadata. */
const MAX_OOXML_CORE_XML_BYTES = 256 * 1024;

/** unpdf's document proxy, named here so the metadata side-read reads as one thing. */
type PdfDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

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
  if (isEmbeddingModel(model, OpenAIEmbeddingModel)) return OPENAI_EMBEDDING_MODEL_MAP[model].contextWindow;
  if (isEmbeddingModel(model, VoyageAIEmbeddingModel)) return VOYAGEAI_EMBEDDING_MODEL_MAP[model].contextWindow;
  if (isEmbeddingModel(model, BedrockEmbeddingModel)) return BEDROCK_EMBEDDING_MODEL_MAP[model].contextWindow;
  if (isEmbeddingModel(model, OllamaEmbeddingModel)) return OLLAMA_EMBEDDING_MODEL_MAP[model].contextWindow;
  throw new Error(`Unsupported embedding model: ${model}`);
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

    // Audio (generated TTS / sound effects) is intentionally not vectorizable -
    // there is nothing to chunk. Short-circuit quietly so reprocess/on-demand
    // paths don't log it as an "Unsupported file type" error. The normal ingest
    // path already skips the chunk-queue enqueue for audio (objectCreated.ts).
    if (isAudioMimeType(mimeType)) {
      this.logger.log(`Skipping chunking for audio file type: ${mimeType}`);
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
        this.logger.error(`Unsupported file type: ${mimeType}`);
        return [];
    }

    // Post-chunking validation: guarantee no chunk exceeds the token limit
    return this.validateAndResplitChunks(chunks);
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

  // Chunks PDF content into pieces that fit within the model's token limit
  private async chunkPDF(content: Buffer): Promise<Chunk[]> {
    // Convert the Buffer to Uint8Array and get the PDF document proxy
    const pdf = await getDocumentProxy(new Uint8Array(content));
    // Extract text from the PDF
    const { text } = await extractText(pdf);

    // The extracted text, page-joined - captured before size-chunking so the fingerprint is stable.
    this.lastExtractedText = Array.isArray(text) ? text.join('\n') : text;

    this.lastDocumentDate = await this.readPdfDocumentDate(pdf);

    if (typeof text === 'string') {
      // If text is a single string, chunk it as plain text
      return this.chunkText(text);
    }

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
    const json = JSON.parse(jsonString);
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
    // Extract raw text from the DOCX file using mammoth
    const result = await mammoth.extractRawText({ buffer: content });
    this.lastExtractedText = result.value;
    // mammoth exposes no metadata API at all, so the container is opened separately for the one
    // property wanted. Lazy: JSZip reads the directory here, not every entry's bytes.
    this.lastDocumentDate = await this.readOoxmlDocumentDate(await JSZip.loadAsync(content));
    // Chunk the extracted text as plain text
    return this.chunkText(result.value);
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
        const kept = text.slice(0, MAX_PPTX_TEXT_CHARS - totalTextChars);
        slideTexts.push(`Slide ${i + 1}: ${kept}`);
        totalTextChars += kept.length;
        if (totalTextChars >= MAX_PPTX_TEXT_CHARS) {
          this.logger.warn(
            `PPTX extracted text reached the ${MAX_PPTX_TEXT_CHARS}-character cap at slide ${i + 1}; remaining slides are not chunked`
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

    const workbook = read(content, { type: 'buffer' });

    // SheetJS already parses the workbook's properties, so this needs no second pass over the
    // container - and unlike a docProps/core.xml read it also covers legacy .xls, whose created
    // date lives in an OLE summary stream rather than in any XML. That legacy reader returns the
    // date as an ISO STRING despite the `CreatedDate?: Date` declaration, which is why
    // acceptDocumentDate takes `Date | string`; do not narrow this to the declared type.
    this.lastDocumentDate = acceptDocumentDate(
      workbook.Props?.CreatedDate ?? null,
      DocumentDateSource.DOCUMENT_PROPERTIES
    );

    // Canonical extracted text for the fingerprint: every sheet's rows serialized deterministically,
    // independent of chunkTokenLimit. The chunk OUTPUT below flips between whole-row and per-cell
    // (`{column,value}`) JSON at the token limit, so it cannot be the hash input.
    this.lastExtractedText = workbook.SheetNames.map(sheetName => {
      const rows = utils
        .sheet_to_json<any[]>(workbook.Sheets[sheetName], { header: 1 })
        .filter(Array.isArray)
        .map(row => JSON.stringify(row))
        .join('\n');
      return `--- Sheet: ${sheetName} ---\n${rows}\n--- End of Sheet: ${sheetName} ---`;
    }).join('\n');

    const chunks: Chunk[] = [];
    let currentChunk = '';
    let currentTokens = 0;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      // Convert sheet to array format with header row
      const data = utils.sheet_to_json<any[]>(sheet, { header: 1 });

      // Add sheet header to maintain structure
      const sheetHeader = `--- Sheet: ${sheetName} ---\n`;
      currentChunk += sheetHeader;
      currentTokens += await this.countTokens(sheetHeader);

      for (const row of data) {
        // Skip non-array rows (shouldn't happen with header: 1)
        if (!Array.isArray(row)) continue;

        const rowString = JSON.stringify(row);
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

  // Counts the number of tokens in the given text using the appropriate tokenization method
  private async countTokens(text: string): Promise<number> {
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
