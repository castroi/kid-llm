// @vitest-environment node
import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import vercel from '../../vercel.json';
import { AI_PROVIDERS, allEndpoints } from '../ai/catalog';

const siteHeaders = vercel.headers.find((rule) => rule.source === '/(.*)')?.headers ?? [];
const header = (key: string) => siteHeaders.find((h) => h.key === key)?.value;
const csp = header('Content-Security-Policy') ?? '';
const directive = (name: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `))
    ?.split(/\s+/)
    .slice(1) ?? [];

describe('security headers (vercel.json)', () => {
  it('locks the page down to its own origin', () => {
    for (const part of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      expect(csp).toContain(part);
    }
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('has no inline script or style in the page, because the CSP would block it', () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(indexHtml).not.toMatch(/<style[\s>]/);
    expect(indexHtml).not.toMatch(/\sstyle=/);
  });

  it("lets the page call only its own origin and the AI providers' exact endpoints", () => {
    // Her chats may leave the phone only to these URLs; anything else stays blocked,
    // including other paths on the providers' own sites.
    expect([...directive('connect-src')].sort()).toEqual(["'self'", ...allEndpoints()].sort());
    for (const provider of Object.values(AI_PROVIDERS)) {
      for (const url of Object.values(provider.endpoints)) {
        // A full path, not a folder: CSP treats a trailing "/" as "everything below".
        expect(url.startsWith(`${provider.origin}/`)).toBe(true);
        expect(url).toMatch(/^https:\/\/[a-z0-9.-]+(\/[a-z0-9_-]+)+$/);
      }
    }
  });

  it('sends the other protective headers on every page', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('Referrer-Policy')).toBe('no-referrer');
    expect(header('X-Frame-Options')).toBe('DENY');
    expect(header('Permissions-Policy')).toContain('geolocation=()');
    expect(header('Strict-Transport-Security')).toMatch(/max-age=\d+/);
  });
});
