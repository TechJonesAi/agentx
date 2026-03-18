import { createLogger } from '../logger.js';
import { generateId } from '../memory/id-generator.js';
import type { Entity, EntityType } from '../memory/types.js';

const log = createLogger('entities:extractor');

interface ExtractedEntity {
  canonical_form: string;
  entity_type: EntityType;
  confidence: number;
}

export class EntityExtractor {
  private emailPattern = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
  private namePattern = /\b(?:[A-Z][a-z]+\s)+[A-Z][a-z]+\b/g;
  private datePattern = /\b(?:\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{4}[-\/]\d{1,2}[-\/]\d{1,2})\b/g;
  private caseRefPattern = /\b[A-Z]{1,3}\d{4,8}[A-Z]?\b/g;

  extract(text: string): Array<Entity & { confidence: number }> {
    const entities = new Map<string, ExtractedEntity>();

    this.extractEmails(text, entities);
    this.extractPeople(text, entities);
    this.extractDates(text, entities);
    this.extractCaseReferences(text, entities);

    const now = Date.now();
    return Array.from(entities.values()).map(entity => ({
      entity_id: generateId('entity'),
      canonical_form: entity.canonical_form,
      entity_type: entity.entity_type,
      normalized_form: this.normalizeForm(entity.canonical_form),
      first_seen: now,
      last_seen: now,
      mention_count: 0,
      confidence: entity.confidence,
      created_at: now,
    }));
  }

  private extractEmails(text: string, entities: Map<string, ExtractedEntity>): void {
    let match: RegExpExecArray | null;

    while ((match = this.emailPattern.exec(text)) !== null) {
      const email = match[0].toLowerCase();
      entities.set(email, {
        canonical_form: email,
        entity_type: 'email',
        confidence: 1.0,
      });
    }
  }

  private extractPeople(text: string, entities: Map<string, ExtractedEntity>): void {
    let match: RegExpExecArray | null;

    while ((match = this.namePattern.exec(text)) !== null) {
      const name = match[0];
      const canonical = name.trim();

      if (canonical.split(/\s+/).length >= 2) {
        if (!entities.has(canonical)) {
          entities.set(canonical, {
            canonical_form: canonical,
            entity_type: 'person',
            confidence: 0.7,
          });
        }
      }
    }
  }

  private extractDates(text: string, entities: Map<string, ExtractedEntity>): void {
    let match: RegExpExecArray | null;

    while ((match = this.datePattern.exec(text)) !== null) {
      const date = match[0];
      entities.set(date, {
        canonical_form: date,
        entity_type: 'date',
        confidence: 0.9,
      });
    }
  }

  private extractCaseReferences(text: string, entities: Map<string, ExtractedEntity>): void {
    let match: RegExpExecArray | null;

    while ((match = this.caseRefPattern.exec(text)) !== null) {
      const ref = match[0];
      entities.set(ref, {
        canonical_form: ref,
        entity_type: 'case_reference',
        confidence: 0.8,
      });
    }
  }

  private normalizeForm(form: string): string {
    return form.toLowerCase().trim();
  }
}
