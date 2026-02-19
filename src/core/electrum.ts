// Electrum HTTPS REST proxy client for Verus
// Uses the pbca26/electrum-proxy instances at el0-3.verus.io
// All endpoints require ip= and port= params pointing to the ElectrumX backend

import type { Balance, UTXO, TransactionSummary } from '@shared/types';

const PROXY_SERVERS = [
  'https://el0.verus.io',
  'https://el1.verus.io',
  'https://el2.verus.io',
  'https://el3.verus.io',
];

const ELECTRUMX_PORT = '17485';
const REQUEST_TIMEOUT = 15_000;

let serverIndex = 0;

function nextServer(): string {
  const server = PROXY_SERVERS[serverIndex % PROXY_SERVERS.length];
  serverIndex++;
  return server;
}

interface ProxyResponse {
  msg: 'success' | 'error';
  result: unknown;
}

async function proxyGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  let lastError: Error | null = null;

  // Try each server once before giving up
  for (let i = 0; i < PROXY_SERVERS.length; i++) {
    const server = nextServer();
    const hostname = new URL(server).hostname;
    const searchParams = new URLSearchParams({
      ...params,
      port: ELECTRUMX_PORT,
      ip: hostname,
    });
    const url = `${server}${path}?${searchParams}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch(url, { signal: controller.signal });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json: ProxyResponse = await res.json();
      if (json.msg === 'error') {
        throw new Error(`Proxy error: ${JSON.stringify(json.result)}`);
      }

      return json.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`Electrum proxy ${server} failed:`, lastError.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('All Electrum proxy servers failed');
}

async function proxyPost(path: string, body: Record<string, string>): Promise<unknown> {
  let lastError: Error | null = null;

  for (let i = 0; i < PROXY_SERVERS.length; i++) {
    const server = nextServer();
    const hostname = new URL(server).hostname;
    const url = `${server}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          port: ELECTRUMX_PORT,
          ip: hostname,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json: ProxyResponse = await res.json();
      if (json.msg === 'error') {
        throw new Error(`Proxy error: ${JSON.stringify(json.result)}`);
      }

      return json.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`Electrum proxy ${server} POST failed:`, lastError.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('All Electrum proxy servers failed');
}

// --- Response Validation Helpers ---

const HEX64_RE = /^[a-fA-F0-9]{64}$/;

function isSafeNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && HEX64_RE.test(v);
}

function assertHex64(v: string, label: string): void {
  if (!HEX64_RE.test(v)) throw new Error(`Invalid ${label}: expected 64-char hex`);
}

// --- Public API ---

export async function getBalance(scripthash: string): Promise<Balance> {
  assertHex64(scripthash, 'scripthash');
  const result = await proxyGet('/api/getbalance', { address: scripthash });
  const r = result as Record<string, unknown>;
  if (!r || typeof r !== 'object') throw new Error('Invalid balance response');
  const confirmed = r.confirmed;
  const unconfirmed = r.unconfirmed;
  if (!isSafeInt(confirmed) || confirmed < 0) throw new Error('Invalid confirmed balance');
  if (!isSafeInt(unconfirmed)) throw new Error('Invalid unconfirmed balance');
  return { confirmed, unconfirmed, lastUpdated: Date.now() };
}

export async function listUnspent(scripthash: string): Promise<UTXO[]> {
  assertHex64(scripthash, 'scripthash');
  const result = await proxyGet('/api/listunspent', { address: scripthash });
  if (!Array.isArray(result)) throw new Error('Invalid listUnspent response');
  return result.map((u: Record<string, unknown>, i: number) => {
    if (!isHex64(u.tx_hash)) throw new Error(`UTXO[${i}]: invalid tx_hash`);
    if (!isSafeInt(u.tx_pos) || (u.tx_pos as number) < 0) throw new Error(`UTXO[${i}]: invalid tx_pos`);
    if (!isSafeInt(u.value) || (u.value as number) < 0) throw new Error(`UTXO[${i}]: invalid value`);
    if (!isSafeInt(u.height)) throw new Error(`UTXO[${i}]: invalid height`);
    return {
      tx_hash: u.tx_hash as string,
      tx_pos: u.tx_pos as number,
      height: u.height as number,
      value: u.value as number,
    };
  });
}

export async function listTransactions(scripthash: string): Promise<TransactionSummary[]> {
  assertHex64(scripthash, 'scripthash');
  const result = await proxyGet('/api/listtransactions', { address: scripthash });
  if (!Array.isArray(result)) throw new Error('Invalid listTransactions response');
  return result.map((t: Record<string, unknown>) => {
    if (!isHex64(t.tx_hash)) throw new Error('listTransactions: invalid tx_hash');
    if (!isSafeInt(t.height)) throw new Error('listTransactions: invalid height');
    return {
      txid: t.tx_hash as string,
      height: t.height as number,
      value: 0,
      confirmed: (t.height as number) > 0,
    };
  });
}

export async function getTransaction(txid: string): Promise<string> {
  assertHex64(txid, 'txid');
  const result = await proxyGet('/api/gettransaction', { txid });
  if (typeof result !== 'string' || !/^[a-fA-F0-9]+$/.test(result)) {
    throw new Error('Invalid raw transaction hex');
  }
  return result;
}

// --- Verbose transaction types ---

export interface ElectrumReserveTransfer {
  currencyvalues?: Record<string, number>; // i-address → amount in coins
  destinationcurrencyid?: string;          // target currency i-address
  via?: string;                            // basket i-address
  fees?: number;                           // conversion fee in coins
  convert?: boolean;
  reservetoreserve?: boolean;
}

export interface ElectrumVerboseVout {
  value: number;       // VRSC value in coins (e.g. 0.00010000)
  valueSat: number;    // VRSC value in satoshis
  n: number;
  scriptPubKey: {
    type: string;         // "pubkeyhash", "cryptocondition", etc.
    addresses?: string[];
    reserve_balance?: Record<string, number>; // friendly currency name → amount in coins
    reservetransfer?: ElectrumReserveTransfer; // present on conversion outputs
    spendableoutput?: boolean;
  };
}

export interface ElectrumVerboseTx {
  txid: string;
  vin: Array<{
    txid?: string;
    vout?: number;
    address?: string;
    addresses?: string[];
    valueSat?: number;
  }>;
  vout: ElectrumVerboseVout[];
  confirmations: number;
  time?: number;
  blocktime?: number;
  height?: number;
}

export async function getTransactionVerbose(txid: string): Promise<ElectrumVerboseTx> {
  assertHex64(txid, 'txid');
  const result = await proxyGet('/api/gettransaction', { txid, verbose: 'true' });
  const r = result as Record<string, unknown>;
  if (!r || typeof r !== 'object') throw new Error('Invalid verbose tx response');
  if (!Array.isArray(r.vin)) throw new Error('Verbose tx: missing vin array');
  if (!Array.isArray(r.vout)) throw new Error('Verbose tx: missing vout array');
  // Validate vout entries have required structure
  for (let i = 0; i < (r.vout as unknown[]).length; i++) {
    const vout = (r.vout as Record<string, unknown>[])[i];
    if (!isSafeNum(vout.value)) throw new Error(`Verbose tx vout[${i}]: invalid value`);
    if (!vout.scriptPubKey || typeof vout.scriptPubKey !== 'object') {
      throw new Error(`Verbose tx vout[${i}]: missing scriptPubKey`);
    }
  }
  return r as unknown as ElectrumVerboseTx;
}

export async function getCurrentBlock(): Promise<number> {
  const result = await proxyGet('/api/getcurrentblock');
  if (!isSafeInt(result) || (result as number) < 0) throw new Error('Invalid block height');
  return result as number;
}

export async function estimateFee(blocks = 2): Promise<number> {
  const result = await proxyGet('/api/estimatefee', { blocks: String(blocks) });
  if (!isSafeNum(result)) throw new Error('Invalid fee estimate');
  const feePerKB = result as number;
  // Returns fee in VRSC/KB, convert to sat/KB. -1 means no estimate available.
  if (feePerKB < 0) return 10_000; // fallback: 10000 sat/KB
  return Math.round(feePerKB * 1e8);
}

export async function broadcastTransaction(rawtx: string): Promise<string> {
  const result = await proxyPost('/api/pushtx', { rawtx });
  if (typeof result !== 'string') throw new Error('Invalid broadcast response');
  return result;
}
