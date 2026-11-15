import { gcm } from '@noble/ciphers/aes.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * Venice's end-to-end encryption, as its guide describes it: her messages are encrypted on
 * the phone to the key the attestation names as the model's enclave (TEE) key, and the answer
 * comes back encrypted to a key that only this call holds. That the key is an enclave's is
 * checked on the phone: Intel's signature on the quote (tdxQuote.ts), and that the quote
 * holds this key and this call's nonce (`quoteNamesKey`). Which software runs in that
 * enclave is not checked (providers.ts, `attest`).
 * Docs: https://docs.venice.ai/guides/features/tee-e2ee-models
 *
 * - Key agreement: ECDH on secp256k1; the shared secret is the 32-byte x-coordinate.
 * - Key derivation: HKDF-SHA256, no salt, info "ecdsa_encryption", 32 bytes.
 * - Cipher: AES-256-GCM with a fresh 12-byte nonce for every piece.
 * - On the wire, lowercase hex of: ephemeral public key (65 bytes, 04||x||y) || nonce (12) || ciphertext with its 16-byte tag.
 */

const HKDF_INFO = new TextEncoder().encode('ecdsa_encryption');
const PUBLIC_KEY_BYTES = 65;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The shortest encrypted piece: key, nonce and tag with no text (the docs' 186 hex characters). */
export const MIN_ENCRYPTED_HEX = (PUBLIC_KEY_BYTES + NONCE_BYTES + TAG_BYTES) * 2;
/** The attestation nonce: exactly 32 bytes, as the docs require (shorter ones are rejected). */
export const ATTESTATION_NONCE_BYTES = 32;

const HEX = /^[0-9a-fA-F]+$/;

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** A fresh random nonce for one attestation request, as 64 hex characters. */
export function attestationNonce(): string {
  return bytesToHex(random(ATTESTATION_NONCE_BYTES));
}

/** The key pair of one call. The secret stays in memory and is wiped (`wipe`) when the call ends. */
export interface ClientKeys {
  secretKey: Uint8Array;
  /** Uncompressed, 130 hex characters starting with "04": what X-Venice-TEE-Client-Pub-Key carries. */
  publicKeyHex: string;
}

export function newClientKeys(): ClientKeys {
  const secretKey = secp256k1.utils.randomSecretKey();
  return { secretKey, publicKeyHex: bytesToHex(secp256k1.getPublicKey(secretKey, false)) };
}

/** Overwrites a secret key's bytes, as the docs ask once the key is no longer needed. */
export function wipe(keys: ClientKeys): void {
  keys.secretKey.fill(0);
}

/**
 * The model's public key from the attestation, as the headers and the encryption take it:
 * 130 lowercase hex characters starting with "04" (a 128-character key gets the "04" the
 * docs say to add). Null for anything that is not a point on the curve.
 */
export function modelKeyFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let hex = value.startsWith('0x') ? value.slice(2) : value;
  if (hex.length === 128) hex = `04${hex}`;
  if (hex.length !== PUBLIC_KEY_BYTES * 2 || !hex.startsWith('04') || !HEX.test(hex)) return null;
  hex = hex.toLowerCase();
  return secp256k1.utils.isValidPublicKey(hexToBytes(hex), false) ? hex : null;
}

function aesKey(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  // getSharedSecret checks the point is on the curve; byte 0 is the parity, 1..32 the x-coordinate.
  // The arrays are wiped after use; the library's own big numbers can't be from JavaScript.
  const point = secp256k1.getSharedSecret(secretKey, publicKey, true);
  const x = point.subarray(1, 33);
  const key = hkdf(sha256, x, undefined, HKDF_INFO, 32);
  point.fill(0);
  return key;
}

/** Encrypts one message's text to the model's key, with a key pair used for this message only. */
export function encryptFor(modelKeyHex: string, text: string): string {
  const ephemeral = secp256k1.utils.randomSecretKey();
  const key = aesKey(ephemeral, hexToBytes(modelKeyHex));
  const nonce = random(NONCE_BYTES);
  const sealed = gcm(key, nonce).encrypt(new TextEncoder().encode(text));
  key.fill(0);
  const publicKey = secp256k1.getPublicKey(ephemeral, false);
  ephemeral.fill(0);
  const out = new Uint8Array(PUBLIC_KEY_BYTES + NONCE_BYTES + sealed.length);
  out.set(publicKey, 0);
  out.set(nonce, PUBLIC_KEY_BYTES);
  out.set(sealed, PUBLIC_KEY_BYTES + NONCE_BYTES);
  return bytesToHex(out);
}

/** A piece of the answer that is encrypted, by the docs' test: hex, and at least 186 characters long. */
export function looksEncrypted(content: string): boolean {
  return content.length >= MIN_ENCRYPTED_HEX && content.length % 2 === 0 && HEX.test(content);
}

/** Decrypts one piece of the answer with this call's secret key. Throws if it was not encrypted to it or was changed. */
export function decryptPiece(secretKey: Uint8Array, hex: string): string {
  const raw = hexToBytes(hex);
  const key = aesKey(secretKey, raw.subarray(0, PUBLIC_KEY_BYTES));
  try {
    const plain = gcm(key, raw.subarray(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + NONCE_BYTES)).decrypt(raw.subarray(PUBLIC_KEY_BYTES + NONCE_BYTES));
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } finally {
    key.fill(0);
  }
}

/*
 * The Intel TDX quote, only as far as the debug check needs it (Intel's TDX DCAP quote format):
 * - every version: a 48-byte header with the version (u16, little-endian) at 0 and the TEE
 *   type (u32) at 4, 0x81 for TDX;
 * - version 4: the TD report body follows the header right away (584 bytes);
 * - version 5: a 6-byte descriptor comes first (body type u16, size u32), then the body:
 *   type 2 is a TD report 1.0 (584 bytes), type 3 a TD report 1.5 (648 bytes).
 * In every body the TD attributes sit 120 bytes in; bit 0 of their first byte is DEBUG.
 * Any other version or body type is not read: it fails the check.
 */
const QUOTE_HEADER_BYTES = 48;
const TDX_TEE_TYPE = 0x81;
const TD_ATTRIBUTES_IN_BODY = 120;
const TD_REPORT_BYTES: Record<number, number> = { 2: 584, 3: 648 };
const MAX_QUOTE_CHARS = 64 * 1024;

const u16 = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8);
const u32 = (bytes: Uint8Array, at: number) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

/** Where the TD report body starts in a quote, or null for a quote this check can't read. */
export function tdReportAt(bytes: Uint8Array): number | null {
  if (bytes.length < QUOTE_HEADER_BYTES + 6 || u32(bytes, 4) !== TDX_TEE_TYPE) return null;
  const version = u16(bytes, 0);
  if (version === 4) return bytes.length >= QUOTE_HEADER_BYTES + TD_REPORT_BYTES[2] ? QUOTE_HEADER_BYTES : null;
  if (version !== 5) return null;
  const size = TD_REPORT_BYTES[u16(bytes, QUOTE_HEADER_BYTES)];
  const at = QUOTE_HEADER_BYTES + 6;
  if (size === undefined || u32(bytes, QUOTE_HEADER_BYTES + 2) !== size || bytes.length < at + size) return null;
  return at;
}

/** The quote's bytes, from the text the attestation carries it in; null when it is neither hex nor base64, or far too long. */
export function quoteBytes(quote: string): Uint8Array | null {
  if (quote.length > MAX_QUOTE_CHARS) return null;
  const value = quote.startsWith('0x') ? quote.slice(2) : quote;
  // The docs call it base64; hex is read too, since both have been seen.
  if (value.length % 2 === 0 && HEX.test(value)) return hexToBytes(value);
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Whether a TDX quote says its enclave is NOT in debug mode. False for a debug enclave and
 * for anything that can't be read as a TDX quote: a check that can't be made counts as failed.
 * This reads the quote only. It does not check Intel's signature on it, so it catches a
 * misconfigured enclave, not a provider that hands over a quote of its own making.
 */
export function quoteIsNotDebug(quote: unknown): boolean {
  if (typeof quote !== 'string') return false;
  const bytes = quoteBytes(quote);
  if (!bytes) return false;
  const body = tdReportAt(bytes);
  return body !== null && (bytes[body + TD_ATTRIBUTES_IN_BODY] & 0x01) === 0;
}

/**
 * Whether a quote's REPORTDATA names this model key and this call's nonce. Venice's
 * attestation fills the 64 bytes as: the key's Ethereum address (20 bytes: the last 20 of
 * Keccak-256 over the key's x and y), 12 unused bytes, then the 32-byte nonce, as it was
 * sent or as its SHA-256. Venice's guide says only that the key "should be bound to the TDX
 * REPORTDATA field"; the layout is the one two independent clients check
 * (github.com/elkimek/venice-e2ee, github.com/jooray/venice-e2ee-proxy).
 *
 * This means something only for a quote whose signature passed (tdxQuote.ts): then a real
 * Intel TDX machine put this key there, for this call. Which machine, running what, it does
 * not say: the quote's measurements are not compared with anything. `modelKeyHex` is the key as `modelKeyFrom` gives it; `nonceHex` is 64 hex characters.
 */
export function quoteNamesKey(reportData: Uint8Array, modelKeyHex: string, nonceHex: string): boolean {
  if (reportData.length !== 64 || modelKeyFrom(modelKeyHex) !== modelKeyHex || nonceHex.length !== ATTESTATION_NONCE_BYTES * 2 || !HEX.test(nonceHex)) return false;
  const address = keccak_256(hexToBytes(modelKeyHex).subarray(1)).subarray(12);
  const nonce = hexToBytes(nonceHex);
  const inQuote = bytesToHex(reportData.subarray(32));
  return bytesToHex(reportData.subarray(0, 20)) === bytesToHex(address) && (inQuote === bytesToHex(nonce) || inQuote === bytesToHex(sha256(nonce)));
}
