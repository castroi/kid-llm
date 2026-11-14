// @vitest-environment node
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { base64, enclaveDecrypt, enclaveEncrypt, fakeQuote } from '../test/enclave';
import { attestationNonce, decryptPiece, encryptFor, looksEncrypted, MIN_ENCRYPTED_HEX, modelKeyFrom, newClientKeys, quoteIsNotDebug, wipe } from './e2ee';

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
  it('passes a quote whose DEBUG bit is off, in base64 or in hex', () => {
    expect(quoteIsNotDebug(base64(fakeQuote()))).toBe(true);
    expect(quoteIsNotDebug(bytesToHex(fakeQuote()))).toBe(true);
    expect(quoteIsNotDebug(`0x${bytesToHex(fakeQuote())}`)).toBe(true);
    expect(quoteIsNotDebug(base64(fakeQuote()).replace(/\+/g, '-').replace(/\//g, '_'))).toBe(true);
  });

  it('fails a debug enclave, and anything it cannot read as a TDX quote', () => {
    expect(quoteIsNotDebug(base64(fakeQuote({ debug: true })))).toBe(false);
    expect(quoteIsNotDebug(base64(fakeQuote({ teeType: 0x00 })))).toBe(false);
    expect(quoteIsNotDebug(base64(fakeQuote({ length: 631 })))).toBe(false);
    expect(quoteIsNotDebug('not a quote!')).toBe(false);
    expect(quoteIsNotDebug('A'.repeat(64 * 1024 + 4))).toBe(false);
    for (const value of [undefined, null, 7, {}, '']) expect(quoteIsNotDebug(value)).toBe(false);
  });
});
