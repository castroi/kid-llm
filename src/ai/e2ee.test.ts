// @vitest-environment node
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { base64, enclaveDecrypt, enclaveEncrypt, fakeQuote } from '../test/enclave';
import { attestationNonce, decryptPiece, encryptFor, looksEncrypted, MIN_ENCRYPTED_HEX, modelKeyFrom, newClientKeys, quoteIsNotDebug, wipe } from './e2ee';

/**
 * A known answer made with another implementation (pyca/cryptography, as in Venice's Python
 * example): recipient key 0x1f…1f, ephemeral key 0x2e…2e, nonce 00…0b. If the curve, the
 * x-coordinate, the HKDF salt or info, or the layout were wrong here, this would not decrypt.
 */
const KNOWN = {
  recipientSecret: '1f'.repeat(32),
  recipientPublic: '04505f234a81fe3af88625ebda259dbaec44c72b181e2f64735f8b8ec8d7cf737766f224ea0c54423fd914028e8fd81502133f9aef9f794e5be600355fc5f3a150',
  sealed:
    '04d98a7def67e8370118f636620d0be08ed63344df68082b4f2f1844e7ce601483c24513adf106691cbf259fab7dd8ea7a70348b54e4a87c94c4d13e572f31ca89000102030405060708090a0b924a46abba205ed91b8be3905ce8fc2c187179e0d8f14cbdafb4b5b6b7c8a8b5969c',
  text: 'כמה זה 3 + 5?',
};

describe('agreement with another implementation', () => {
  it('decrypts a piece that pyca/cryptography encrypted, and derives the same public key', () => {
    const secret = hexToBytes(KNOWN.recipientSecret);
    expect(bytesToHex(secp256k1.getPublicKey(secret, false))).toBe(KNOWN.recipientPublic);
    expect(looksEncrypted(KNOWN.sealed)).toBe(true);
    expect(decryptPiece(secret, KNOWN.sealed)).toBe(KNOWN.text);
  });
});

describe('end-to-end encryption (Venice E2EE)', () => {
  const enclave = secp256k1.utils.randomSecretKey();
  const enclavePublic = bytesToHex(secp256k1.getPublicKey(enclave, false));

  it('encrypts a message so that only the enclave can read it, Hebrew and maths included', () => {
    const text = 'כמה זה 3 + 5 = 8? 🙂';
    const sealed = encryptFor(enclavePublic, text);
    expect(sealed).toMatch(/^[0-9a-f]+$/);
    expect(sealed.startsWith('04')).toBe(true);
    expect(looksEncrypted(sealed)).toBe(true);
    expect(sealed).not.toContain(bytesToHex(new TextEncoder().encode(text)));
    expect(enclaveDecrypt(enclave, sealed)).toBe(text);
    // Another key can't read it.
    expect(() => enclaveDecrypt(secp256k1.utils.randomSecretKey(), sealed)).toThrow();
  });

  it('uses a new key and nonce for every message', () => {
    const a = encryptFor(enclavePublic, 'שלום');
    const b = encryptFor(enclavePublic, 'שלום');
    expect(a).not.toBe(b);
    expect(a.slice(0, 130)).not.toBe(b.slice(0, 130));
    expect(a.slice(130, 154)).not.toBe(b.slice(130, 154));
  });

  it("decrypts the enclave's answer with this call's key only, and refuses one that was changed", () => {
    const keys = newClientKeys();
    expect(keys.publicKeyHex).toMatch(/^04[0-9a-f]{128}$/);
    const answer = enclaveEncrypt(keys.publicKeyHex, 'תשובה');
    expect(decryptPiece(keys.secretKey, answer)).toBe('תשובה');
    const changed = answer.slice(0, -2) + (answer.endsWith('00') ? '01' : '00');
    expect(() => decryptPiece(keys.secretKey, changed)).toThrow();
    expect(() => decryptPiece(newClientKeys().secretKey, answer)).toThrow();
  });

  it('wipes the secret key', () => {
    const keys = newClientKeys();
    wipe(keys);
    expect(keys.secretKey.every((byte) => byte === 0)).toBe(true);
  });

  it("tells an encrypted piece by the docs' rule: hex, at least 186 characters", () => {
    expect(MIN_ENCRYPTED_HEX).toBe(186);
    expect(looksEncrypted('a'.repeat(186))).toBe(true);
    expect(looksEncrypted('A'.repeat(188))).toBe(true);
    expect(looksEncrypted('a'.repeat(184))).toBe(false);
    expect(looksEncrypted('a'.repeat(187))).toBe(false);
    expect(looksEncrypted(`${'a'.repeat(185)}g`)).toBe(false);
    expect(looksEncrypted('שלום')).toBe(false);
    expect(looksEncrypted('')).toBe(false);
  });

  it("takes the model's key only as a valid uncompressed point, adding the 04 the docs allow to be missing", () => {
    expect(modelKeyFrom(enclavePublic)).toBe(enclavePublic);
    expect(modelKeyFrom(enclavePublic.toUpperCase())).toBe(enclavePublic);
    expect(modelKeyFrom(enclavePublic.slice(2))).toBe(enclavePublic);
    expect(modelKeyFrom(`0x${enclavePublic}`)).toBe(enclavePublic);
    // On the curve or nothing: a changed coordinate is no key.
    expect(modelKeyFrom(`${enclavePublic.slice(0, -1)}${enclavePublic.endsWith('0') ? '1' : '0'}`)).toBeNull();
    expect(modelKeyFrom(`04${'0'.repeat(128)}`)).toBeNull();
    expect(modelKeyFrom(bytesToHex(secp256k1.getPublicKey(enclave, true)))).toBeNull();
    expect(modelKeyFrom(`05${enclavePublic.slice(2)}`)).toBeNull();
    expect(modelKeyFrom(`${enclavePublic.slice(0, -1)}z`)).toBeNull();
    for (const value of [undefined, null, 7, {}, '']) expect(modelKeyFrom(value)).toBeNull();
  });

  it('makes a 32-byte attestation nonce, new each time', () => {
    const a = attestationNonce();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(attestationNonce()).not.toBe(a);
  });
});

describe('the TDX debug check', () => {
  it('passes a version 4 quote whose DEBUG bit is off, in base64 or in hex', () => {
    expect(quoteIsNotDebug(base64(fakeQuote()))).toBe(true);
    expect(quoteIsNotDebug(bytesToHex(fakeQuote()))).toBe(true);
    expect(quoteIsNotDebug(`0x${bytesToHex(fakeQuote())}`)).toBe(true);
    expect(quoteIsNotDebug(base64(fakeQuote()).replace(/\+/g, '-').replace(/\//g, '_'))).toBe(true);
  });

  it('reads a version 5 quote past its body descriptor, for TD reports 1.0 and 1.5', () => {
    expect(quoteIsNotDebug(base64(fakeQuote({ version: 5 })))).toBe(true);
    expect(quoteIsNotDebug(base64(fakeQuote({ version: 5, bodyType: 3 })))).toBe(true);
    // The review's case: a version 5 debug enclave must not pass.
    expect(quoteIsNotDebug(base64(fakeQuote({ version: 5, debug: true })))).toBe(false);
    expect(quoteIsNotDebug(base64(fakeQuote({ version: 5, bodyType: 3, debug: true })))).toBe(false);
  });

  it('fails a debug enclave, and anything it cannot read as a TDX quote', () => {
    expect(quoteIsNotDebug(base64(fakeQuote({ debug: true })))).toBe(false);
    expect(quoteIsNotDebug(base64(fakeQuote({ teeType: 0x00 })))).toBe(false);
    expect(quoteIsNotDebug(base64(fakeQuote({ version: 3 })))).toBe(false);
    expect(quoteIsNotDebug(base64(fakeQuote({ version: 5, bodyType: 1 })))).toBe(false);
    expect(quoteIsNotDebug(base64(fakeQuote({ version: 5, bodySize: 600 })))).toBe(false);
    expect(quoteIsNotDebug(base64(fakeQuote({ cut: 1 })))).toBe(false);
    expect(quoteIsNotDebug(base64(fakeQuote({ version: 5, cut: 1 })))).toBe(false);
    expect(quoteIsNotDebug(base64(new Uint8Array(40)))).toBe(false);
    expect(quoteIsNotDebug('not a quote!')).toBe(false);
    expect(quoteIsNotDebug('A'.repeat(64 * 1024 + 4))).toBe(false);
    for (const value of [undefined, null, 7, {}, '']) expect(quoteIsNotDebug(value)).toBe(false);
  });
});
