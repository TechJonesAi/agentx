import { describe, it, expect, beforeEach } from 'vitest';
import { IdentityResolver } from '../../src/sessions/identity.js';

describe('IdentityResolver', () => {
  let resolver: IdentityResolver;

  beforeEach(() => {
    resolver = new IdentityResolver({
      links: {
        darren: ['telegram:123456', 'discord:darren#1234', 'slack:U001'],
        alice: ['telegram:789012', 'discord:alice#5678'],
      },
    });
  });

  describe('resolve', () => {
    it('resolves known platform ID to canonical name', () => {
      expect(resolver.resolve('telegram:123456')).toBe('darren');
      expect(resolver.resolve('discord:darren#1234')).toBe('darren');
      expect(resolver.resolve('slack:U001')).toBe('darren');
    });

    it('resolves different user correctly', () => {
      expect(resolver.resolve('telegram:789012')).toBe('alice');
    });

    it('returns platform ID as-is when no match', () => {
      expect(resolver.resolve('telegram:unknown')).toBe('telegram:unknown');
    });
  });

  describe('resolveFrom', () => {
    it('resolves from provider + userId', () => {
      expect(resolver.resolveFrom('telegram', '123456')).toBe('darren');
    });

    it('returns combined string when no match', () => {
      expect(resolver.resolveFrom('telegram', 'nobody')).toBe('telegram:nobody');
    });
  });

  describe('getPlatformIds', () => {
    it('returns all IDs for a canonical name', () => {
      const ids = resolver.getPlatformIds('darren');
      expect(ids).toContain('telegram:123456');
      expect(ids).toContain('discord:darren#1234');
      expect(ids).toContain('slack:U001');
    });

    it('returns empty array for unknown canonical', () => {
      expect(resolver.getPlatformIds('nobody')).toEqual([]);
    });
  });

  describe('link', () => {
    it('adds a new platform ID to existing canonical', () => {
      resolver.link('darren', 'whatsapp:+1234567890');
      expect(resolver.resolve('whatsapp:+1234567890')).toBe('darren');
      expect(resolver.getPlatformIds('darren')).toContain('whatsapp:+1234567890');
    });

    it('creates a new canonical when linking unknown name', () => {
      resolver.link('bob', 'signal:bob123');
      expect(resolver.resolve('signal:bob123')).toBe('bob');
    });

    it('moves platform ID if it was already linked elsewhere', () => {
      resolver.link('alice', 'telegram:123456'); // was darren's
      expect(resolver.resolve('telegram:123456')).toBe('alice');
      expect(resolver.getPlatformIds('darren')).not.toContain('telegram:123456');
    });
  });

  describe('unlink', () => {
    it('removes a platform ID from its canonical', () => {
      resolver.unlink('slack:U001');
      expect(resolver.resolve('slack:U001')).toBe('slack:U001');
      expect(resolver.getPlatformIds('darren')).not.toContain('slack:U001');
    });

    it('deletes the canonical when last ID is removed', () => {
      resolver.unlink('telegram:789012');
      resolver.unlink('discord:alice#5678');
      expect(resolver.getPlatformIds('alice')).toEqual([]);
      expect(resolver.listAll()['alice']).toBeUndefined();
    });

    it('does nothing for unknown platform ID', () => {
      resolver.unlink('telegram:unknown');
      // No error thrown
      expect(resolver.listAll()).toBeTruthy();
    });
  });

  describe('listAll', () => {
    it('returns a copy of all mappings', () => {
      const all = resolver.listAll();
      expect(Object.keys(all)).toContain('darren');
      expect(Object.keys(all)).toContain('alice');

      // Should be a copy, not a reference
      all['darren'] = [];
      expect(resolver.getPlatformIds('darren').length).toBeGreaterThan(0);
    });
  });
});
