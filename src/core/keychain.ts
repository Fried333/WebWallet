// Keychain: BIP39 mnemonic generation + BIP32/BIP44 key derivation for Verus
// Uses @scure libraries (pure JS, browser-safe) + @bitgo/utxo-lib for address encoding

export {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeedSync,
  mnemonicToEntropy,
  entropyToMnemonic,
} from '@scure/bip39';
export { wordlist } from '@scure/bip39/wordlists/english';

// @ts-nocheck — vendor libs don't have TS declarations
const utxoLib = require('@bitgo/utxo-lib');

// Verus uses coin type 141 (registered in SLIP-0044)
export const VERUS_COIN_TYPE = 141;
export const VERUS_DERIVATION_PATH = "m/44'/141'/0'/0";
export const VERUS_NETWORK = utxoLib.networks.verus;

/**
 * Derive a keypair from a pre-computed BIP39 seed buffer (avoids mnemonic→seed PBKDF2).
 */
export function deriveKeyFromSeed(seed: Buffer, index = 0): { address: string; wif: string } {
  const root = utxoLib.HDNode.fromSeedBuffer(seed, VERUS_NETWORK);
  const child = root.derivePath(`${VERUS_DERIVATION_PATH}/${index}`);
  const result = {
    address: child.getAddress() as string,
    wif: child.keyPair.toWIF() as string,
  };
  // Zero intermediate HD key material
  try { child.keyPair.getPrivateKeyBuffer().fill(0); } catch (e) {
    console.warn('Failed to zero child key:', e);
  }
  try { root.keyPair.getPrivateKeyBuffer().fill(0); } catch (e) {
    console.warn('Failed to zero root key:', e);
  }
  return result;
}

/**
 * Reconstruct an ECPair from a WIF string.
 */
export function keyPairFromWIF(wif: string) {
  return utxoLib.ECPair.fromWIF(wif, VERUS_NETWORK);
}

/**
 * Validate a Verus address (base58check with correct version byte).
 */
export function isValidAddress(address: string): boolean {
  try {
    // Reject non-ASCII to prevent base58 homograph attacks (Unicode lookalikes)
    if (!/^[\x20-\x7E]+$/.test(address)) return false;
    const decoded = utxoLib.address.fromBase58Check(address);
    return (
      decoded.version === VERUS_NETWORK.pubKeyHash ||
      decoded.version === VERUS_NETWORK.scriptHash
    );
  } catch {
    return false;
  }
}

/**
 * Convert a Verus address to an Electrum scripthash.
 * Electrum protocol 1.4 requires:
 *   1. Decode base58check → version + 20-byte hash
 *   2. Build output script (P2PKH or P2SH)
 *   3. SHA256(output_script)
 *   4. Byte-reverse the 32-byte hash
 *   5. Hex-encode
 */
export function addressToScripthash(address: string): string {
  const outputScript: Buffer = utxoLib.address.toOutputScript(address, VERUS_NETWORK);
  const hash: Buffer = utxoLib.crypto.sha256(outputScript);
  // Byte-reverse
  const reversed = Buffer.from(hash);
  reversed.reverse();
  return reversed.toString('hex');
}

/**
 * Build the P2PKH scriptPubKey for a given WIF (needed for tx input signing).
 */
export function scriptPubKeyFromWIF(wif: string): Buffer {
  const kp = keyPairFromWIF(wif);
  const pk = utxoLib.crypto.hash160(kp.getPublicKeyBuffer());
  const script = utxoLib.script.pubKeyHash.output.encode(pk);
  // Zero private key material
  try { kp.getPrivateKeyBuffer().fill(0); } catch (e) {
    console.warn('Failed to zero key in scriptPubKeyFromWIF:', e);
  }
  return script;
}
