import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * A stand-in for Intel, its processor and its quoting enclave: makes signed TDX quotes that
 * lead back to a test root key instead of Intel's. Written from the formats (Intel's TDX DCAP
 * quote format, RFC 5280 for the certificates), not from src/ai/tdxQuote.ts, so a mistake
 * there can't hide behind the same mistake here. Every part can be made wrong, one at a time.
 */

const secret = (fill: number) => new Uint8Array(32).fill(fill);
const publicOf = (key: Uint8Array) => p256.getPublicKey(key, false);

/** The test root: tests put its public key where Intel's is (vi.mock of src/ai/intelRoot.ts). */
export const TEST_ROOT_SECRET = secret(0x11);
export const TEST_ROOT_KEY = bytesToHex(publicOf(TEST_ROOT_SECRET));
const ISSUER_SECRET = secret(0x22);
const PCK_SECRET = secret(0x33);
const ATTESTATION_SECRET = secret(0x44);
/** A key that is nobody's in the chain: what a forger would have. */
export const STRANGER_SECRET = secret(0x55);

/** When the test certificates are valid, and a moment inside that. */
export const VALID_FROM = Date.UTC(2025, 0, 1);
export const VALID_TO = Date.UTC(2035, 0, 1);
export const NOW = Date.UTC(2026, 10, 15);

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

/** One DER value: tag, length (short, or 0x81/0x82 and one or two bytes), content. */
export function der(tag: number, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const content = concat(parts);
  const size = content.length;
  const length = size < 0x80 ? [size] : size < 0x100 ? [0x81, size] : [0x82, size >> 8, size & 0xff];
  return concat([[tag], length, content]);
}
const sequence = (...parts: Uint8Array[]) => der(0x30, ...parts);
const oid = (hex: string) => der(0x06, hexToBytes(hex));
/** A name with one part, the common name (2.5.4.3). */
const name = (commonName: string) => sequence(der(0x31, sequence(oid('550403'), der(0x0c, new TextEncoder().encode(commonName)))));
const two = (value: number) => String(value).padStart(2, '0');
function time(ms: number, generalized: boolean): Uint8Array {
  const date = new Date(ms);
  const rest = `${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return generalized ? der(0x18, ascii(`${date.getUTCFullYear()}${rest}`)) : der(0x17, ascii(`${two(date.getUTCFullYear() % 100)}${rest}`));
}

/** ecdsa-with-SHA256, and for a certificate that must be refused, ecdsa-with-SHA384. */
export const ECDSA_SHA256 = sequence(oid('2a8648ce3d040302'));
export const ECDSA_SHA384 = sequence(oid('2a8648ce3d040303'));
/** An EC key on P-256, and for a certificate that must be refused, on P-384. */
export const KEY_ON_P256 = sequence(oid('2a8648ce3d0201'), oid('2a8648ce3d030107'));
export const KEY_ON_P384 = sequence(oid('2a8648ce3d0201'), oid('2b81040022'));

export interface CertOptions {
  subject: string;
  issuer: string;
  /** The certificate's own secret key; its public key goes in the certificate. */
  secret: Uint8Array;
  /** The secret key that signs the certificate. */
  signer: Uint8Array;
  notBefore?: number;
  notAfter?: number;
  /**
   * basicConstraints: true says "may sign certificates", false leaves the flag out (DER's way
   * to say no), 'written false' writes it as FALSE, 'none' leaves the whole extension out.
   */
  authority?: boolean | 'written false' | 'none';
  /** Intel's SGX extension (1.2.840.113741.1.13.1), which a PCK certificate carries. */
  sgxExtension?: boolean;
  /** Dates as GeneralizedTime (four-digit year) instead of UTCTime. */
  generalizedTime?: boolean;
  algorithm?: Uint8Array;
  keyAlgorithm?: Uint8Array;
  /** Leaves out the version and the extensions, as an X.509 v1 certificate has it. */
  v1?: boolean;
  /** Changes the signed part before it is signed. */
  signedPart?: (fields: Uint8Array[]) => Uint8Array[];
}

/** An X.509 certificate in DER, signed with ECDSA P-256 and SHA-256. */
export function certificate(options: CertOptions): Uint8Array {
  const algorithm = options.algorithm ?? ECDSA_SHA256;
  const generalized = options.generalizedTime === true;
  const authority = options.authority ?? false;
  const extensions: Uint8Array[] = [
    // keyUsage (2.5.29.15), critical: an extension the check has no use for, before the one it reads.
    sequence(oid('551d0f'), der(0x01, [0xff]), der(0x04, der(0x03, [1, 0x06]))),
    // Intel's SGX extension holds a list of the processor's values; an empty list stands in for it.
    ...(options.sgxExtension ? [sequence(oid('2a864886f84d010d01'), der(0x04, sequence()))] : []),
    ...(authority === 'none' ? [] : [sequence(oid('551d13'), der(0x01, [0xff]), der(0x04, sequence(...(authority === true ? [der(0x01, [0xff])] : authority === 'written false' ? [der(0x01, [0x00])] : []))))]),
  ];
  let fields: Uint8Array[] = [
    ...(options.v1 ? [] : [der(0xa0, der(0x02, [2]))]),
    der(0x02, [0x01, 0x23]),
    algorithm,
    name(options.issuer),
    sequence(time(options.notBefore ?? VALID_FROM, generalized), time(options.notAfter ?? VALID_TO, generalized)),
    name(options.subject),
    sequence(options.keyAlgorithm ?? KEY_ON_P256, der(0x03, [0], publicOf(options.secret))),
    ...(options.v1 ? [] : [der(0xa3, sequence(...extensions))]),
  ];
  if (options.signedPart) fields = options.signedPart(fields);
  const signed = sequence(...fields);
  const signature = p256.sign(signed, options.signer, { format: 'der', lowS: false });
  return sequence(signed, algorithm, der(0x03, [0], signature));
}

/** A certificate as PEM text: base64 in lines of 64, between the BEGIN and END lines. */
export function pem(certDer: Uint8Array): string {
  const lines = btoa(String.fromCharCode(...certDer)).match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** Intel's quoting enclave for TDX, as its signed identity names it. */
export const INTEL_QE_SIGNER = 'dc9e2a7c6f948f17474e34a7fc43ed030f7c1563f1babddf6340c82e0e54a8c5';

export interface QuoteOptions {
  /** REPORTDATA: the 64 bytes the enclave chose. */
  reportData?: Uint8Array;
  debug?: boolean;
  version?: 4 | 5;
  /** For version 5: 2 is a TD report 1.0, 3 a TD report 1.5. */
  bodyType?: 2 | 3;
  /** The header's attestation key type; 2 is ECDSA on P-256. */
  keyType?: number;
  /** Who signs the issuer certificate (the root, unless a test says otherwise). */
  rootSecret?: Uint8Array;
  issuer?: Partial<CertOptions>;
  pck?: Partial<CertOptions>;
  /** The PEM blocks, in the quote's order: PCK certificate, its issuer, the root. */
  chain?: (blocks: string[]) => string[];
  /** Who signs the quoting enclave's report (the PCK key, unless a test says otherwise). */
  qeSigner?: Uint8Array;
  qeMrSigner?: string;
  qeProduct?: number;
  /** The first byte of the QE's attribute flags: 0x15 as real quotes have it (0x02 would be DEBUG). */
  qeFlags?: number;
  qeMiscSelect?: number;
  /** What the QE report says it vouches for, instead of SHA-256(attestation key || QE data). */
  qeReportData?: Uint8Array;
  /** Who signs the header and the TD report (the attestation key, unless a test says otherwise). */
  quoteSigner?: Uint8Array;
  outerType?: number;
  innerType?: number;
  /** Bytes after the signature data, as real quotes have. */
  padding?: number;
  /** Changes the header and TD report after they were signed. */
  afterSigning?: (signed: Uint8Array) => void;
}

const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];

/**
 * A TDX quote with its whole signature chain:
 * header (48) | [v5: body type u16, size u32] | TD report (584 or 648) | length u32 |
 *   quote signature (64) | attestation key (64) | type 6, size | QE report (384) |
 *   QE report signature (64) | QE data size u16, QE data | type 5, size | PEM chain | padding
 */
export function signedQuote(options: QuoteOptions = {}): Uint8Array {
  const version = options.version ?? 4;
  const bodyType = options.bodyType ?? 2;
  const reportBytes = version === 5 && bodyType === 3 ? 648 : 584;
  const header = new Uint8Array(48);
  header.set(u16(version), 0);
  header.set(u16(options.keyType ?? 2), 2);
  header.set(u32(0x81), 4);
  const report = new Uint8Array(reportBytes).fill(0xee);
  report.set([options.debug ? 0x01 : 0x00, 0, 0, 0x10, 0, 0, 0, 0], 120);
  report.set(options.reportData ?? new Uint8Array(64).fill(0xab), 520);
  const signed = concat([header, version === 5 ? [...u16(bodyType), ...u32(reportBytes)] : [], report]);

  const issuerCert = certificate({ subject: 'Test PCK Platform CA', issuer: 'Test Root CA', secret: ISSUER_SECRET, signer: options.rootSecret ?? TEST_ROOT_SECRET, authority: true, ...options.issuer });
  const pckCert = certificate({ subject: 'Test PCK Certificate', issuer: 'Test PCK Platform CA', secret: PCK_SECRET, signer: ISSUER_SECRET, sgxExtension: true, ...options.pck });
  const rootCert = certificate({ subject: 'Test Root CA', issuer: 'Test Root CA', secret: TEST_ROOT_SECRET, signer: TEST_ROOT_SECRET, authority: true });
  const blocks = [pem(pckCert), pem(issuerCert), pem(rootCert)];
  // Real quotes end the chain with a zero byte.
  const chain = concat([ascii((options.chain ? options.chain(blocks) : blocks).join('')), [0]]);

  const attestationKey = publicOf(ATTESTATION_SECRET).slice(1);
  const qeData = new Uint8Array(32).fill(0x07);
  const qeReport = new Uint8Array(384);
  qeReport.set(u32(options.qeMiscSelect ?? 0), 16);
  qeReport.set([options.qeFlags ?? 0x15, 0, 0, 0, 0, 0, 0, 0, 0xe7, 0, 0, 0, 0, 0, 0, 0], 48);
  qeReport.set(hexToBytes(options.qeMrSigner ?? INTEL_QE_SIGNER), 128);
  qeReport.set(u16(options.qeProduct ?? 2), 256);
  qeReport.set(u16(8), 258);
  qeReport.set(options.qeReportData ?? sha256(concat([attestationKey, qeData])), 320);
  const qeSignature = p256.sign(qeReport, options.qeSigner ?? PCK_SECRET, { lowS: false });

  const quoteSignature = p256.sign(signed, options.quoteSigner ?? ATTESTATION_SECRET, { lowS: false });
  options.afterSigning?.(signed);

  const certification = concat([qeReport, qeSignature, u16(qeData.length), qeData, u16(options.innerType ?? 5), u32(chain.length), chain]);
  const data = concat([quoteSignature, attestationKey, u16(options.outerType ?? 6), u32(certification.length), certification]);
  return concat([signed, u32(data.length), data, new Uint8Array(options.padding ?? 0)]);
}

/**
 * REPORTDATA as Venice's attestation fills it: the model key's Ethereum address (the last 20
 * bytes of Keccak-256 over the key's x and y), 12 zero bytes, then the 32-byte nonce, as it
 * is or as its SHA-256.
 */
export function reportDataFor(modelKeyHex: string, nonceHex: string, hashedNonce = false): Uint8Array {
  const address = keccak_256(hexToBytes(modelKeyHex).slice(1)).slice(12);
  const nonce = hexToBytes(nonceHex);
  return concat([address, new Uint8Array(12), hashedNonce ? sha256(nonce) : nonce]);
}
