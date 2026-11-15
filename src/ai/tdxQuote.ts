import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { tdReportAt } from './e2ee';
import { INTEL_SGX_ROOT_KEY } from './intelRoot';

/**
 * Checks, on the phone, that a TDX quote was signed by Intel hardware: the part of DCAP
 * quote verification that needs nothing but the quote itself and Intel's root key.
 *
 * The chain, from the key the app trusts (src/ai/intelRoot.ts) down to the quote:
 * 1. Intel's root key signed the "PCK Platform CA" (or "Processor CA") certificate.
 * 2. That certificate's key signed the PCK certificate: one processor's key. It must carry
 *    Intel's SGX extension, which only PCK certificates have.
 * 3. The PCK key signed the report of the quoting enclave (QE), Intel's own enclave that
 *    signs quotes. The report must be Intel's QE (its signer, product and attributes).
 * 4. The QE report names the attestation key: it holds SHA-256(attestation key || QE data).
 * 5. The attestation key signed the quote's header and TD report, where REPORTDATA is.
 *
 * What this does NOT check, and Intel's full procedure does: whether the processor's
 * firmware is up to date (TCB info), whether a certificate was revoked (CRLs), and the
 * QE's version. Those need signed lists fetched from Intel for every check. Nor does it
 * say which software runs in the enclave (the measurements): a real Intel machine that
 * runs other software passes.
 *
 * Layout: Intel TDX DCAP Quoting Library API, "Quote Format" (versions 4 and 5).
 * Certificates: RFC 5280, read only as far as these checks need.
 *
 * The four signatures are checked by the browser's own cryptography (WebCrypto), not by a
 * JavaScript library: on an iPhone a P-256 check in JavaScript takes long enough to feel,
 * and there are four for every message. Without WebCrypto the check fails, as any check
 * that can't be made.
 */

/** The outcome: REPORTDATA (64 bytes) of a quote that passed, or why it did not. */
export type QuoteCheck = { ok: true; reportData: Uint8Array } | { ok: false; why: string };

/** A check that failed, with a reason for the parent area. It holds nothing of hers. */
class Refused extends Error {}
function refuse(why: string): never {
  throw new Refused(why);
}

const HEADER_BYTES = 48;
/** The header's attestation key type (u16 at 2): 2 is ECDSA with P-256, the only one Intel issues today. */
const ECDSA_P256 = 2;
/** A TD report body: 584 bytes (TDX 1.0) or 648 (TDX 1.5, v5 body type 3); a v5 quote has a 6-byte descriptor before it. */
const TD_REPORT_1_0_BYTES = 584;
const REPORT_DATA_IN_BODY = 520;
const REPORT_DATA_BYTES = 64;
const SIGNATURE_BYTES = 64;
const KEY_BYTES = 64;
const QE_REPORT_BYTES = 384;
/** Certification data types: 6 wraps the QE report, 5 is the PCK certificate chain as PEM text. */
const QE_REPORT_CERTIFICATION = 6;
const PCK_CERT_CHAIN = 5;

/*
 * Intel's quoting enclave for TDX ("TD_QE"), as Intel's signed QE identity describes it
 * (the same in June 2025 and October 2026): the signer, the product, MISCSELECT zero, and
 * the attribute flags 0x11 (initialised, may use the provisioning key) under the mask
 * FBFFFFFFFFFFFFFF, so the DEBUG flag (0x02) must be off. An SGX report has MISCSELECT at
 * 16, the attributes at 48, MRSIGNER at 128, the product at 256 and REPORTDATA at 320.
 */
const QE_MRSIGNER = 'dc9e2a7c6f948f17474e34a7fc43ed030f7c1563f1babddf6340c82e0e54a8c5';
const QE_PRODUCT = 2;
const QE_FLAGS = [0x11, 0, 0, 0, 0, 0, 0, 0];
const QE_FLAGS_MASK = [0xfb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Reads forward through a part of the quote; reading past its end fails the check. */
function reader(bytes: Uint8Array) {
  let at = 0;
  const take = (length: number): Uint8Array => {
    if (at + length > bytes.length) refuse('the quote is cut short');
    at += length;
    return bytes.subarray(at - length, at);
  };
  return {
    take,
    u16: (): number => {
      const b = take(2);
      return b[0] | (b[1] << 8);
    },
    u32: (): number => {
      const b = take(4);
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    },
  };
}

/** One DER value: its tag, its content, and the whole of it (tag, length and content). */
interface Der {
  tag: number;
  content: Uint8Array;
  whole: Uint8Array;
}

/** The DER values that fill `bytes` exactly, one after another. Lengths up to 65535, as a certificate needs. */
function derList(bytes: Uint8Array): Der[] {
  const list: Der[] = [];
  let at = 0;
  while (at < bytes.length) {
    const tag = bytes[at];
    const first = bytes[at + 1];
    // A tag number above 30, an indefinite length, or a length of more than two bytes: not in a certificate.
    if ((tag & 0x1f) === 0x1f || first === undefined || first === 0x80 || first > 0x82) refuse('a certificate that could not be read');
    let length = first;
    let header = 2;
    if (first === 0x81) {
      length = bytes[at + 2];
      header = 3;
    } else if (first === 0x82) {
      length = (bytes[at + 2] << 8) | bytes[at + 3];
      header = 4;
    }
    const end = at + header + length;
    if (!(end <= bytes.length)) refuse('a certificate that could not be read');
    list.push({ tag, content: bytes.subarray(at + header, end), whole: bytes.subarray(at, end) });
    at = end;
  }
  return list;
}

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OID = 0x06;
const BOOLEAN = 0x01;
const UTC_TIME = 0x17;
const GENERALIZED_TIME = 0x18;
/** AlgorithmIdentifier: ecdsa-with-SHA256 (1.2.840.10045.4.3.2). */
const ECDSA_WITH_SHA256 = hexToBytes('300a06082a8648ce3d040302');
/** AlgorithmIdentifier: an EC public key (1.2.840.10045.2.1) on P-256 (1.2.840.10045.3.1.7). */
const EC_KEY_ON_P256 = hexToBytes('301306072a8648ce3d020106082a8648ce3d030107');
/** The basicConstraints extension (2.5.29.19), where a certificate says whether it may sign others. */
const BASIC_CONSTRAINTS = hexToBytes('551d13');
/** Intel's SGX extension (1.2.840.113741.1.13.1): only a PCK certificate, a processor's own, has it. */
const SGX_EXTENSION = hexToBytes('2a864886f84d010d01');

/** A certificate's time: UTCTime (two-digit year, 50 and up is 19xx) or GeneralizedTime, both ending in Z. */
function derTime(node: Der | undefined): number {
  const text = node ? String.fromCharCode(...node.content) : '';
  const match = node?.tag === UTC_TIME ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(text) : node?.tag === GENERALIZED_TIME ? /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(text) : null;
  if (!match) refuse('a certificate date that could not be read');
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const fullYear = node?.tag === UTC_TIME ? year + (year >= 50 ? 1900 : 2000) : year;
  return Date.UTC(fullYear, month - 1, day, hour, minute, second);
}

interface Certificate {
  /** The signed part, byte for byte. */
  signed: Uint8Array;
  /** The issuer's signature over it, in DER (see rawSignature). */
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  /** The certificate's own key: an uncompressed P-256 point. */
  key: Uint8Array;
  /** basicConstraints says it may sign other certificates. */
  authority: boolean;
  /** It carries Intel's SGX extension: it is a PCK certificate. */
  processor: boolean;
}

/** Reads an X.509 certificate signed with ECDSA and SHA-256 that holds a P-256 key; anything else fails. */
function certificate(der: Uint8Array): Certificate {
  const outer = derList(der);
  if (outer.length !== 1 || outer[0].tag !== SEQUENCE) refuse('a certificate that could not be read');
  const parts = derList(outer[0].content);
  const [signed, algorithm, signature] = parts;
  if (parts.length !== 3 || signed.tag !== SEQUENCE || !same(algorithm.whole, ECDSA_WITH_SHA256) || signature.tag !== BIT_STRING || signature.content[0] !== 0) {
    refuse('a certificate that is not signed with ECDSA and SHA-256');
  }
  const fields = derList(signed.content);
  // The version, [0], comes first in every certificate that has extensions.
  const from = fields[0]?.tag === 0xa0 ? 1 : 0;
  const [serial, innerAlgorithm, issuer, validity, subject, keyInfo] = fields.slice(from, from + 6);
  if (!keyInfo || serial.tag !== INTEGER || !same(innerAlgorithm.whole, ECDSA_WITH_SHA256) || issuer.tag !== SEQUENCE || validity.tag !== SEQUENCE || subject.tag !== SEQUENCE || keyInfo.tag !== SEQUENCE) {
    refuse('a certificate that could not be read');
  }
  const times = derList(validity.content);
  const [keyAlgorithm, keyBits] = derList(keyInfo.content);
  if (!keyBits || !same(keyAlgorithm.whole, EC_KEY_ON_P256) || keyBits.tag !== BIT_STRING || keyBits.content.length !== 66 || keyBits.content[0] !== 0 || keyBits.content[1] !== 4) {
    refuse('a certificate whose key is not on P-256');
  }
  // Extensions, [3]: a list of (name, maybe "critical", value). basicConstraints holds SEQUENCE { BOOLEAN ca, … }.
  let authority = false;
  let processor = false;
  const extensions = fields.slice(from + 6).find((field) => field.tag === 0xa3);
  for (const extension of extensions ? derList(derList(extensions.content)[0]?.content ?? new Uint8Array()) : []) {
    const inside = derList(extension.content);
    const value = inside[inside.length - 1];
    if (inside[0]?.tag === OID && same(inside[0].content, SGX_EXTENSION)) processor = true;
    if (inside[0]?.tag !== OID || !same(inside[0].content, BASIC_CONSTRAINTS) || value.tag !== OCTET_STRING) continue;
    const flag = derList(derList(value.content)[0]?.content ?? new Uint8Array())[0];
    authority = flag?.tag === BOOLEAN && flag.content.length === 1 && flag.content[0] === 0xff;
  }
  return {
    signed: signed.whole,
    signature: signature.content.subarray(1),
    issuer: issuer.whole,
    subject: subject.whole,
    notBefore: derTime(times[0]),
    notAfter: derTime(times[1]),
    key: keyBits.content.subarray(1),
    authority,
    processor,
  };
}

/** The first two certificates of a PEM chain: the PCK certificate, then the one that signed it. */
function firstTwoCertificates(pem: Uint8Array): Certificate[] {
  const text = new TextDecoder('latin1').decode(pem);
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length < 2) refuse('no certificate chain in the quote');
  return blocks.slice(0, 2).map((block) => {
    const binary = atob(block.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, ''));
    return certificate(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  });
}

/**
 * A certificate's signature as the 64 bytes r || s that WebCrypto takes. In a certificate it
 * is DER: SEQUENCE { INTEGER r, INTEGER s }, each with a zero byte in front when its first
 * bit is set, and without its leading zero bytes otherwise.
 */
function rawSignature(der: Uint8Array): Uint8Array {
  const outer = derList(der);
  const numbers = outer.length === 1 && outer[0].tag === SEQUENCE ? derList(outer[0].content) : [];
  if (numbers.length !== 2) refuse('a certificate signature that could not be read');
  const raw = new Uint8Array(SIGNATURE_BYTES);
  numbers.forEach((value, i) => {
    let digits = value.content;
    while (digits.length > 32 && digits[0] === 0) digits = digits.subarray(1);
    if (value.tag !== INTEGER || digits.length === 0 || digits.length > 32) refuse('a certificate signature that could not be read');
    raw.set(digits, (i + 1) * 32 - digits.length);
  });
  return raw;
}

/** SubjectPublicKeyInfo for a P-256 key, up to the key itself: the form every browser imports. */
const P256_KEY_INFO = hexToBytes('3059301306072a8648ce3d020106082a8648ce3d030107034200');

/**
 * ECDSA over P-256 with SHA-256, by WebCrypto. `key` is 04 || x || y; `signature` is r || s.
 * A signature or a key that can't be read counts as a wrong one.
 */
async function signedBy(key: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const imported = await crypto.subtle.importKey('spki', new Uint8Array([...P256_KEY_INFO, ...key]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, new Uint8Array(signature), new Uint8Array(message))) === true;
  } catch {
    return false;
  }
}

async function checked(quote: Uint8Array, now: number): Promise<Uint8Array> {
  // Said first and in its own words: otherwise the reason would blame the quote for what the phone lacks.
  if (typeof globalThis.crypto?.subtle?.verify !== 'function') refuse('this browser can not check signatures');
  const body = tdReportAt(quote);
  if (body === null) refuse('not a TDX quote of a known version');
  const header = reader(quote.subarray(0, HEADER_BYTES));
  header.take(2);
  if (header.u16() !== ECDSA_P256) refuse('an attestation key that is not ECDSA on P-256');
  // In a v5 quote the body's size is in the descriptor just before it; tdReportAt checked it.
  const bodyBytes = body === HEADER_BYTES ? TD_REPORT_1_0_BYTES : reader(quote.subarray(body - 4, body)).u32();
  const signedEnd = body + bodyBytes;

  // After the signed part: the length of the signature data, then the data. Padding may follow it.
  const rest = reader(quote.subarray(signedEnd));
  const data = reader(rest.take(rest.u32()));
  const quoteSignature = data.take(SIGNATURE_BYTES);
  const attestationKey = data.take(KEY_BYTES);
  if (data.u16() !== QE_REPORT_CERTIFICATION) refuse('no quoting enclave report in the quote');
  const certification = reader(data.take(data.u32()));
  const qeReport = certification.take(QE_REPORT_BYTES);
  const qeSignature = certification.take(SIGNATURE_BYTES);
  const qeData = certification.take(certification.u16());
  if (certification.u16() !== PCK_CERT_CHAIN) refuse('no certificate chain in the quote');
  const [pck, issuer] = firstTwoCertificates(certification.take(certification.u32()));

  // 1. Intel's root signed the issuer, which may sign certificates and is in date.
  if (!(await signedBy(hexToBytes(INTEL_SGX_ROOT_KEY), issuer.signed, rawSignature(issuer.signature)))) refuse("the certificate chain does not lead to Intel's root");
  if (!issuer.authority) refuse('a certificate that may not sign others was used to sign one');
  // 2. The issuer signed the PCK certificate, and it is one: Intel's root signs other things too.
  if (!same(pck.issuer, issuer.subject) || !(await signedBy(issuer.key, pck.signed, rawSignature(pck.signature)))) refuse('the PCK certificate was not signed by the certificate above it');
  if (!pck.processor || pck.authority) refuse('the first certificate is not a PCK certificate');
  for (const cert of [issuer, pck]) {
    if (!(now >= cert.notBefore && now <= cert.notAfter)) refuse('a certificate that is out of date');
  }
  // 3. The PCK key signed the QE report, and the report is Intel's quoting enclave, not in debug mode.
  if (!(await signedBy(pck.key, qeReport, qeSignature))) refuse('the quoting enclave report was not signed by the PCK key');
  const flagsFit = QE_FLAGS.every((flag, i) => (qeReport[48 + i] & QE_FLAGS_MASK[i]) === flag);
  const noMiscSelect = qeReport.subarray(16, 20).every((byte) => byte === 0);
  const product = qeReport[256] | (qeReport[257] << 8);
  if (bytesToHex(qeReport.subarray(128, 160)) !== QE_MRSIGNER || product !== QE_PRODUCT || !flagsFit || !noMiscSelect) refuse("the quoting enclave is not Intel's");
  // 4. The QE report names the attestation key.
  const named = sha256(new Uint8Array([...attestationKey, ...qeData]));
  if (!same(named, qeReport.subarray(320, 352))) refuse('the attestation key is not the one the quoting enclave reported');
  // 5. The attestation key signed the header and the TD report.
  if (!(await signedBy(new Uint8Array([4, ...attestationKey]), quote.subarray(0, signedEnd), quoteSignature))) refuse('the quote was not signed by its attestation key');

  return quote.slice(body + REPORT_DATA_IN_BODY, body + REPORT_DATA_IN_BODY + REPORT_DATA_BYTES);
}

/**
 * Whether Intel hardware signed this TDX quote, at the time `now` (milliseconds, as
 * Date.now() gives). Returns the quote's REPORTDATA, which only then means anything.
 * Anything that can't be read fails: a check that can't be made counts as failed.
 */
export async function checkQuote(quote: Uint8Array, now: number): Promise<QuoteCheck> {
  try {
    return { ok: true, reportData: await checked(quote, now) };
  } catch (err) {
    return { ok: false, why: err instanceof Refused ? err.message : 'the quote could not be read' };
  }
}
