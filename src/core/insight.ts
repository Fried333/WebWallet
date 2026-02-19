// Insight API client for Verus
// Provides currency balances and CC-aware UTXOs via insight.verus.io

import type { CurrencyBalances, InsightUTXO } from '@shared/types';
import { isValidAddress } from '@core/keychain';

const INSIGHT_BASE = 'https://insight.verus.io';
const REQUEST_TIMEOUT = 15_000;
const HEX64_RE = /^[a-fA-F0-9]{64}$/;

async function insightGet<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(`${INSIGHT_BASE}${path}`, {
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Insight HTTP ${res.status}: ${res.statusText}`);
    }

    return (await res.json()) as T;
  } catch (err) {
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function insightPost<T>(path: string, body: Record<string, string>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(`${INSIGHT_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Insight HTTP ${res.status}: ${text}`);
    }

    return (await res.json()) as T;
  } catch (err) {
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Response Validation Helpers ---

function isSafeNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isSafeNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function validateAddress(address: string): void {
  if (!isValidAddress(address)) {
    throw new Error('Invalid address passed to Insight API');
  }
}

/**
 * Fetch all currency balances for an address.
 * Returns a map of currency name → balance in coins.
 */
export async function getCurrencyBalances(address: string): Promise<CurrencyBalances> {
  validateAddress(address);
  const data = await insightGet<Record<string, unknown>>(
    `/api/addr/${encodeURIComponent(address)}`,
  );
  if (!data || typeof data !== 'object') throw new Error('Invalid currency balance response');
  const balances = data.currencybalances;
  if (balances === undefined || balances === null) return {};
  if (typeof balances !== 'object') throw new Error('Invalid currencybalances field');
  // Validate each entry is string → number
  const result: CurrencyBalances = {};
  for (const [name, val] of Object.entries(balances as Record<string, unknown>)) {
    if (typeof name !== 'string' || !isSafeNum(val)) continue; // skip malformed entries
    result[name] = val;
  }
  return result;
}

/**
 * Fetch all UTXOs for an address (including CC outputs).
 */
export async function getAddressUtxos(address: string): Promise<InsightUTXO[]> {
  validateAddress(address);
  const result = await insightGet<unknown[]>(
    `/api/addr/${encodeURIComponent(address)}/utxo`,
  );
  if (!Array.isArray(result)) throw new Error('Invalid UTXO response');
  return (result as Record<string, unknown>[]).map((u, i) => {
    if (typeof u.txid !== 'string' || !HEX64_RE.test(u.txid))
      throw new Error(`Insight UTXO[${i}]: invalid txid`);
    if (!isSafeNonNegInt(u.vout))
      throw new Error(`Insight UTXO[${i}]: invalid vout`);
    if (typeof u.scriptPubKey !== 'string' || !/^[a-fA-F0-9]+$/.test(u.scriptPubKey))
      throw new Error(`Insight UTXO[${i}]: invalid scriptPubKey`);
    if (!isSafeNum(u.amount))
      throw new Error(`Insight UTXO[${i}]: invalid amount`);
    if (!isSafeNonNegInt(u.satoshis))
      throw new Error(`Insight UTXO[${i}]: invalid satoshis`);
    if (!isSafeNonNegInt(u.height))
      throw new Error(`Insight UTXO[${i}]: invalid height`);
    if (!isSafeNonNegInt(u.confirmations))
      throw new Error(`Insight UTXO[${i}]: invalid confirmations`);
    return {
      address: typeof u.address === 'string' ? u.address : address,
      txid: u.txid,
      vout: u.vout,
      scriptPubKey: u.scriptPubKey,
      amount: u.amount,
      satoshis: u.satoshis,
      height: u.height,
      confirmations: u.confirmations,
    } as InsightUTXO;
  });
}

/**
 * Fetch transaction IDs for an address from Insight.
 * Includes CC outputs (imports, currency transfers) that Electrum misses.
 * Returns txids with height and confirmation status.
 */
export async function listTransactions(address: string): Promise<Array<{ txid: string; height: number; confirmed: boolean }>> {
  validateAddress(address);
  const data = await insightGet<Record<string, unknown>>(
    `/api/txs/?address=${encodeURIComponent(address)}&pageNum=0`,
  );
  if (!data || typeof data !== 'object') throw new Error('Invalid tx list response');
  const txs = data.txs;
  if (!Array.isArray(txs)) throw new Error('Invalid txs array');
  return (txs as Record<string, unknown>[])
    .filter(tx => typeof tx.txid === 'string' && HEX64_RE.test(tx.txid as string))
    .map(tx => ({
      txid: tx.txid as string,
      height: isSafeNonNegInt(tx.blockheight) ? (tx.blockheight as number) : 0,
      confirmed: isSafeNonNegInt(tx.confirmations) && (tx.confirmations as number) > 0,
    }));
}

/** Insight API transaction detail shape */
export interface InsightVout {
  value: string;           // VRSC value as string (e.g. "0.00000000")
  n: number;
  scriptPubKey: {
    hex: string;
    addresses?: string[];
    type?: string;
  };
  addresses?: string[];
  script_reserve_balance?: Record<string, number>; // currency name → amount in coins
}

export interface InsightTxDetail {
  txid: string;
  vin: Array<{
    addr?: string;
    valueSat?: number;
  }>;
  vout: InsightVout[];
  fees: number;
  blockheight: number;
  confirmations: number;
  time?: number;
}

/**
 * Fetch full transaction detail from Insight (includes currency data in vout).
 */
export async function getTransactionDetail(txid: string): Promise<InsightTxDetail> {
  if (!HEX64_RE.test(txid)) throw new Error('Invalid txid for Insight API');
  const result = await insightGet<Record<string, unknown>>(
    `/api/tx/${encodeURIComponent(txid)}`,
  );
  if (!result || typeof result !== 'object') throw new Error('Invalid tx detail response');
  if (!Array.isArray(result.vin)) throw new Error('Insight tx: missing vin array');
  if (!Array.isArray(result.vout)) throw new Error('Insight tx: missing vout array');
  return result as unknown as InsightTxDetail;
}

/**
 * Broadcast a raw transaction hex via Insight.
 * Returns the txid.
 */
export async function broadcastTransaction(rawtx: string): Promise<string> {
  const result = await insightPost<Record<string, unknown>>('/api/tx/send', { rawtx });
  if (typeof result.txid !== 'string') throw new Error('Invalid broadcast response');
  return result.txid;
}
