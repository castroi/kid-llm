// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_SOURCES, MAX_SOURCE_URL_CHARS, sanitizeSources, siteName } from './sources';

describe('sanitizeSources', () => {
  it('keeps only the address of a citation: no title, page text or date', () => {
    const sources = sanitizeSources([{ title: 'Telephone', url: 'https://he.wikipedia.org/wiki/טלפון', content: 'page text', date: '2026-01-01T00:00:00Z', extra: 1 }]);
    expect(sources).toEqual([{ url: new URL('https://he.wikipedia.org/wiki/טלפון').href }]);
    expect(JSON.stringify(sources)).not.toContain('page text');
    expect(JSON.stringify(sources)).not.toContain('Telephone');
  });

  it('drops every address that is not a plain https page', () => {
    const bad = [
      { url: 'javascript:alert(1)' },
      { url: 'data:text/html,<script>alert(1)</script>' },
      { url: 'http://example.com/' },
      { url: 'file:///etc/passwd' },
      { url: 'https://user:pass@example.com/' },
      { url: 'https://user@example.com/' },
      { url: 'https://localhost/' },
      { url: 'not an address' },
      { url: `https://example.com/${'a'.repeat(MAX_SOURCE_URL_CHARS)}` },
      { url: 42 },
      { title: 'no address' },
      null,
      'https://example.com/',
    ];
    expect(sanitizeSources(bad)).toEqual([]);
  });

  it('is empty for anything that is not a list', () => {
    for (const junk of [null, undefined, 'text', 7, {}, { url: 'https://example.com/' }]) expect(sanitizeSources(junk)).toEqual([]);
  });

  it('keeps one link per site, the first, and counts www as the same site', () => {
    const sources = sanitizeSources([{ url: 'https://www.example.com/a' }, { url: 'https://example.com/b' }, { url: 'https://other.example.org/' }]);
    expect(sources).toEqual([{ url: 'https://www.example.com/a' }, { url: 'https://other.example.org/' }]);
  });

  it(`keeps at most ${MAX_SOURCES}`, () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ url: `https://site${i}.example.com/` }));
    expect(sanitizeSources(many)).toHaveLength(MAX_SOURCES);
  });
});

describe('siteName', () => {
  it("is the site's name, without www", () => {
    expect(siteName('https://www.example.com/a/b?c=d')).toBe('example.com');
    expect(siteName('https://he.wikipedia.org/wiki/x')).toBe('he.wikipedia.org');
  });

  it('shows an international name in plain letters, so a look-alike cannot pass for a known site', () => {
    expect(siteName('https://аpple.com/')).toMatch(/^xn--/);
  });

  it('is empty for something that is not an address', () => {
    expect(siteName('nope')).toBe('');
  });
});
