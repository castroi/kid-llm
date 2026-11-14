import { gcm } from '@noble/ciphers/aes.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * The enclave's side, written straight from the steps in Venice's guide (not from e2ee.ts),
 * so a mistake in e2ee.ts can't hide behind the same mistake here.
 */
const INFO = new TextEncoder().encode('ecdsa_encryption');
function enclaveKey(secret: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return hkdf(sha256, secp256k1.getSharedSecret(secret, publicKey).slice(1, 33), undefined, INFO, 32);
}
export function enclaveDecrypt(enclaveSecret: Uint8Array, hex: string): string {
  const raw = hexToBytes(hex);
  return new TextDecoder().decode(gcm(enclaveKey(enclaveSecret, raw.slice(0, 65)), raw.slice(65, 77)).decrypt(raw.slice(77)));
}
export function enclaveEncrypt(clientPublicHex: string, text: string): string {
  const ephemeral = secp256k1.utils.randomSecretKey();
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = gcm(enclaveKey(ephemeral, hexToBytes(clientPublicHex)), nonce).encrypt(new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array([...secp256k1.getPublicKey(ephemeral, false), ...nonce, ...sealed]));
}

/** A TDX quote just long enough to read: TEE type 0x81 at offset 4, the DEBUG bit at offset 168. */
export function fakeQuote({ debug = false, teeType = 0x81, length = 632 } = {}): Uint8Array {
  const quote = new Uint8Array(length);
  quote[0] = 4;
  quote[4] = teeType;
  if (debug) quote[168] = 0x01;
  return quote;
}
export const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
