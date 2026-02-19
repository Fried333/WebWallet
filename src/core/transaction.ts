// Transaction building and signing for Verus (P2PKH)
// Uses @bitgo/utxo-lib VerusCoin fork

import type { UTXO, FeeEstimate, TransactionSimulation } from '@shared/types';
import { keyPairFromWIF, scriptPubKeyFromWIF, isValidAddress, VERUS_NETWORK } from './keychain';
import { listUnspent, estimateFee as fetchFeeRate } from './electrum';

// @ts-nocheck — vendor libs
const utxoLib = require('@bitgo/utxo-lib');
const { Transaction, TransactionBuilder } = utxoLib;

const DUST_THRESHOLD = 1000; // satoshis
const MIN_FEE = 10_000;     // minimum fee: 10000 sat

// Estimate tx size: ~148 bytes per input + ~34 per output + 10 overhead
function estimateTxSize(inputCount: number, outputCount: number): number {
  return inputCount * 148 + outputCount * 34 + 10;
}

/**
 * Select UTXOs largest-first until target amount is covered.
 */
function selectUTXOs(utxos: UTXO[], targetSat: number): { selected: UTXO[]; total: number } {
  // Sort largest first
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const selected: UTXO[] = [];
  let total = 0;

  for (const u of sorted) {
    selected.push(u);
    total += u.value;
    if (total >= targetSat) break;
  }

  if (total < targetSat) {
    throw new Error(`Insufficient funds: have ${total} sat, need ${targetSat} sat`);
  }

  return { selected, total };
}

/**
 * Estimate the fee for sending `amountSat` to an address.
 */
export async function estimateTransactionFee(
  scripthash: string,
  amountSat: number,
): Promise<FeeEstimate> {
  const [utxos, feeRate] = await Promise.all([
    listUnspent(scripthash),
    fetchFeeRate(),
  ]);

  // Estimate with 2 outputs (recipient + change)
  const outputCount = 2;
  // Try to figure out how many inputs we'd need
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  let inputCount = 0;
  let total = 0;
  for (const u of sorted) {
    inputCount++;
    total += u.value;
    const size = estimateTxSize(inputCount, outputCount);
    const fee = Math.max(Math.round(size * feeRate / 1000), MIN_FEE);
    if (total >= amountSat + fee) break;
  }

  const size = estimateTxSize(inputCount, outputCount);
  const estimatedFee = Math.max(Math.round(size * feeRate / 1000), MIN_FEE);

  return {
    feeRate,
    estimatedFee,
    inputCount,
    outputCount,
  };
}

/**
 * Simulate a transaction without signing or broadcasting.
 * Validates UTXOs, fee calculation, and returns a detailed breakdown.
 */
export async function simulateTransaction(
  scripthash: string,
  toAddress: string,
  amountSat: number,
  totalBalanceSat: number,
): Promise<TransactionSimulation> {
  const warnings: string[] = [];

  if (!Number.isSafeInteger(amountSat) || amountSat <= 0) {
    return { valid: false, amountSat, feeSat: 0, changeSat: 0, inputCount: 0, outputCount: 0, totalInputSat: 0, balanceAfterSat: totalBalanceSat, warnings: ['Invalid amount'] };
  }
  if (!isValidAddress(toAddress)) {
    return { valid: false, amountSat, feeSat: 0, changeSat: 0, inputCount: 0, outputCount: 0, totalInputSat: 0, balanceAfterSat: totalBalanceSat, warnings: ['Invalid recipient address'] };
  }

  const [utxos, feeRate] = await Promise.all([
    listUnspent(scripthash),
    fetchFeeRate(),
  ]);

  if (utxos.length === 0) {
    return { valid: false, amountSat, feeSat: 0, changeSat: 0, inputCount: 0, outputCount: 0, totalInputSat: 0, balanceAfterSat: totalBalanceSat, warnings: ['No UTXOs available'] };
  }

  // Iterative fee calculation (same logic as buildTransaction)
  const outputCount = 2;
  let fee = MIN_FEE;
  let selected: UTXO[];
  let total: number;

  try {
    ({ selected, total } = selectUTXOs(utxos, amountSat + fee));
    for (let i = 0; i < 5; i++) {
      const size = estimateTxSize(selected.length, outputCount);
      const newFee = Math.max(Math.round(size * feeRate / 1000), MIN_FEE);
      if (newFee <= fee) break;
      fee = newFee;
      ({ selected, total } = selectUTXOs(utxos, amountSat + fee));
    }
  } catch {
    return { valid: false, amountSat, feeSat: fee, changeSat: 0, inputCount: 0, outputCount: 0, totalInputSat: 0, balanceAfterSat: totalBalanceSat, warnings: ['Insufficient funds'] };
  }

  const change = total - amountSat - fee;
  if (change < 0) {
    return { valid: false, amountSat, feeSat: fee, changeSat: 0, inputCount: selected.length, outputCount, totalInputSat: total, balanceAfterSat: totalBalanceSat, warnings: ['Insufficient funds after fee'] };
  }

  const actualOutputCount = change > DUST_THRESHOLD ? 2 : 1;
  const effectiveFee = change > DUST_THRESHOLD ? fee : fee + change;

  // Generate warnings
  if (effectiveFee > amountSat * 0.1 && amountSat > 0) {
    warnings.push(`High fee: ${(effectiveFee / 1e8).toFixed(8)} VRSC (${((effectiveFee / amountSat) * 100).toFixed(1)}% of amount)`);
  }
  if (change > 0 && change <= DUST_THRESHOLD) {
    warnings.push(`Dust change (${change} sat) will be added to fee`);
  }
  if (amountSat === totalBalanceSat) {
    warnings.push('Sending entire balance — no funds will remain');
  }

  const balanceAfter = totalBalanceSat - amountSat - effectiveFee;

  return {
    valid: true,
    amountSat,
    feeSat: effectiveFee,
    changeSat: change > DUST_THRESHOLD ? change : 0,
    inputCount: selected.length,
    outputCount: actualOutputCount,
    totalInputSat: total,
    balanceAfterSat: Math.max(0, balanceAfter),
    warnings,
  };
}

/**
 * Build, sign, and return the raw hex of a Verus P2PKH transaction.
 */
export async function buildTransaction(
  wif: string,
  scripthash: string,
  toAddress: string,
  amountSat: number,
): Promise<string> {
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0) {
    throw new Error('Invalid amount: must be a positive safe integer');
  }
  if (!isValidAddress(toAddress)) {
    throw new Error('Invalid recipient address');
  }

  const [utxos, feeRate] = await Promise.all([
    listUnspent(scripthash),
    fetchFeeRate(),
  ]);

  if (utxos.length === 0) {
    throw new Error('No UTXOs available');
  }

  // Iterative fee calculation: select UTXOs, compute fee, re-select if needed
  const outputCount = 2;
  let fee = MIN_FEE;
  let { selected, total } = selectUTXOs(utxos, amountSat + fee);

  for (let i = 0; i < 5; i++) {
    const size = estimateTxSize(selected.length, outputCount);
    const newFee = Math.max(Math.round(size * feeRate / 1000), MIN_FEE);
    if (newFee <= fee) break;
    fee = newFee;
    ({ selected, total } = selectUTXOs(utxos, amountSat + fee));
  }

  const change = total - amountSat - fee;
  if (change < 0) {
    throw new Error(`Insufficient funds after fee: have ${total}, need ${amountSat + fee}`);
  }

  // Build the transaction
  const keyPair = keyPairFromWIF(wif);
  const spk = scriptPubKeyFromWIF(wif);
  const senderAddress = keyPair.getAddress();

  const txb = new TransactionBuilder(VERUS_NETWORK);
  txb.setVersion(4); // Sapling v4
  txb.setVersionGroupId(0x892f2085);
  txb.setExpiryHeight(0);

  // Add inputs
  for (const utxo of selected) {
    txb.addInput(utxo.tx_hash, utxo.tx_pos, Transaction.DEFAULT_SEQUENCE, spk);
  }

  // Add recipient output
  txb.addOutput(toAddress, amountSat);

  // Add change output if above dust
  if (change > DUST_THRESHOLD) {
    txb.addOutput(senderAddress, change);
  } else {
    // Change too small, donate to fee
    fee += change;
  }

  // Sign all inputs
  const hashType = Transaction.SIGHASH_ALL;
  for (let i = 0; i < selected.length; i++) {
    txb.sign(i, keyPair, null, hashType, selected[i].value);
  }

  const tx = txb.build();

  // Post-build verification: decode outputs from the signed tx to ensure
  // what we built matches what was requested (defense against build bugs)
  const recipientOut = tx.outs[0];
  const decodedAddr = utxoLib.address.fromOutputScript(recipientOut.script, VERUS_NETWORK);
  if (decodedAddr !== toAddress) {
    throw new Error(`TX verification failed: output address ${decodedAddr} does not match ${toAddress}`);
  }
  if (recipientOut.value !== amountSat) {
    throw new Error(`TX verification failed: output value ${recipientOut.value} does not match ${amountSat}`);
  }

  // Zero private key material after signing
  try { keyPair.getPrivateKeyBuffer().fill(0); } catch (e) {
    console.warn('Failed to zero key after signing:', e);
  }

  return tx.toHex();
}

/**
 * Build, sign, and return the raw hex of a Verus conversion transaction.
 * Uses a ReserveTransfer output (EVAL_RESERVE_TRANSFER) to convert between currencies.
 * Currently supports VRSC as the source currency (native P2PKH UTXOs).
 */
export async function buildConversionTransaction(
  wif: string,
  scripthash: string,
  senderAddress: string,
  amountSat: number,
  fromCurrencyId: string,
  toCurrencyId: string,
  viaCurrencyId: string,
  direct = false,
): Promise<string> {
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0) {
    throw new Error('Invalid amount: must be a positive safe integer');
  }

  const BN = require('bn.js');
  const {
    ReserveTransfer,
    RESERVE_TRANSFER_VALID,
    RESERVE_TRANSFER_CONVERT,
    RESERVE_TRANSFER_RESERVE_TO_RESERVE,
    CurrencyValueMap,
    TransferDestination,
    DEST_PKH,
    FLAG_DEST_AUX,
    OptCCParams,
    TxDestination,
    KeyID,
    TOKEN_OUTPUT_VERSION_CURRENT,
  } = require('verus-typescript-primitives/dist/pbaas');
  const { SmartTransactionScript } = require('verus-typescript-primitives/dist/pbaas/transaction/SmartTransactionScript');
  const { fromBase58Check } = require('verus-typescript-primitives/dist/utils/address');

  const VRSC_IADDR = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
  // System condition address for ReserveTransfer CC outputs
  const SYSTEM_DEST_ADDR = 'RTqQe58LSj2yr5CrwYFwcsAQ1edQwmrkUU';
  // Direct conversion (into basket): 1 step = 10000 sat fee
  // Reserve-to-reserve (via basket): 2 steps = 20000 sat fee
  const TRANSFER_FEE = direct ? 10000 : 20000;

  // Build ReserveTransfer flags
  let flags = RESERVE_TRANSFER_VALID.or(RESERVE_TRANSFER_CONVERT);
  if (!direct) {
    flags = flags.or(RESERVE_TRANSFER_RESERVE_TO_RESERVE);
  }

  // Currency value map: source currency → amount
  const values = new CurrencyValueMap({
    value_map: new Map([[fromCurrencyId, new BN(amountSat)]]),
    multivalue: false,
  });

  // Transfer destination: send converted output back to sender
  // Uses DEST_PKH | FLAG_DEST_AUX with aux dest as refund address
  const addrHash = fromBase58Check(senderAddress).hash;
  const auxDest = new TransferDestination({
    type: DEST_PKH,
    destination_bytes: addrHash,
  });
  const transferDest = new TransferDestination({
    type: DEST_PKH.or(FLAG_DEST_AUX),
    destination_bytes: addrHash,
    aux_dests: [auxDest],
  });

  // Build the ReserveTransfer
  // Direct: dest_currency_id = basket, no second_reserve_id
  // Via:    dest_currency_id = basket (via), second_reserve_id = target
  const rtParams: Record<string, unknown> = {
    values: values,
    version: TOKEN_OUTPUT_VERSION_CURRENT,
    flags: flags,
    fee_currency_id: VRSC_IADDR,
    fee_amount: new BN(TRANSFER_FEE),
    transfer_destination: transferDest,
    dest_currency_id: direct ? toCurrencyId : viaCurrencyId,
  };
  if (!direct) {
    rtParams.second_reserve_id = toCurrencyId;
  }
  const rt = new ReserveTransfer(rtParams);

  // Build the output script: <master> OP_CHECKCRYPTOCONDITION <params> OP_DROP
  // Uses the system condition address (not sender) for CC output
  const systemKeyId = KeyID.fromAddress(SYSTEM_DEST_ADDR);
  const systemTxDest = new TxDestination(systemKeyId);

  const master = new OptCCParams({
    version: new BN(3),
    eval_code: new BN(0), // EVAL_NONE for master
    m: new BN(1),
    n: new BN(1),
    destinations: [systemTxDest],
    vdata: [],
  });

  const params = new OptCCParams({
    version: new BN(3),
    eval_code: new BN(8), // EVAL_RESERVE_TRANSFER
    m: new BN(1),
    n: new BN(1),
    destinations: [systemTxDest],
    vdata: [rt.toBuffer()],
  });

  const scriptBuf = new SmartTransactionScript(master, params).toBuffer();

  // Output value = conversion amount + transfer fee (in native VRSC sats)
  const outputValue = amountSat + TRANSFER_FEE;

  // Fetch UTXOs and fee rate
  const [utxos, feeRate] = await Promise.all([
    listUnspent(scripthash),
    fetchFeeRate(),
  ]);

  if (utxos.length === 0) {
    throw new Error('No UTXOs available');
  }

  // Estimate tx size: CC output is larger than standard P2PKH
  const ccOutputSize = scriptBuf.length + 8; // script + value
  function estimateConvTxSize(inputCount: number): number {
    return inputCount * 148 + ccOutputSize + 34 + 10; // cc output + change output + overhead
  }

  // Select UTXOs with iterative fee calculation
  const outputCount = 2;
  let fee = MIN_FEE;
  let { selected, total } = selectUTXOs(utxos, outputValue + fee);

  for (let i = 0; i < 5; i++) {
    const size = estimateConvTxSize(selected.length);
    const newFee = Math.max(Math.round(size * feeRate / 1000), MIN_FEE);
    if (newFee <= fee) break;
    fee = newFee;
    ({ selected, total } = selectUTXOs(utxos, outputValue + fee));
  }

  const change = total - outputValue - fee;
  if (change < 0) {
    throw new Error(`Insufficient funds: have ${total}, need ${outputValue + fee}`);
  }

  // Build the transaction
  const keyPair = keyPairFromWIF(wif);
  const spk = scriptPubKeyFromWIF(wif);
  const senderAddr = keyPair.getAddress();

  const txb = new TransactionBuilder(VERUS_NETWORK);
  txb.setVersion(4);
  txb.setVersionGroupId(0x892f2085);
  txb.setExpiryHeight(0);

  // Add inputs
  for (const utxo of selected) {
    txb.addInput(utxo.tx_hash, utxo.tx_pos, Transaction.DEFAULT_SEQUENCE, spk);
  }

  // Add conversion output (CryptoCondition script)
  txb.addOutput(scriptBuf, outputValue);

  // Add change output if above dust
  if (change > DUST_THRESHOLD) {
    txb.addOutput(senderAddr, change);
  } else {
    fee += change;
  }

  // Sign all inputs
  const hashType = Transaction.SIGHASH_ALL;
  for (let i = 0; i < selected.length; i++) {
    txb.sign(i, keyPair, null, hashType, selected[i].value);
  }

  const tx = txb.build();

  // Post-build verification: ensure the CC output value matches the intended
  // conversion amount + transfer fee, and change goes back to sender
  const ccOut = tx.outs[0];
  if (ccOut.value !== outputValue) {
    throw new Error(`TX verification failed: CC output value ${ccOut.value} does not match expected ${outputValue}`);
  }
  if (tx.outs.length > 1) {
    const changeOut = tx.outs[1];
    const changeAddr = utxoLib.address.fromOutputScript(changeOut.script, VERUS_NETWORK);
    if (changeAddr !== senderAddr) {
      throw new Error(`TX verification failed: change output goes to ${changeAddr}, expected ${senderAddr}`);
    }
  }

  // Zero private key material
  try { keyPair.getPrivateKeyBuffer().fill(0); } catch (e) {
    console.warn('Failed to zero key after signing:', e);
  }

  return tx.toHex();
}
