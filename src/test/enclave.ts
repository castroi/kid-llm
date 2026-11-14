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

/**
 * A TDX quote laid out as Intel's DCAP quote format has it, as long as the debug check reads:
 * a 48-byte header (version u16 at 0, TEE type u32 at 4), then for version 5 a 6-byte body
 * descriptor (type u16, size u32), then the TD report body, whose TD attributes are 120 bytes
 * in. Written from the format, not from src/ai/e2ee.ts.
 */
export function fakeQuote({ debug = false, version = 4, teeType = 0x81, bodyType = 2, bodySize, cut = 0 }: { debug?: boolean; version?: number; teeType?: number; bodyType?: number; bodySize?: number; cut?: number } = {}): Uint8Array {
  const reportBytes = bodyType === 3 ? 648 : 584;
  const bodyAt = version === 5 ? 54 : 48;
  const quote = new Uint8Array(bodyAt + reportBytes - cut);
  const view = new DataView(quote.buffer);
  view.setUint16(0, version, true);
  view.setUint32(4, teeType, true);
  if (version === 5) {
    view.setUint16(48, bodyType, true);
    view.setUint32(50, bodySize ?? reportBytes, true);
  }
  // A body full of ones everywhere else, so a check that reads the wrong byte sees a debug bit.
  quote.fill(0xff, bodyAt, quote.length);
  if (bodyAt + 120 < quote.length) quote[bodyAt + 120] = debug ? 0x01 : 0x00;
  return quote;
}
export const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
