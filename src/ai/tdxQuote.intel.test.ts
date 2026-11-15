// @vitest-environment node
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { INTEL_QUOTE_V4, INTEL_QUOTE_V4_REPORT_DATA, INTEL_QUOTE_V5, INTEL_QUOTE_V5_REPORT_DATA } from '../test/intelQuotes';
import { NOW, signedQuote } from '../test/quote';
import { quoteIsNotDebug } from './e2ee';
import { INTEL_SGX_ROOT_KEY } from './intelRoot';
import { checkQuote } from './tdxQuote';

// No stand-in here: Intel's real root key, and quotes that real Intel hardware signed.

describe("Intel's root key", () => {
  it('is a point on P-256, written as 04 || x || y', () => {
    expect(INTEL_SGX_ROOT_KEY).toMatch(/^04[0-9a-f]{128}$/);
    expect(() => p256.Point.fromBytes(hexToBytes(INTEL_SGX_ROOT_KEY)).assertValidity()).not.toThrow();
  });

  it('is the key of the "Intel SGX Root CA" certificate that real quotes carry', () => {
    // The last certificate in a real quote's chain is Intel's root, signed by itself. Its
    // SubjectPublicKeyInfo is a fixed prefix and then the key; SHA-256 of the whole certificate
    // is the fingerprint Intel's root is known by.
    const text = new TextDecoder('latin1').decode(hexToBytes(INTEL_QUOTE_V4));
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    expect(blocks).toHaveLength(3);
    const root = Uint8Array.from(atob(blocks[2].replace(/-----[A-Z ]+-----|\s/g, '')), (char) => char.charCodeAt(0));
    expect(bytesToHex(sha256(root))).toBe('44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3');
    expect(bytesToHex(root)).toContain(`3059301306072a8648ce3d020106082a8648ce3d030107034200${INTEL_SGX_ROOT_KEY}`);
  });
});

describe('quotes signed by real Intel hardware', () => {
  const real: [string, string, string][] = [
    ['version 4', INTEL_QUOTE_V4, INTEL_QUOTE_V4_REPORT_DATA],
    ['version 5', INTEL_QUOTE_V5, INTEL_QUOTE_V5_REPORT_DATA],
  ];

  it.each(real)('%s passes, and gives its REPORTDATA', (_name: string, hex: string, reportData: string) => {
    const result = checkQuote(hexToBytes(hex), NOW);
    expect(result.ok).toBe(true);
    expect(result.ok && bytesToHex(result.reportData)).toBe(reportData);
    expect(quoteIsNotDebug(hex)).toBe(true);
  });

  it.each(real)('%s is refused with one bit changed in any signed part', (_name: string, hex: string) => {
    const quote = hexToBytes(hex);
    const body = quote[0] === 5 ? 54 : 48;
    const signatureData = body + (quote[0] === 5 ? 648 : 584) + 4;
    const places = [
      0, // the header
      body + 120, // the TD attributes
      body + 136, // a measurement (MRTD)
      body + 520, // REPORTDATA
      body + 583, // its last byte
      signatureData, // the quote's signature
      signatureData + 64, // the attestation key
      signatureData + 134, // the quoting enclave's report
      signatureData + 134 + 384, // its signature
      signatureData + 134 + 384 + 66, // the quoting enclave's data
    ];
    for (const at of places) {
      const changed = quote.slice();
      changed[at] ^= 0x01;
      expect(checkQuote(changed, NOW).ok).toBe(false);
    }
  });

  it.each(real)('%s is refused with one letter changed in either certificate', (_name: string, hex: string) => {
    const quote = hexToBytes(hex);
    const text = new TextDecoder('latin1').decode(quote);
    const starts = [...text.matchAll(/-----BEGIN CERTIFICATE-----\n/g)].map((match) => (match.index ?? 0) + match[0].length);
    for (const start of starts.slice(0, 2)) {
      for (const offset of [0, 200, 600]) {
        const changed = quote.slice();
        // Another base64 letter: the certificate's bytes change, its length does not.
        changed[start + offset] = changed[start + offset] === 0x41 ? 0x42 : 0x41;
        expect(checkQuote(changed, NOW).ok).toBe(false);
      }
    }
  });

  it('is refused before its certificates are valid and after they run out', () => {
    expect(checkQuote(hexToBytes(INTEL_QUOTE_V4), Date.UTC(2025, 0, 1))).toEqual({ ok: false, why: 'a certificate that is out of date' });
    expect(checkQuote(hexToBytes(INTEL_QUOTE_V4), Date.UTC(2032, 2, 1))).toEqual({ ok: false, why: 'a certificate that is out of date' });
    // The certificate above it runs out in 2033.
    expect(checkQuote(hexToBytes(INTEL_QUOTE_V5), Date.UTC(2033, 5, 1))).toEqual({ ok: false, why: 'a certificate that is out of date' });
  });
});

describe('a quote that anyone could make', () => {
  it("is refused: a complete, well-signed chain that starts at somebody else's root", () => {
    expect(checkQuote(signedQuote(), NOW)).toEqual({ ok: false, why: "the certificate chain does not lead to Intel's root" });
  });
});
