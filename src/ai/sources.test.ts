// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_SITE_CHARS, MAX_SITE_LABELS, MAX_SOURCES, MAX_SOURCE_URL_CHARS, sanitizeSources, siteName } from './sources';

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

  it('drops number addresses, also the phone itself and devices at home, however they are written', () => {
    const numbers = ['https://192.168.1.1/', 'https://10.0.0.1/', 'https://1.2.3.4/', 'https://127.0.0.1/', 'https://127.1/', 'https://0x7f.1/', 'https://2130706433/', 'https://[::1]/', 'https://[2001:db8::1]/', 'https://[::ffff:192.168.1.1]/', 'https://192.168.1.1./', 'https://%31%32%37.0.0.1/'];
    expect(sanitizeSources(numbers.map((url) => ({ url })))).toEqual([]);
  });

  it('drops an address on another port, and hosts that are not an ordinary site name', () => {
    const odd = [
      'https://example.com:8443/x',
      'https://www./',
      'https://.com/',
      'https://a..b/',
      'https://example.com./',
      'https://www.localhost/',
      'https://www.com/',
      'https://a.b.c.d.e.example.com/',
      `https://${'a'.repeat(MAX_SITE_CHARS)}.example.com/`,
      'blob:https://example.com/1234',
      'view-source:https://example.com/',
    ];
    for (const url of odd) expect(sanitizeSources([{ url }]), url).toEqual([]);
    // The usual port written out is the usual port.
    expect(sanitizeSources([{ url: 'https://example.com:443/x' }])).toEqual([{ url: 'https://example.com/x' }]);
  });

  it('drops a site name with punctuation in it, or a part that starts or ends with a hyphen', () => {
    for (const url of ['https://exa_mple.com/', 'https://-example.com/', 'https://example-.com/', 'https://exa{mple}.com/', 'https://example.123/']) expect(sanitizeSources([{ url }]), url).toEqual([]);
  });

  it('keeps ordinary sites, up to the longest name and the most parts allowed', () => {
    for (const url of ['https://he.wikipedia.org/', 'https://he.m.wikipedia.org/', 'https://www.gov.il/', 'https://kids.britannica.com/', 'https://www.example.co.il/', 'https://xn--4dbrk0ce.co.il/']) {
      expect(sanitizeSources([{ url }]), url).toEqual([{ url }]);
    }
    const parts = (count: number) => `https://${Array.from({ length: count - 2 }, (_, i) => `p${i}`).join('.')}.example.com/`;
    expect(sanitizeSources([{ url: parts(MAX_SITE_LABELS) }])).toHaveLength(1);
    expect(sanitizeSources([{ url: parts(MAX_SITE_LABELS + 1) }])).toEqual([]);
    const long = (chars: number) => `https://${'a'.repeat(chars - '.example.com'.length)}.example.com/`;
    expect(sanitizeSources([{ url: long(MAX_SITE_CHARS) }])).toHaveLength(1);
    expect(sanitizeSources([{ url: long(MAX_SITE_CHARS + 1) }])).toEqual([]);
  });

  it('keeps the address as URL wrote it, never the text as it came', () => {
    const tricky = sanitizeSources([{ url: '  HTTPS://Example.COM\\a\\b  ' }, { url: 'https://good.example.org\\@evil.example.net/' }, { url: 'ht\ttps://tab.example.io/' }]);
    expect(tricky).toEqual([{ url: 'https://example.com/a/b' }, { url: 'https://good.example.org/@evil.example.net/' }, { url: 'https://tab.example.io/' }]);
    expect(tricky.map((source) => siteName(source.url))).toEqual(['example.com', 'good.example.org', 'tab.example.io']);
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

  it('is empty for something that is not an address that may be linked', () => {
    for (const bad of ['nope', 'http://example.com/', 'https://192.168.1.1/', 'https://www./', 'https://example.com:8443/', 'javascript:alert(1)']) expect(siteName(bad), bad).toBe('');
  });
});
