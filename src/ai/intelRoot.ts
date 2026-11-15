/**
 * The public key of the "Intel SGX Root CA" certificate: the one key every TDX quote must
 * lead back to (src/ai/tdxQuote.ts). An uncompressed P-256 point, 04 || x || y, in hex.
 *
 * The certificate is valid from 2018-05-21 to 2049-12-31; its SHA-256 fingerprint is
 * 44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3. Intel publishes it at
 * https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.cer
 * The key here was read from two copies that agree: the one Google ships in go-tdx-guest
 * (verify/trusted_root.pem) and the one Phala ships in dcap-qvl (src/TrustedRootCA.der).
 *
 * It lives in a file of its own so that nothing but this line decides whom the app trusts.
 */
export const INTEL_SGX_ROOT_KEY = '040ba9c4c0c0c86193a3fe23d6b02cda10a8bbd4e88e48b4458561a36e705525f567918e2edc88e40d860bd0cc4ee26aacc988e505a953558c453f6b0904ae7394';
