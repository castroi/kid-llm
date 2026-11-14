import { gcm } from '@noble/ciphers/aes.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * Venice's end-to-end encryption, as its guide describes it: her messages are encrypted on
 * the phone to a key that only the model's enclave (TEE) holds, and the answer comes back
 * encrypted to a key that only this call holds. Venice relays ciphertext only.
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
  const shared = secp256k1.getSharedSecret(secretKey, publicKey, true).slice(1, 33);
  const key = hkdf(sha256, shared, undefined, HKDF_INFO, 32);
  shared.fill(0);
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
 * The Intel TDX quote, only as far as the debug check needs it. Layout from Intel's TDX DCAP
 * quote format (v4/v5): a 48-byte header (TEE type 0x81 at offset 4), then the TD report body,
 * whose TD attributes sit 120 bytes in; bit 0 of their first byte is DEBUG.
 */
const QUOTE_HEADER_BYTES = 48;
const TDX_TEE_TYPE = 0x81;
const TD_ATTRIBUTES_AT = QUOTE_HEADER_BYTES + 120;
/** Header plus the whole 584-byte TD report body. */
const MIN_QUOTE_BYTES = QUOTE_HEADER_BYTES + 584;
const MAX_QUOTE_CHARS = 64 * 1024;

function quoteBytes(quote: string): Uint8Array | null {
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
 * This reads the quote only; it does not check the quote's signature (CLAUDE.md, the E2EE row).
 */
export function quoteIsNotDebug(quote: unknown): boolean {
  if (typeof quote !== 'string') return false;
  const bytes = quoteBytes(quote);
  if (!bytes || bytes.length < MIN_QUOTE_BYTES) return false;
  const teeType = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  if (teeType !== TDX_TEE_TYPE) return false;
  return (bytes[TD_ATTRIBUTES_AT] & 0x01) === 0;
}
