// Currency-aware transaction builder for PBaaS token sends
// Uses utxo-lib smarttxs to create EVAL_RESERVE_OUTPUT scripts

import { VERUS_NETWORK, keyPairFromWIF, isValidAddress } from './keychain';
import type { InsightUTXO } from '@shared/types';
import {
  TransferDestination,
  DEST_PKH,
  toIAddress,
} from 'verus-typescript-primitives';
import { BN } from 'bn.js';

// Ensure BN.prototype.toBuffer exists (bn.js only defines it if Buffer
// is available at init time, which can fail in bundled service workers)
if (typeof BN.prototype.toBuffer !== 'function') {
  (BN.prototype as any).toBuffer = function (endian?: string, length?: number) {
    return this.toArrayLike(Buffer, endian, length);
  };
}

// @ts-ignore — vendor lib
const utxoLib = require('@bitgo/utxo-lib');
const { Transaction, TransactionBuilder } = utxoLib;

type BigNumber = InstanceType<typeof BN>;

const VRSC_SYSTEM_ID = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const MIN_FEE = 10_000; // satoshis
const DUST_THRESHOLD = 1_000;

/**
 * Resolve a currency name to its i-address.
 * If it already looks like an i-address, return as-is.
 */
export function resolveCurrencyId(name: string): string {
  // Reject non-ASCII to prevent homograph attacks
  if (!/^[\x20-\x7E]+$/.test(name)) throw new Error('Invalid currency name: non-ASCII characters');
  if (name === 'VRSC') return VRSC_SYSTEM_ID;
  // Already an i-address — validate with base58check
  if (name.startsWith('i') && name.length >= 30) {
    try {
      utxoLib.address.fromBase58Check(name);
      return name;
    } catch {
      throw new Error('Invalid currency i-address');
    }
  }
  // Try fully qualified name with .vrsc root
  try {
    return toIAddress(name + '.vrsc');
  } catch {
    // Fallback: try without root
    return toIAddress(name);
  }
}

/**
 * Build a signed transaction to send a PBaaS currency (non-VRSC token).
 *
 * @param wif        - Sender's WIF private key
 * @param address    - Sender's R-address
 * @param utxos      - All UTXOs for the sender (from Insight API)
 * @param toAddress  - Recipient R-address
 * @param currencyId - Currency i-address (e.g., i7ekXxHYzXW7uAfu5BtWZhd1MjXcWU5Rn3 for "bitcoins")
 * @param amountSat  - Amount to send in satoshis of the token
 * @returns Raw transaction hex
 */
export function buildCurrencyTransaction(
  wif: string,
  address: string,
  utxos: InsightUTXO[],
  toAddress: string,
  currencyId: string,
  amountSat: number,
): string {
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0) {
    throw new Error('Invalid amount: must be a positive safe integer');
  }
  if (!isValidAddress(toAddress)) {
    throw new Error('Invalid recipient address');
  }
  if (!isValidAddress(address)) {
    throw new Error('Invalid sender address');
  }

  const keyPair = keyPairFromWIF(wif);
  const senderPkh: Buffer = utxoLib.address.fromBase58Check(address).hash;
  const recipientPkh: Buffer = utxoLib.address.fromBase58Check(toAddress).hash;

  // --- 1. Decode all UTXOs to find CC UTXOs with the target currency ---
  type DecodedUTXO = {
    utxo: InsightUTXO;
    scriptBuf: Buffer;
    currencyAmount: BigNumber; // amount of target currency in this UTXO
    vrscAmount: number; // native VRSC satoshis
  };

  const ccUtxos: DecodedUTXO[] = [];
  const p2pkhUtxos: InsightUTXO[] = [];

  for (const utxo of utxos) {
    const scriptBuf = Buffer.from(utxo.scriptPubKey, 'hex');

    try {
      const decoded = utxoLib.smarttxs.unpackOutput(
        { value: utxo.satoshis, script: scriptBuf },
        VRSC_SYSTEM_ID,
        true, // isInput
      );

      // Check if this UTXO contains the target currency
      const targetVal: BigNumber | undefined = decoded.values[currencyId];
      if (targetVal && !targetVal.isZero()) {
        ccUtxos.push({
          utxo,
          scriptBuf,
          currencyAmount: targetVal,
          vrscAmount: utxo.satoshis,
        });
      } else if (decoded.type === 'pubkeyhash' && utxo.satoshis > 0) {
        // Plain P2PKH UTXO with VRSC
        p2pkhUtxos.push(utxo);
      }
    } catch {
      // P2PKH or other standard output
      if (utxo.satoshis > 0) {
        p2pkhUtxos.push(utxo);
      }
    }
  }

  // --- 2. Select CC UTXOs with enough of the target currency ---
  const targetAmount = new BN(amountSat);
  const selectedCC: DecodedUTXO[] = [];
  let totalCurrency = new BN(0);

  // Sort CC UTXOs largest first
  ccUtxos.sort((a, b) => (b.currencyAmount.gt(a.currencyAmount) ? 1 : -1));

  for (const cc of ccUtxos) {
    selectedCC.push(cc);
    totalCurrency = totalCurrency.add(cc.currencyAmount);
    if (totalCurrency.gte(targetAmount)) break;
  }

  if (totalCurrency.lt(targetAmount)) {
    throw new Error(
      `Insufficient ${currencyId} balance: have ${totalCurrency.toString()} sat, need ${amountSat} sat`,
    );
  }

  // --- 3. Select P2PKH UTXO(s) for VRSC mining fee ---
  p2pkhUtxos.sort((a, b) => b.satoshis - a.satoshis);
  const selectedP2PKH: InsightUTXO[] = [];
  let totalVrsc = 0;

  // CC UTXOs may contribute some VRSC too
  for (const cc of selectedCC) {
    totalVrsc += cc.vrscAmount;
  }

  if (totalVrsc < MIN_FEE) {
    for (const utxo of p2pkhUtxos) {
      selectedP2PKH.push(utxo);
      totalVrsc += utxo.satoshis;
      if (totalVrsc >= MIN_FEE) break;
    }
  }

  if (totalVrsc < MIN_FEE) {
    throw new Error(`Insufficient VRSC for mining fee: have ${totalVrsc} sat, need ${MIN_FEE} sat`);
  }

  // --- 4. Build recipient CC output via createUnfundedCurrencyTransfer ---
  const recipientDest = new TransferDestination({
    type: DEST_PKH,
    destination_bytes: recipientPkh,
  });

  const recipientOutputs = [{
    currency: currencyId,
    satoshis: amountSat.toString(),
    address: recipientDest,
  }];

  const unfundedRecipientHex = utxoLib.smarttxs.createUnfundedCurrencyTransfer(
    VRSC_SYSTEM_ID,
    recipientOutputs,
    VERUS_NETWORK,
  );
  const unfundedRecipientTx = Transaction.fromHex(unfundedRecipientHex, VERUS_NETWORK);

  // --- 5. Build currency change output if needed ---
  const currencyChange = totalCurrency.sub(targetAmount);
  let unfundedChangeTx: any = null;

  if (!currencyChange.isZero()) {
    const changeDest = new TransferDestination({
      type: DEST_PKH,
      destination_bytes: senderPkh,
    });

    const changeOutputs = [{
      currency: currencyId,
      satoshis: currencyChange.toString(),
      address: changeDest,
    }];

    const unfundedChangeHex = utxoLib.smarttxs.createUnfundedCurrencyTransfer(
      VRSC_SYSTEM_ID,
      changeOutputs,
      VERUS_NETWORK,
    );
    unfundedChangeTx = Transaction.fromHex(unfundedChangeHex, VERUS_NETWORK);
  }

  // --- 6. Build the actual funded transaction ---
  const txb = new TransactionBuilder(VERUS_NETWORK);
  txb.setVersion(4);
  txb.setVersionGroupId(0x892f2085);
  txb.setExpiryHeight(0);

  // Add CC inputs with their actual scriptPubKey as prevOutScript
  for (const cc of selectedCC) {
    txb.addInput(cc.utxo.txid, cc.utxo.vout, Transaction.DEFAULT_SEQUENCE, cc.scriptBuf);
  }

  // Add P2PKH inputs
  const senderSpk = utxoLib.address.toOutputScript(address, VERUS_NETWORK);
  for (const utxo of selectedP2PKH) {
    txb.addInput(utxo.txid, utxo.vout, Transaction.DEFAULT_SEQUENCE, senderSpk);
  }

  // Add recipient output(s) from unfunded tx
  for (const out of unfundedRecipientTx.outs) {
    txb.addOutput(out.script, out.value);
  }

  // Add currency change output if needed
  if (unfundedChangeTx) {
    for (const out of unfundedChangeTx.outs) {
      txb.addOutput(out.script, out.value);
    }
  }

  // Add VRSC change as P2PKH output
  const vrscChange = totalVrsc - MIN_FEE;
  if (vrscChange > DUST_THRESHOLD) {
    txb.addOutput(address, vrscChange);
  }

  // --- 7. Sign all inputs ---
  const hashType = Transaction.SIGHASH_ALL;
  let inputIndex = 0;

  // Sign CC inputs (value = satoshis from the UTXO)
  for (const cc of selectedCC) {
    txb.sign(inputIndex, keyPair, null, hashType, cc.vrscAmount);
    inputIndex++;
  }

  // Sign P2PKH inputs
  for (const utxo of selectedP2PKH) {
    txb.sign(inputIndex, keyPair, null, hashType, utxo.satoshis);
    inputIndex++;
  }

  const tx = txb.build();

  // Zero private key material after signing
  try { keyPair.getPrivateKeyBuffer().fill(0); } catch (e) {
    console.warn('Failed to zero key after signing:', e);
  }

  return tx.toHex();
}
