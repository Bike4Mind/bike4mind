import {
  BedrockEmbeddingModel,
  IFabFile,
  OpenAIEmbeddingModel,
  SupportedEmbeddingModel,
  SupportedFabFileMimeTypes,
  VoyageAIEmbeddingModel,
} from '@bike4mind/common';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import type { Tiktoken } from 'tiktoken';
import { extractText, getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import { BEDROCK_EMBEDDING_MODEL_MAP, OPENAI_EMBEDDING_MODEL_MAP, VOYAGEAI_EMBEDDING_MODEL_MAP } from './embeddings';
import { Logger } from '@bike4mind/observability';
import { S3Storage } from './storage';

export const ChunkSchema = z.object({
  text: z.string(),
  tokenCount: z.number(),
});
export type Chunk = z.infer<typeof ChunkSchema>;

type Storage = Pick<S3Storage, 'getContentAsBuffer'>;

const isEmbeddingModel = <T extends SupportedEmbeddingModel>(
  model: string,
  modelEnum: Record<string, T>
): model is T => {
  return Object.values(modelEnum).includes(model as T);
};

// The SmartChunker class handles chunking of various file types into smaller pieces suitable for processing by an embedding model
export class SmartChunker {
  private model: string;
  private maxTokens: number;
  private chunkTokenLimit: number;
  private encoder?: Tiktoken;
  private storage: Storage;
  private bufferPercentOrValue: number;

  /**
   * @param model - The embedding model name
   * @param storage - Storage instance for file content
   * @param logger - Logger instance
   * @param bufferPercentOrValue - Optional. Buffer as a percent (0-1) or absolute value (if >= 1) to subtract from maxTokens. Default: 0.2 (20%) or 32 tokens, whichever is greater.
   */
  constructor(
    model: string,
    storage: Storage,
    private readonly logger: Logger,
    bufferPercentOrValue?: number
  ) {
    this.model = model;

    if (isEmbeddingModel(model, OpenAIEmbeddingModel)) {
      this.maxTokens = OPENAI_EMBEDDING_MODEL_MAP[model].contextWindow;
    } else if (isEmbeddingModel(model, VoyageAIEmbeddingModel)) {
      this.maxTokens = VOYAGEAI_EMBEDDING_MODEL_MAP[model].contextWindow;
    } else if (isEmbeddingModel(model, BedrockEmbeddingModel)) {
      this.maxTokens = BEDROCK_EMBEDDING_MODEL_MAP[model].contextWindow;
    } else {
      throw new Error(`Unsupported embedding model: ${model}`);
    }

    // 20% buffer absorbs cross-provider tokenizer differences: char/4 approximations
    // (Bedrock, Voyage) can undercount by ~8-10% vs actual OpenAI tiktoken.
    this.bufferPercentOrValue = bufferPercentOrValue ?? 0.2;
    let buffer: number;
    if (this.bufferPercentOrValue < 1) {
      buffer = Math.max(Math.floor(this.maxTokens * this.bufferPercentOrValue), 32);
    } else {
      buffer = Math.floor(this.bufferPercentOrValue);
    }
    this.chunkTokenLimit = this.maxTokens - buffer;

    this.storage = storage;

    this.logger.updateMetadata({
      model,
      maxTokens: this.maxTokens,
      chunkTokenLimit: this.chunkTokenLimit,
      bufferPercentOrValue: this.bufferPercentOrValue,
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
      case SupportedFabFileMimeTypes.BASH:
        chunks = await this.chunkText(content.toString());
        break;

      default:
        if (mimeType && mimeType.startsWith('text/')) {
          chunks = await this.chunkText(content.toString());
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

  // Chunks PDF content into pieces that fit within the model's token limit
  private async chunkPDF(content: Buffer): Promise<Chunk[]> {
    // Convert the Buffer to Uint8Array and get the PDF document proxy
    const pdf = await getDocumentProxy(new Uint8Array(content));
    // Extract text from the PDF
    const { text } = await extractText(pdf);

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
    const json = JSON.parse(content.toString());
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
    // Chunk the extracted text as plain text
    return this.chunkText(result.value);
  }

  // Chunks PPTX (PowerPoint) content. A .pptx is a zip of XML; slide text lives in
  // ppt/slides/slideN.xml inside <a:t> runs. We pull those runs per slide, in slide
  // order, and chunk the concatenated text. Notes slides are intentionally skipped.
  private async chunkPPTX(content: Buffer): Promise<Chunk[]> {
    const zip = await JSZip.loadAsync(content);
    const slidePaths = Object.keys(zip.files)
      .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10);
        const nb = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10);
        return na - nb;
      });

    const decodeXmlEntities = (s: string): string =>
      s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');

    const slideTexts: string[] = [];
    for (let i = 0; i < slidePaths.length; i++) {
      const xml = await zip.files[slidePaths[i]].async('string');
      // `<a:t>` runs frequently carry attributes (e.g. `<a:t xml:space="preserve">`);
      // match the open tag with optional attributes, else PPTX text is silently dropped.
      const runs = xml.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g) ?? [];
      const text = runs
        .map(r => decodeXmlEntities(r.replace(/<a:t(?:\s[^>]*)?>|<\/a:t>/g, '')))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) slideTexts.push(`Slide ${i + 1}: ${text}`);
    }

    const fullText = slideTexts.join('\n\n');
    if (!fullText.trim()) {
      this.logger.warn('PPTX contained no extractable slide text');
      return [];
    }
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
      return Array.from(this.encoder!.encode(text));
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
   * Post-chunking validation: re-split any chunks that still exceed the token limit.
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
    return result.filter(c => c.text.trim().length > 0);
  }

  // Counts the number of tokens in the given text using the appropriate tokenization method
  private async countTokens(text: string): Promise<number> {
    if (isEmbeddingModel(this.model, OpenAIEmbeddingModel)) {
      // Use tiktoken for OpenAI models
      await this.initializeEncoder();
      const tokens = this.encoder!.encode(text);
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
