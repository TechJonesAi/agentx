import { createLogger } from '../logger.js';
import type { ClassificationLabel } from '../memory/types.js';

const log = createLogger('classification:classifier');

export interface ClassificationResult {
  label: ClassificationLabel;
  confidence: number;
  method: string;
}

export class DocumentClassifier {
  private emailPatterns = [
    /^from:\s*.+@.+/im,
    /^to:\s*.+@.+/im,
    /^date:\s*.+/im,
    /^subject:\s*.+/im,
  ];

  private reportPatterns = [
    /\breport\b/im,
    /\banalysis\b/im,
    /\bsummary\b/im,
    /\bfindings\b/im,
    /\bconclusions\b/im,
  ];

  private legalPatterns = [
    /\bagreement\b/im,
    /\bcontract\b/im,
    /\blegal\b/im,
    /\bclause\b/im,
    /\bliability\b/im,
    /\bparty\b/im,
  ];

  private policyPatterns = [
    /\bpolicy\b/im,
    /\bprocedure\b/im,
    /\bguideline\b/im,
    /\bstandard\b/im,
  ];

  private letterPatterns = [
    /^[a-z0-9\s\.,]+,?\s*[a-z0-9\s\.]+/im,
    /\bdear\s+/im,
    /\bsincerely\b/im,
    /\byours\s+/im,
  ];

  private transcriptPatterns = [
    /\btranscript\b/im,
    /\binterview\b/im,
    /\bconversation\b/im,
    /\bmeeting\s+minutes\b/im,
  ];

  async classify(
    fileName: string,
    content: string,
    mimeType: string,
  ): Promise<ClassificationResult> {
    try {
      const ruleResult = this.classifyByRules(fileName, content, mimeType);

      if (ruleResult.confidence > 0.7) {
        return {
          ...ruleResult,
          method: 'rule-based',
        };
      }

      return {
        ...ruleResult,
        method: 'rule-based-fallback',
      };
    } catch (error) {
      log.error({ fileName, error }, 'Classification failed');
      return {
        label: 'unknown',
        confidence: 0.0,
        method: 'error',
      };
    }
  }

  private classifyByRules(
    fileName: string,
    content: string,
    mimeType: string,
  ): ClassificationResult {
    const lowerContent = content.toLowerCase();
    const lowerFileName = fileName.toLowerCase();
    const scores: Record<ClassificationLabel, number> = {
      email: 0,
      report: 0,
      legal_doc: 0,
      letter: 0,
      transcript: 0,
      policy: 0,
      note: 0,
      scan: 0,
      unknown: 0,
    };

    if (this.isPdfScan(content)) {
      scores.scan = 0.8;
    }

    if (this.matchPatterns(lowerContent, this.emailPatterns) >= 3 ||
        mimeType === 'message/rfc822' ||
        mimeType === 'text/email') {
      scores.email = 0.9;
    }

    if (this.matchPatterns(lowerContent, this.reportPatterns) >= 2) {
      scores.report = 0.7;
    }

    if (this.matchPatterns(lowerContent, this.legalPatterns) >= 2) {
      scores.legal_doc = 0.7;
    }

    if (this.matchPatterns(lowerContent, this.policyPatterns) >= 2) {
      scores.policy = 0.7;
    }

    if (this.matchPatterns(lowerContent, this.letterPatterns) >= 2) {
      scores.letter = 0.6;
    }

    if (this.matchPatterns(lowerContent, this.transcriptPatterns) >= 1) {
      scores.transcript = 0.7;
    }

    if (lowerContent.length < 500 && !scores.email) {
      scores.note = 0.5;
    }

    let maxScore = 0;
    let bestLabel: ClassificationLabel = 'unknown';

    for (const [label, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        bestLabel = label as ClassificationLabel;
      }
    }

    return {
      label: bestLabel,
      confidence: Math.min(maxScore, 1.0),
    };
  }

  private matchPatterns(text: string, patterns: RegExp[]): number {
    return patterns.filter(pattern => pattern.test(text)).length;
  }

  private isPdfScan(content: string): boolean {
    const wordCount = content.split(/\s+/).length;
    const avgWordLength = content.replace(/\s/g, '').length / wordCount;

    return avgWordLength < 3 || wordCount < 100;
  }
}
