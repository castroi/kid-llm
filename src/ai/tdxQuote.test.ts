// @vitest-environment node
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { certificate, der, ECDSA_SHA384, KEY_ON_P384, NOW, pem, signedQuote, STRANGER_SECRET, VALID_FROM, VALID_TO, type QuoteOptions } from '../test/quote';
import { checkQuote } from './tdxQuote';

// Intel's root is replaced by a test root for this file, so the tests can sign as "Intel".
// The real root, with real quotes from Intel hardware, is in tdxQuote.intel.test.ts.
vi.mock('./intelRoot', async () => ({ INTEL_SGX_ROOT_KEY: (await import('../test/quote')).TEST_ROOT_KEY }));

/** The same certificate with one letter of its subject's name changed, so its signature no longer fits. */
function renamed(block: string): string {
  const bytes = Uint8Array.from(atob(block.replace(/-----[A-Z ]+-----|\s/g, '')), (char) => char.charCodeAt(0));
  // "Test PCK …": the subject is the last name in the certificate that starts this way.
  const at = String.fromCharCode(...bytes).lastIndexOf('Test PCK');
  expect(at).toBeGreaterThan(0);
  bytes[at] ^= 0x01;
  return pem(bytes);
}

/** Why a quote was refused; fails the test if it passed. */
async function refusal(options: QuoteOptions, now = NOW): Promise<string> {
  const result = await checkQuote(signedQuote(options), now);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.why;
}

describe('a TDX quote whose signatures lead to the root', () => {
  it('passes, and gives the REPORTDATA the enclave chose', async () => {
    const reportData = Uint8Array.from({ length: 64 }, (_, i) => i);
    const result = await checkQuote(signedQuote({ reportData }), NOW);
    expect(result).toEqual({ ok: true, reportData });
  });

  it('passes as a version 5 quote, with a TD report 1.0 or 1.5', async () => {
    for (const bodyType of [2, 3] as const) {
      const reportData = new Uint8Array(64).fill(bodyType);
      expect(await checkQuote(signedQuote({ version: 5, bodyType, reportData }), NOW)).toEqual({ ok: true, reportData });
    }
  });

  it('passes with bytes after the signature data, as real quotes have', async () => {
    expect((await checkQuote(signedQuote({ padding: 70 }), NOW)).ok).toBe(true);
  });

  it('reads certificate dates in both forms, and holds them to the day', async () => {
    for (const generalizedTime of [false, true]) {
      const options: QuoteOptions = { issuer: { generalizedTime }, pck: { generalizedTime } };
      expect((await checkQuote(signedQuote(options), VALID_FROM)).ok).toBe(true);
      expect((await checkQuote(signedQuote(options), VALID_TO)).ok).toBe(true);
      expect(await refusal(options, VALID_FROM - 1000)).toBe('a certificate that is out of date');
      expect(await refusal(options, VALID_TO + 1000)).toBe('a certificate that is out of date');
    }
  });

  it('reads a two-digit year of 50 and up as 19xx', async () => {
    // Valid 1999 to 2035: fine now. Valid 2025 to "49" means 2049, to "50" would mean 1950.
    expect((await checkQuote(signedQuote({ issuer: { notBefore: Date.UTC(1999, 0, 1) } }), NOW)).ok).toBe(true);
    expect((await checkQuote(signedQuote({ issuer: { notAfter: Date.UTC(2049, 11, 31) } }), NOW)).ok).toBe(true);
    expect(await refusal({ issuer: { notAfter: Date.UTC(2050, 0, 1) } })).toBe('a certificate that is out of date');
  });

  it('reads a certificate signature whose numbers are shorter than usual', async () => {
    expect((await checkQuote(signedQuote({ issuer: { shortR: true } }), NOW)).ok).toBe(true);
    expect((await checkQuote(signedQuote({ pck: { shortR: true } }), NOW)).ok).toBe(true);
  });

  it('does not read the root certificate the quote carries: only the key the app holds counts', async () => {
    expect((await checkQuote(signedQuote({ chain: ([pck, issuer]) => [pck, issuer] }), NOW)).ok).toBe(true);
    expect((await checkQuote(signedQuote({ chain: ([pck, issuer]) => [pck, issuer, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'] }), NOW)).ok).toBe(true);
  });
});

describe('a quote that Intel did not sign is refused', () => {
  const cases: [string, QuoteOptions, string][] = [
    ['the chain starts at another root', { rootSecret: STRANGER_SECRET }, "the certificate chain does not lead to Intel's root"],
    ['the issuer certificate was changed after the root signed it', { chain: ([pck, issuer, root]) => [pck, renamed(issuer), root] }, "the certificate chain does not lead to Intel's root"],
    ['the PCK certificate was changed after it was signed', { chain: ([pck, issuer, root]) => [renamed(pck), issuer, root] }, 'the PCK certificate was not signed by the certificate above it'],
    ['the issuer may not sign certificates', { issuer: { authority: false } }, 'a certificate that may not sign others was used to sign one'],
    ['the issuer says in so many words that it may not sign certificates', { issuer: { authority: 'written false' } }, 'a certificate that may not sign others was used to sign one'],
    ['the issuer says nothing about signing certificates', { issuer: { authority: 'none' } }, 'a certificate that may not sign others was used to sign one'],
    ['the issuer is an old-style certificate with no extensions', { issuer: { v1: true } }, 'a certificate that may not sign others was used to sign one'],
    ['the PCK certificate was signed by a stranger', { pck: { signer: STRANGER_SECRET } }, 'the PCK certificate was not signed by the certificate above it'],
    ['the PCK certificate names another issuer', { pck: { issuer: 'Somebody Else CA' } }, 'the PCK certificate was not signed by the certificate above it'],
    ["the first certificate has no SGX extension: something else Intel's chain signed", { pck: { sgxExtension: false } }, 'the first certificate is not a PCK certificate'],
    ['the first certificate may sign others: not a processor', { pck: { authority: true } }, 'the first certificate is not a PCK certificate'],
    ['the PCK certificate has run out', { pck: { notAfter: NOW - 1000 } }, 'a certificate that is out of date'],
    ['the PCK certificate is not valid yet', { pck: { notBefore: NOW + 1000 } }, 'a certificate that is out of date'],
    ['the issuer certificate has run out', { issuer: { notAfter: NOW - 1000 } }, 'a certificate that is out of date'],
    ['the quoting enclave report was signed by a stranger', { qeSigner: STRANGER_SECRET }, 'the quoting enclave report was not signed by the PCK key'],
    ["the quoting enclave has another signer than Intel's", { qeMrSigner: 'ab'.repeat(32) }, "the quoting enclave is not Intel's"],
    ['the quoting enclave is another product', { qeProduct: 1 }, "the quoting enclave is not Intel's"],
    ['the quoting enclave is in debug mode', { qeFlags: 0x17 }, "the quoting enclave is not Intel's"],
    ['the quoting enclave may not use the provisioning key', { qeFlags: 0x05 }, "the quoting enclave is not Intel's"],
    ['the quoting enclave has a MISCSELECT bit set', { qeMiscSelect: 1 }, "the quoting enclave is not Intel's"],
    ['the quoting enclave vouches for another attestation key', { qeReportData: new Uint8Array(64).fill(9) }, 'the attestation key is not the one the quoting enclave reported'],
    ['the quote was signed by a stranger', { quoteSigner: STRANGER_SECRET }, 'the quote was not signed by its attestation key'],
    ['REPORTDATA was changed after signing', { afterSigning: (signed) => (signed[48 + 520] ^= 1) }, 'the quote was not signed by its attestation key'],
    ['the header was changed after signing', { afterSigning: (signed) => (signed[20] ^= 1) }, 'the quote was not signed by its attestation key'],
    ['the attestation key is of another kind', { keyType: 3 }, 'an attestation key that is not ECDSA on P-256'],
    ['there is no quoting enclave report', { outerType: 5 }, 'no quoting enclave report in the quote'],
    ['the certificates are not in the quote', { innerType: 3 }, 'no certificate chain in the quote'],
    ['the chain has one certificate', { chain: ([pck]) => [pck] }, 'no certificate chain in the quote'],
    ['the chain is empty', { chain: () => [] }, 'no certificate chain in the quote'],
    ['a certificate signed with another algorithm', { issuer: { algorithm: ECDSA_SHA384 } }, 'a certificate that is not signed with ECDSA and SHA-256'],
    ['a certificate that names another algorithm inside than outside', { pck: { signedPart: (fields) => fields.map((field, i) => (i === 2 ? ECDSA_SHA384 : field)) } }, 'a certificate that could not be read'],
    ['a certificate whose key is on another curve', { pck: { keyAlgorithm: KEY_ON_P384 } }, 'a certificate whose key is not on P-256'],
    ['a certificate with a field missing', { pck: { signedPart: (fields) => fields.slice(0, 5) } }, 'a certificate that could not be read'],
    ['a certificate whose date is not a date', { pck: { signedPart: (fields) => fields.map((field, i) => (i === 4 ? der(0x30, der(0x17, [0x41, 0x42]), der(0x17, [0x41, 0x42])) : field)) } }, 'a certificate date that could not be read'],
    ['a certificate whose date is another kind of value', { pck: { signedPart: (fields) => fields.map((field, i) => (i === 4 ? der(0x30, der(0x0c, [0x41]), der(0x0c, [0x41])) : field)) } }, 'a certificate date that could not be read'],
    ['a certificate with no dates', { pck: { signedPart: (fields) => fields.map((field, i) => (i === 4 ? der(0x30) : field)) } }, 'a certificate date that could not be read'],
  ];
  it.each(cases)('%s', async (_name: string, options: QuoteOptions, why: string) => {
    expect(await refusal(options)).toBe(why);
  });

  it('a PCK certificate signed by the root itself, with the root not above it in the chain', async () => {
    // The second certificate must be signed by the root AND be the signer of the first.
    const stray = pem(certificate({ subject: 'Stray CA', issuer: 'Test Root CA', secret: STRANGER_SECRET, signer: STRANGER_SECRET, authority: true }));
    expect(await refusal({ chain: ([pck, , root]) => [pck, stray, root] })).toBe("the certificate chain does not lead to Intel's root");
  });

  it('a self-made chain that only names Intel', async () => {
    // A forger's own root, issuer and PCK certificate with the right names: the names prove nothing.
    expect(await refusal({ rootSecret: STRANGER_SECRET, issuer: { subject: 'Intel SGX PCK Platform CA', issuer: 'Intel SGX Root CA' }, pck: { issuer: 'Intel SGX PCK Platform CA' } })).toBe("the certificate chain does not lead to Intel's root");
  });
});

describe('a quote that can not be read is refused', () => {
  it('cut short anywhere', async () => {
    const quote = signedQuote();
    for (let length = 0; length < quote.length; length += 23) expect((await checkQuote(quote.slice(0, length), NOW)).ok).toBe(false);
    expect((await checkQuote(quote.slice(0, quote.length - 1), NOW)).ok).toBe(false);
    expect(await checkQuote(quote.slice(0, 700), NOW)).toEqual({ ok: false, why: 'the quote is cut short' });
  });

  it('of another kind or version', async () => {
    const sgx = signedQuote();
    sgx[4] = 0x00;
    expect(await checkQuote(sgx, NOW)).toEqual({ ok: false, why: 'not a TDX quote of a known version' });
    const v3 = signedQuote();
    v3[0] = 3;
    expect(await checkQuote(v3, NOW)).toEqual({ ok: false, why: 'not a TDX quote of a known version' });
    expect((await checkQuote(new Uint8Array(0), NOW)).ok).toBe(false);
  });

  it('with certificates that are not certificates', async () => {
    const block = (bytes: number[]) => pem(Uint8Array.from(bytes));
    const unreadable = 'a certificate that could not be read';
    const broken: [number[], string][] = [
      [[], unreadable], // nothing
      [[0x04, 0x01, 0x00], unreadable], // not a sequence
      [[0x30, 0x03, 0x02, 0x01, 0x00], 'a certificate that is not signed with ECDSA and SHA-256'], // a sequence of the wrong things
      [[0x30, 0x80, 0x00, 0x00], unreadable], // a length with no end
      [[0x30, 0x83, 0x00, 0x00, 0x01, 0x00], unreadable], // a length of three bytes
      [[0x30, 0x05, 0x02, 0x01], unreadable], // shorter than it says
      [[0x30, 0x81], unreadable], // the length is missing
      [[0x30], unreadable], // nothing after the tag
      [[0x1f, 0x01, 0x00], unreadable], // a long tag
      [[0x30, 0x00, 0x30, 0x00], unreadable], // two values where one belongs
    ];
    for (const [bytes, why] of broken) {
      expect(await refusal({ chain: ([, issuer, root]) => [block(bytes), issuer, root] })).toBe(why);
    }
    // Base64 that is not base64 can't be decoded at all.
    expect(await refusal({ chain: ([, issuer, root]) => ['-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n', issuer, root] })).toBe('the quote could not be read');
  });

  it('with a certificate signature that is not two numbers', async () => {
    const int = (...bytes: number[]) => der(0x02, bytes);
    const full = new Array<number>(32).fill(0x11);
    const notSignatures = [
      der(0x30, int(...full)), // one number
      der(0x30, int(...full), int(...full), int(...full)), // three
      der(0x30, int(1, ...full), int(...full)), // r of 33 bytes that is not a leading zero
      der(0x30, int(), int(...full)), // an empty r
      der(0x30, der(0x04, full), int(...full)), // r is not a number
      der(0x04, full), // not a sequence
      Uint8Array.from([0x30, 0x10, 0x02]), // cut short
    ];
    for (const signature of notSignatures) {
      expect(await refusal({ issuer: { signature } })).toMatch(/^a certificate( signature)? that could not be read$/);
      expect(await refusal({ pck: { signature } })).toMatch(/^a certificate( signature)? that could not be read$/);
    }
    // Two numbers of the right size that are nobody's signature.
    expect(await refusal({ issuer: { signature: der(0x30, int(...full), int(...full)) } })).toBe("the certificate chain does not lead to Intel's root");
    // Zero, and numbers past the curve's order.
    expect(await refusal({ issuer: { signature: der(0x30, int(0), int(0)) } })).toBe("the certificate chain does not lead to Intel's root");
    expect(await refusal({ issuer: { signature: der(0x30, int(0, ...new Array<number>(32).fill(0xff)), int(0, ...new Array<number>(32).fill(0xff))) } })).toBe("the certificate chain does not lead to Intel's root");
  });

  it('with a key that is not a point on the curve, even when everything above it vouches for it', async () => {
    // (1, 1) is not on P-256. The browser refuses to take such a key at all; that must count as a wrong signature.
    const offCurve = new Uint8Array(64);
    offCurve[31] = 1;
    offCurve[63] = 1;
    expect(await refusal({ attestationKey: offCurve })).toBe('the quote was not signed by its attestation key');
    expect(await refusal({ pck: { publicKey: Uint8Array.from([4, ...offCurve]) } })).toBe('the quoting enclave report was not signed by the PCK key');
    expect(await refusal({ issuer: { publicKey: Uint8Array.from([4, ...offCurve]) } })).toBe('the PCK certificate was not signed by the certificate above it');
  });

  it('with a signature or a key that is not one', async () => {
    // An attestation key that is not a point on the curve, named correctly by the QE report.
    const quote = signedQuote();
    const keyAt = 48 + 584 + 4 + 64;
    quote.fill(0xff, keyAt, keyAt + 64);
    expect((await checkQuote(quote, NOW)).ok).toBe(false);
    // A certificate signature that is not DER.
    expect(await refusal({ chain: ([pck, issuer, root]) => [pck, issuer, root].map((cert, i) => (i === 0 ? pem(certificate({ subject: 'x', issuer: 'Test PCK Platform CA', secret: STRANGER_SECRET, signer: STRANGER_SECRET }).slice(0, -3)) : cert)) })).toBe('a certificate that could not be read');
  });
});

describe('what the check reads', () => {
  it('REPORTDATA comes from the signed bytes, as a copy', async () => {
    const quote = signedQuote({ reportData: new Uint8Array(64).fill(1) });
    const result = await checkQuote(quote, NOW);
    expect(result.ok).toBe(true);
    quote.fill(0);
    expect(result.ok && bytesToHex(result.reportData)).toBe('01'.repeat(64));
  });
});
