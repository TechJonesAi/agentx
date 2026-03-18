import type { DocumentMetadata } from '../memory/types.js';
import { createLogger } from '../logger.js';

const log = createLogger('ingestion:text-extractors');

export interface ExtractedContent {
  fullText: string;
  pages: ExtractedPage[];
  metadata: {
    totalPages: number;
    ocrRequired: boolean;
    detectedLanguage?: string;
  };
}

export interface ExtractedPage {
  pageNumber: number;
  content: string;
  rawContent?: string;
}

export abstract class TextExtractor {
  abstract supports(mimeType: string, fileName: string): boolean;
  abstract extract(filePath: string): Promise<ExtractedContent>;

  protected detectOcrNeeded(content: string, minWordLength: number = 3): boolean {
    const words = content.split(/\s+/).filter(w => w.length >= minWordLength);
    const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / words.length;
    const ocrThreshold = 4;

    return avgWordLength < ocrThreshold;
  }
}

export class PdfExtractor extends TextExtractor {
  supports(mimeType: string): boolean {
    return mimeType === 'application/pdf';
  }

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const fs = await import('node:fs/promises');
      const pdfData = await fs.readFile(filePath);
      const pdf = await pdfParse(pdfData);

      const pages: ExtractedPage[] = [];
      let fullText = '';

      for (let i = 0; i < pdf.numpages; i++) {
        const pageText = pdf.version ? `Page ${i + 1}\n` : '';
        const pageContent = pdf.text || '';
        pages.push({
          pageNumber: i + 1,
          content: pageContent,
          rawContent: pageText + pageContent,
        });
        fullText += pageContent + '\n';
      }

      const ocrRequired = this.detectOcrNeeded(fullText);

      return {
        fullText,
        pages,
        metadata: {
          totalPages: pdf.numpages,
          ocrRequired,
        },
      };
    } catch (error) {
      log.error({ filePath, error }, 'PDF extraction failed');
      throw new Error(`Failed to extract PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class TextFileExtractor extends TextExtractor {
  supports(mimeType: string): boolean {
    return mimeType === 'text/plain' || mimeType === 'text/email';
  }

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');

      return {
        fullText: content,
        pages: [{
          pageNumber: 1,
          content,
        }],
        metadata: {
          totalPages: 1,
          ocrRequired: false,
        },
      };
    } catch (error) {
      log.error({ filePath, error }, 'Text file extraction failed');
      throw new Error(`Failed to extract text file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class DocxExtractor extends TextExtractor {
  supports(mimeType: string): boolean {
    return mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const mammoth = (await import('mammoth')).default;
      const fs = await import('node:fs/promises');
      const buffer = await fs.readFile(filePath);

      const result = await mammoth.extractRawText({ buffer });
      const content = result.value;

      return {
        fullText: content,
        pages: [{
          pageNumber: 1,
          content,
        }],
        metadata: {
          totalPages: 1,
          ocrRequired: false,
        },
      };
    } catch (error) {
      log.error({ filePath, error }, 'DOCX extraction failed');
      throw new Error(`Failed to extract DOCX: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class EmailExtractor extends TextExtractor {
  supports(mimeType: string): boolean {
    return mimeType === 'message/rfc822' || mimeType === 'text/email';
  }

  async extract(filePath: string): Promise<ExtractedContent> {
    try {
      const fs = await import('node:fs/promises');
      const emailContent = await fs.readFile(filePath, 'utf-8');

      const headerEndIdx = emailContent.indexOf('\n\n');
      const headers = headerEndIdx > 0 ? emailContent.substring(0, headerEndIdx) : '';
      const body = headerEndIdx > 0 ? emailContent.substring(headerEndIdx + 2) : emailContent;

      const content = `${headers}\n\n${body}`;

      return {
        fullText: content,
        pages: [{
          pageNumber: 1,
          content,
          rawContent: emailContent,
        }],
        metadata: {
          totalPages: 1,
          ocrRequired: false,
        },
      };
    } catch (error) {
      log.error({ filePath, error }, 'Email extraction failed');
      throw new Error(`Failed to extract email: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class TextExtractorFactory {
  private extractors: TextExtractor[] = [];

  constructor() {
    this.extractors = [
      new PdfExtractor(),
      new DocxExtractor(),
      new EmailExtractor(),
      new TextFileExtractor(),
    ];
  }

  getExtractor(mimeType: string, fileName: string): TextExtractor | null {
    for (const extractor of this.extractors) {
      if (extractor.supports(mimeType, fileName)) {
        return extractor;
      }
    }
    return null;
  }
}
