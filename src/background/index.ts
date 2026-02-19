// Verus Web Wallet - Service Worker (Background)
// Handles wallet lifecycle, blockchain queries, transaction signing, auto-lock, and dApp login

import { debugLog } from '@core/debug';
import { encryptVault, decryptVault, PBKDF2_ITERATIONS } from '@core/vault';
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeedSync,
  mnemonicToEntropy,
  entropyToMnemonic,
  wordlist,
  deriveKeyFromSeed,
  addressToScripthash,
  isValidAddress,
  VERUS_NETWORK,
} from '@core/keychain';
import * as electrum from '@core/electrum';
import * as insight from '@core/insight';
import * as verusid from '@core/verusid';
import { buildTransaction, buildConversionTransaction, estimateTransactionFee, simulateTransaction } from '@core/transaction';
import { resolveCurrencyId, buildCurrencyTransaction } from '@core/currency-transaction';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  LoginConsentRequest,
  LoginConsentResponse,
  LoginConsentDecision,
  VerusIDSignature,
  LOGIN_CONSENT_WEBHOOK_VDXF_KEY,
  LOGIN_CONSENT_RESPONSE_SIG_VDXF_KEY,
  toIAddress,
} from 'verus-typescript-primitives';

// @ts-ignore — vendor lib without TS declarations
const utxoLib = require('@bitgo/utxo-lib');
import type {
  ExtensionMessage,
  ExtensionResponse,
  SessionData,
  Account,
  Balance,
  WalletSettings,
  PendingLoginRequest,
  PendingSendRequest,
  CreateWalletPayload,
  ImportWalletPayload,
  UnlockWalletPayload,
  SendTransactionPayload,
  SendConversionPayload,
  GetMnemonicPayload,
  SendCurrencyPayload,
  ConversionInfo,
} from '@shared/types';
import currencyMap from '../data/currency-map.json';

// --- Sender Validation ---

/** Only the extension's own popup/pages pass this check */
function isPopupSender(sender?: chrome.runtime.MessageSender): boolean {
  return sender?.url?.startsWith(chrome.runtime.getURL('')) ?? false;
}

/** Message types that content scripts (webpages) are allowed to send */
const CONTENT_SCRIPT_ALLOWLIST: ReadonlySet<string> = new Set([
  'DAPP_LOGIN_DEEPLINK',
  'DAPP_SEND_REQUEST',
  'PING',
]);

// --- Webhook URL Validation ---

/** Reject non-HTTPS and private/reserved IP destinations */
function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const h = parsed.hostname;
    // Loopback
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return false;
    // RFC 1918 private ranges
    if (h.startsWith('10.')) return false;
    if (h.startsWith('192.168.')) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    // Link-local
    if (h.startsWith('169.254.')) return false;
    // CGNAT / Tailscale / cloud metadata
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return false;
    // 0.0.0.0/8
    if (/^0\./.test(h)) return false;
    // Benchmark, documentation ranges
    if (h.startsWith('198.18.') || h.startsWith('198.19.')) return false;
    if (h.startsWith('198.51.100.')) return false;
    if (h.startsWith('203.0.113.')) return false;
    // IPv6 private/link-local
    if (h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe80:')) return false;
    // Block IPv6-mapped IPv4 addresses (e.g., ::ffff:10.0.0.1, ::ffff:7f00:1)
    if (h.includes('::ffff:')) return false;
    // Block any remaining IPv6 (contains ':') — webhooks should use domain names
    if (h.includes(':')) return false;
    // Must contain a dot (rejects bare hostnames like 'internal')
    if (!h.includes('.')) return false;
    return true;
  } catch {
    return false;
  }
}

// --- Brute-force Protection ---

const MAX_ATTEMPTS_BEFORE_LOCKOUT = 5;
const BASE_LOCKOUT_MS = 5_000; // 5 seconds, doubles each attempt
const MAX_LOCKOUT_MS = 60 * 60_000; // cap at 1 hour

async function checkUnlockRateLimit(): Promise<string | null> {
  const result = await chrome.storage.local.get('_unlockAttempts');
  const attempts = result._unlockAttempts as { count: number; lastFailedAt: number } | undefined;
  if (!attempts || attempts.count < MAX_ATTEMPTS_BEFORE_LOCKOUT) return null;

  const lockoutMs = Math.min(
    BASE_LOCKOUT_MS * Math.pow(2, attempts.count - MAX_ATTEMPTS_BEFORE_LOCKOUT),
    MAX_LOCKOUT_MS,
  );
  const elapsed = Date.now() - attempts.lastFailedAt;
  if (elapsed < lockoutMs) {
    const remainingSec = Math.ceil((lockoutMs - elapsed) / 1000);
    return `Too many failed attempts. Try again in ${remainingSec}s`;
  }
  return null;
}

async function recordFailedUnlock(): Promise<void> {
  const result = await chrome.storage.local.get('_unlockAttempts');
  const attempts = result._unlockAttempts as { count: number; lastFailedAt: number } | undefined;
  await chrome.storage.local.set({
    _unlockAttempts: { count: (attempts?.count ?? 0) + 1, lastFailedAt: Date.now() },
  });
}

async function resetUnlockAttempts(): Promise<void> {
  await chrome.storage.local.remove('_unlockAttempts');
}

// --- Constants ---
const DEFAULT_AUTO_LOCK_MINUTES = 5;
const BALANCE_POLL_MINUTES = 1;
const BALANCE_THROTTLE_MS = 3_000; // min 3s between balance requests
let lastBalanceRequestAt = 0;

// --- Transaction detail cache (cleared on lock/reset/account switch) ---
// Confirmed txs never change, so we cache their decoded details.
// Unconfirmed txs are always re-fetched.
// Rollbacks: safe because tx.confirmed comes from fresh listTransactions(),
// so a reorg'd tx shows confirmed=false → cache bypassed → re-fetched.
// Key: "address:txid" — values are relative to the viewing address.
interface CachedTxDetail {
  value: number;
  timestamp?: number;
  currencyTransfers?: Array<{ currency: string; amount: number }>;
  conversionInfo?: ConversionInfo;
  isSwapIn?: boolean;
}

// Resolve i-address to human-readable currency name
const idToName = currencyMap.currencies as Record<string, string>;
function resolveCurrencyName(iAddr: string): string {
  return idToName[iAddr] || iAddr.slice(0, 8) + '...';
}
const txDetailCache = new Map<string, CachedTxDetail>();
// Persistent cache key for Insight tx list (survives SW restarts)
const INSIGHT_TX_CACHE_KEY = 'insightTxCache';

// --- Helpers ---

async function getSession(): Promise<SessionData | null> {
  const result = await chrome.storage.session.get('session');
  return (result.session as SessionData) ?? null;
}

async function setSession(data: SessionData): Promise<void> {
  await chrome.storage.session.set({ session: data });
}

async function clearSession(): Promise<void> {
  await chrome.storage.session.remove('session');
  txDetailCache.clear();
}

async function getSettings(): Promise<WalletSettings> {
  const result = await chrome.storage.local.get('settings');
  return (result.settings as WalletSettings) ?? { autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES };
}

async function hasVault(): Promise<boolean> {
  const { vault } = await chrome.storage.local.get('vault');
  return !!vault;
}

async function getCachedBalance(): Promise<Balance | null> {
  const result = await chrome.storage.local.get('balance');
  return (result.balance as Balance) ?? null;
}

async function setCachedBalance(balance: Balance): Promise<void> {
  await chrome.storage.local.set({ balance });
}

function getActiveAccount(session: SessionData): Account {
  return session.accounts.find(a => a.index === session.activeIndex) ?? session.accounts[0];
}

function deriveAccounts(seed: number[], count: number): Account[] {
  const seedBuf = Buffer.from(seed);
  const accounts: Account[] = [];
  for (let i = 0; i < count; i++) {
    const { address } = deriveKeyFromSeed(seedBuf, i);
    accounts.push({ index: i, address });
  }
  seedBuf.fill(0);
  return accounts;
}

/** Derive the WIF for the active account on-demand from the seed (never stored in session) */
function getActiveWif(session: SessionData): string {
  const seedBuf = Buffer.from(session.seed);
  const { wif } = deriveKeyFromSeed(seedBuf, session.activeIndex);
  seedBuf.fill(0);
  return wif;
}

/** Convert mnemonic to seed byte array for session storage (mutable, unlike hex strings) */
function mnemonicToSeedArray(mnemonic: string): number[] {
  return Array.from(mnemonicToSeedSync(mnemonic));
}

/** Vault data format — stores entropy+seed bytes, never mnemonic strings */
interface VaultPayload {
  version: 2;
  entropy: number[];  // BIP39 entropy bytes (can be zeroed, unlike strings)
  seed: number[];     // BIP39 seed bytes (avoids mnemonic string during unlock)
  address: string;
}

/** Build vault payload from a mnemonic string (mnemonic is transient) */
function buildVaultData(mnemonic: string, address: string): VaultPayload {
  const entropy = Array.from(mnemonicToEntropy(mnemonic, wordlist));
  const seed = mnemonicToSeedArray(mnemonic);
  return { version: 2, entropy, seed, address };
}

function ok(data?: unknown): ExtensionResponse {
  return { success: true, data };
}

function fail(error: string): ExtensionResponse {
  return { success: false, error };
}

// --- Challenge Signature Verification ---

/**
 * Verify that a LoginConsentRequest was actually signed by the claimed signing_id.
 * Uses secp256k1 compact signature recovery to check against on-chain identity.
 */
async function verifyChallengeSignature(
  uri: string,
  requestingId: string,
): Promise<boolean> {
  try {
    const request = LoginConsentRequest.fromWalletDeeplinkUri(uri);
    if (!request.signature?.signature) return false;

    // Look up identity on-chain to get primary addresses
    const identityResult = await verusid.getIdentity(requestingId);
    const primaryAddresses: string[] = identityResult?.identity?.primaryaddresses ?? [];
    if (primaryAddresses.length === 0) return false;

    // Decode IdentitySignature buffer (NOT a raw 65-byte compact sig).
    // Format: version(u8) [hashType(u8) if v2] blockHeight(u32) numSigs(u8) [varSlice sigs...]
    const sigBuf = Buffer.from(request.signature.signature, 'base64');
    let offset = 0;
    const sigVersion = sigBuf.readUInt8(offset); offset += 1;
    if (sigVersion !== 1 && sigVersion !== 2) return false;

    if (sigVersion === 2) {
      offset += 1; // skip hashType byte
    }

    const sigBlockHeight = sigBuf.readUInt32LE(offset); offset += 4;
    const numSigs = sigBuf.readUInt8(offset); offset += 1;
    if (numSigs < 1) return false;

    // Read first compact signature (varSlice: varint length prefix + data)
    const sigLen = sigBuf.readUInt8(offset); offset += 1; // varint (compact sigs are 65 bytes, fits in 1-byte varint)
    if (sigLen !== 65 || offset + sigLen > sigBuf.length) return false;
    const compactSigBuf = sigBuf.slice(offset, offset + sigLen);

    // Parse compact signature: recoveryFlag(1) || r(32) || s(32)
    const recoveryFlag = compactSigBuf[0];
    let recoveryBit: number;
    let compressed: boolean;

    if (recoveryFlag >= 31 && recoveryFlag <= 34) {
      // Compressed key: 27 + 4 + recovery (0-3)
      recoveryBit = recoveryFlag - 31;
      compressed = true;
    } else if (recoveryFlag >= 27 && recoveryFlag <= 30) {
      // Uncompressed key: 27 + recovery (0-3)
      recoveryBit = recoveryFlag - 27;
      compressed = false;
    } else {
      return false;
    }

    const compactSig = compactSigBuf.slice(1); // r || s (64 bytes)

    // Use the block height from the signature itself (exact match),
    // plus a small search range in case of minor drift
    const searchHeights = [sigBlockHeight];
    for (let d = 1; d <= 5; d++) {
      searchHeights.push(sigBlockHeight + d);
      if (sigBlockHeight - d > 0) searchHeights.push(sigBlockHeight - d);
    }

    // Try signature versions 2 and 1 (hash ordering differs)
    for (const hashVersion of [sigVersion, sigVersion === 2 ? 1 : 2]) {
      for (const h of searchHeights) {
        try {
          const hash = request.getChallengeHash(h, hashVersion);
          const sig = secp256k1.Signature.fromCompact(compactSig).addRecoveryBit(recoveryBit);
          const recoveredPubkey = sig.recoverPublicKey(hash);
          const pubkeyBytes = recoveredPubkey.toRawBytes(compressed);
          const pkh = utxoLib.crypto.hash160(Buffer.from(pubkeyBytes));
          const recoveredAddress = utxoLib.address.toBase58Check(pkh, VERUS_NETWORK.pubKeyHash);

          if (primaryAddresses.includes(recoveredAddress)) {
            return true;
          }
        } catch {
          continue;
        }
      }
    }

    return false;
  } catch (err) {
    debugLog('BG', 'Challenge signature verification error:', err);
    return false;
  }
}

// --- dApp Login State ---

const MAX_PENDING_LOGINS = 10;
const PENDING_LOGIN_TTL_MS = 5 * 60_000; // 5 minutes
const POPUP_COOLDOWN_MS = 3_000; // 3 seconds between popups per origin

const pendingLogins = new Map<string, PendingLoginRequest & { createdAt: number }>();
const pendingSends = new Map<string, PendingSendRequest & { createdAt: number }>();
const lastPopupByOrigin = new Map<string, number>();

function purgeExpiredRequests(): void {
  const now = Date.now();
  for (const [id, entry] of pendingLogins) {
    if (now - entry.createdAt > PENDING_LOGIN_TTL_MS) {
      pendingLogins.delete(id);
    }
  }
  for (const [id, entry] of pendingSends) {
    if (now - entry.createdAt > PENDING_LOGIN_TTL_MS) {
      pendingSends.delete(id);
    }
  }
}

// --- Auto-lock & Polling ---

async function resetAutoLock(): Promise<void> {
  const settings = await getSettings();
  await chrome.alarms.clear('auto-lock');
  if (settings.autoLockMinutes > 0) {
    chrome.alarms.create('auto-lock', { delayInMinutes: settings.autoLockMinutes });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  debugLog('BG', 'Verus Web Wallet installed');
  await resetAutoLock();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('poll-balance', { periodInMinutes: BALANCE_POLL_MINUTES });
  await resetAutoLock();
});

// Create balance polling alarm on install too
chrome.alarms.create('poll-balance', { periodInMinutes: BALANCE_POLL_MINUTES });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'auto-lock') {
    // Zero seed bytes in memory before clearing session
    const lockSession = await getSession();
    if (lockSession?.seed) {
      lockSession.seed.fill(0);
    }
    await clearSession();
    await debugLog('BG', 'Wallet auto-locked');
    return;
  }

  if (alarm.name === 'poll-balance') {
    const session = await getSession();
    if (!session) return;

    try {
      const active = getActiveAccount(session);
      const scripthash = addressToScripthash(active.address);
      const balance = await electrum.getBalance(scripthash);
      await setCachedBalance(balance);
    } catch (err) {
      console.warn('Balance poll failed:', err);
    }
  }
});

// --- Message Handlers ---

async function handleMessage(
  message: ExtensionMessage,
  sender?: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  await debugLog('BG', `handleMessage: ${message.type}`);

  // Purge stale pending requests on every message
  purgeExpiredRequests();

  // Sender validation: only the extension popup may call privileged messages.
  // Content scripts (webpages) are restricted to the allowlist.
  if (!isPopupSender(sender) && !CONTENT_SCRIPT_ALLOWLIST.has(message.type)) {
    return fail('Unauthorized sender');
  }

  switch (message.type) {
    case 'PING':
      return ok({ status: 'alive' });

    case 'GET_WALLET_STATE': {
      const [vaultExists, session] = await Promise.all([hasVault(), getSession()]);
      const active = session ? getActiveAccount(session) : null;
      return ok({
        initialized: vaultExists,
        locked: !session,
        address: active?.address ?? null,
        accountCount: session?.accounts.length ?? 0,
      });
    }

    case 'CREATE_WALLET': {
      const { password } = message.payload as CreateWalletPayload;
      if (!password || password.length < 8) {
        return fail('Password must be at least 8 characters');
      }
      if (password.length > 1024) {
        return fail('Password must be at most 1024 characters');
      }

      const mnemonic = generateMnemonic(wordlist, 256); // 24 words
      const vaultPayload = buildVaultData(mnemonic, '');
      const seedBuf = Buffer.from(vaultPayload.seed);
      const { address } = deriveKeyFromSeed(seedBuf, 0);
      seedBuf.fill(0);
      vaultPayload.address = address;

      // Encrypt and store vault (entropy+seed, no mnemonic string persisted)
      const encrypted = await encryptVault(JSON.stringify(vaultPayload), password);
      await chrome.storage.local.set({
        vault: { encryptedVault: encrypted, createdAt: Date.now(), pbkdf2Iterations: PBKDF2_ITERATIONS },
        addressCount: 1,
        activeAddressIndex: 0,
      });

      // Auto-unlock: session stores seed (not mnemonic)
      const accounts: Account[] = [{ index: 0, address }];
      await setSession({ seed: vaultPayload.seed, accounts, activeIndex: 0 });
      await resetAutoLock();

      return ok({ mnemonic, address });
    }

    case 'IMPORT_WALLET': {
      const { mnemonic, password } = message.payload as ImportWalletPayload;
      if (!password || password.length < 8) {
        return fail('Password must be at least 8 characters');
      }
      if (password.length > 1024) {
        return fail('Password must be at most 1024 characters');
      }
      const trimmed = mnemonic.trim().toLowerCase();
      if (!validateMnemonic(trimmed, wordlist)) {
        return fail('Invalid recovery phrase');
      }

      const vaultPayload = buildVaultData(trimmed, '');
      const seedBuf = Buffer.from(vaultPayload.seed);
      const { address } = deriveKeyFromSeed(seedBuf, 0);
      seedBuf.fill(0);
      vaultPayload.address = address;

      const encrypted = await encryptVault(JSON.stringify(vaultPayload), password);
      await chrome.storage.local.set({
        vault: { encryptedVault: encrypted, createdAt: Date.now(), pbkdf2Iterations: PBKDF2_ITERATIONS },
        addressCount: 1,
        activeAddressIndex: 0,
      });

      const accounts: Account[] = [{ index: 0, address }];
      await setSession({ seed: vaultPayload.seed, accounts, activeIndex: 0 });
      await resetAutoLock();

      return ok({ address });
    }

    case 'UNLOCK_WALLET': {
      const lockoutMsg = await checkUnlockRateLimit();
      if (lockoutMsg) return fail(lockoutMsg);

      const { password } = message.payload as UnlockWalletPayload;
      const vaultResult = await chrome.storage.local.get(['vault', 'addressCount', 'activeAddressIndex']);
      const vault = vaultResult.vault as { encryptedVault: string; createdAt: number } | undefined;
      if (!vault) return fail('No wallet found');

      try {
        const decrypted = await decryptVault(vault.encryptedVault, password);
        const data = JSON.parse(decrypted) as VaultPayload;
        // V2 vault: seed is stored directly — no mnemonic string ever created
        const seed = data.seed;

        const count = (vaultResult.addressCount as number) || 1;
        const activeIdx = (vaultResult.activeAddressIndex as number) || 0;
        const accounts = deriveAccounts(seed, count);
        const activeIndex = activeIdx < accounts.length ? activeIdx : 0;
        await setSession({ seed, accounts, activeIndex });
        await resetAutoLock();
        await resetUnlockAttempts();
        const active = accounts.find(a => a.index === activeIndex) ?? accounts[0];
        return ok({ address: active.address });
      } catch {
        await recordFailedUnlock();
        return fail('Incorrect password');
      }
    }

    case 'LOCK_WALLET': {
      // Zero seed bytes in memory before clearing session
      const lockSession = await getSession();
      if (lockSession?.seed) {
        lockSession.seed.fill(0);
      }
      await clearSession();
      await chrome.alarms.clear('auto-lock');
      return ok();
    }

    case 'RESET_WALLET': {
      const resetSession = await getSession();
      if (resetSession?.seed) {
        resetSession.seed.fill(0);
      }
      await clearSession();
      await chrome.alarms.clear('auto-lock');
      await chrome.storage.local.clear();
      return ok();
    }

    case 'GET_BALANCE': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      // Rate-limit balance requests to prevent dApp abuse
      const now = Date.now();
      if (now - lastBalanceRequestAt < BALANCE_THROTTLE_MS) {
        const cached = await getCachedBalance();
        if (cached) return ok(cached);
      }
      lastBalanceRequestAt = now;

      try {
        const active = getActiveAccount(session);
        const scripthash = addressToScripthash(active.address);
        const balance = await electrum.getBalance(scripthash);
        await setCachedBalance(balance);
        return ok(balance);
      } catch (err) {
        await debugLog('BG', 'getBalance error:', err);
        const cached = await getCachedBalance();
        if (cached) return ok(cached);
        return fail(err instanceof Error ? err.message : 'Failed to fetch balance');
      }
    }

    case 'GET_TRANSACTIONS': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      try {
        const active = getActiveAccount(session);

        // Insight is primary — returns ALL tx types (P2PKH + CC/imports)
        const cacheStoreKey = INSIGHT_TX_CACHE_KEY + ':' + active.address;
        let txList: Array<{ txid: string; height: number; confirmed: boolean }> | null = null;

        try {
          txList = await insight.listTransactions(active.address);
          // Persist to chrome.storage.local so it survives SW restarts
          await chrome.storage.local.set({ [cacheStoreKey]: txList });
        } catch {
          // Insight failed — load from persistent cache
          const stored = await chrome.storage.local.get(cacheStoreKey);
          txList = (Array.isArray(stored[cacheStoreKey]) ? stored[cacheStoreKey] : null) as typeof txList;
        }

        if (!txList || txList.length === 0) {
          return ok([]);
        }

        // Sort by height descending (most recent first), unconfirmed (height 0) at top
        txList.sort((a, b) => {
          if (a.height === 0 && b.height === 0) return 0;
          if (a.height === 0) return -1;
          if (b.height === 0) return 1;
          return b.height - a.height;
        });

        const recent = txList.slice(0, 20).map(t => ({
          txid: t.txid,
          height: t.height,
          value: 0,
          confirmed: t.confirmed,
        }));
        const cachePrefix = active.address + ':';
        const enriched = await Promise.all(
          recent.map(async (tx) => {
            const cacheKey = cachePrefix + tx.txid;
            // Use cached detail for confirmed txs (they never change).
            // Rollback-safe: tx.confirmed comes from fresh listTransactions —
            // if a reorg reverts a tx, confirmed=false → cache bypassed.
            const cached = txDetailCache.get(cacheKey);
            if (cached && tx.confirmed) {
              return { ...tx, ...cached };
            }

            try {
              // Use Electrum verbose mode (round-robins across 4 servers)
              const detail = await electrum.getTransactionVerbose(tx.txid);

              // Determine if we are the spender (any vin from our address)
              const weAreSpending = detail.vin.some(v => v.address === active.address);

              // Compute VRSC value from vouts
              let vrscToUs = 0;
              let vrscToOthers = 0;

              // Track currency amounts: currency name → { toUs, toOthers }
              const currencyTotals = new Map<string, { toUs: number; toOthers: number }>();

              for (const vout of detail.vout) {
                const addrs = vout.scriptPubKey?.addresses ?? [];
                const isOurs = addrs.includes(active.address);
                const vrscVal = vout.valueSat ?? Math.round(vout.value * 1e8);

                if (isOurs) {
                  vrscToUs += vrscVal;
                } else {
                  vrscToOthers += vrscVal;
                }

                // Decode currency amounts from reserve_balance (inside scriptPubKey)
                const reserveBalance = vout.scriptPubKey?.reserve_balance;
                if (reserveBalance) {
                  for (const [currName, amount] of Object.entries(reserveBalance)) {
                    let entry = currencyTotals.get(currName);
                    if (!entry) {
                      entry = { toUs: 0, toOthers: 0 };
                      currencyTotals.set(currName, entry);
                    }
                    if (isOurs) {
                      entry.toUs += amount;
                    } else {
                      entry.toOthers += amount;
                    }
                  }
                }
              }

              const value = weAreSpending && vrscToOthers > 0 ? -vrscToOthers : vrscToUs;

              // Build currency transfer list
              const currencyTransfers: Array<{ currency: string; amount: number }> = [];
              for (const [currName, totals] of currencyTotals) {
                if (weAreSpending && totals.toOthers > 0) {
                  currencyTransfers.push({ currency: currName, amount: -totals.toOthers });
                } else if (totals.toUs > 0) {
                  currencyTransfers.push({ currency: currName, amount: totals.toUs });
                }
              }

              // Detect conversion/swap transactions from reservetransfer data
              let conversionInfo: ConversionInfo | undefined;
              for (const vout of detail.vout) {
                const rt = vout.scriptPubKey?.reservetransfer;
                if (rt && rt.convert && rt.currencyvalues) {
                  const fromEntries = Object.entries(rt.currencyvalues);
                  if (fromEntries.length > 0) {
                    const [fromId, fromAmount] = fromEntries[0];
                    conversionInfo = {
                      fromCurrency: resolveCurrencyName(fromId),
                      toCurrency: rt.destinationcurrencyid ? resolveCurrencyName(rt.destinationcurrencyid) : '?',
                      viaCurrency: rt.via ? resolveCurrencyName(rt.via) : '?',
                      fromAmount,
                      fee: rt.fees ?? 0,
                    };
                  }
                  break;
                }
              }

              // Detect swap-in: we received currency via CC import (not spending, got currency)
              const isSwapIn = !weAreSpending
                && currencyTransfers.length > 0
                && currencyTransfers.some(ct => ct.amount > 0);

              const decoded: CachedTxDetail = {
                value,
                timestamp: detail.time,
                currencyTransfers: currencyTransfers.length > 0 ? currencyTransfers : undefined,
                conversionInfo,
                isSwapIn: isSwapIn || undefined,
              };

              // Cache confirmed txs (they won't change)
              if (tx.confirmed) {
                txDetailCache.set(cacheKey, decoded);
              }

              return { ...tx, ...decoded };
            } catch (err) {
              await debugLog('BG', `Failed to decode tx ${tx.txid}:`, err);
              return tx; // Return with value=0 on failure
            }
          }),
        );

        // Prune stale cache entries for this address (txs no longer in recent list)
        const activeTxKeys = new Set(recent.map(tx => cachePrefix + tx.txid));
        for (const key of txDetailCache.keys()) {
          if (key.startsWith(cachePrefix) && !activeTxKeys.has(key)) {
            txDetailCache.delete(key);
          }
        }

        return ok(enriched);
      } catch (err) {
        await debugLog('BG', 'listTransactions error:', err);
        return fail(err instanceof Error ? err.message : 'Failed to fetch transactions');
      }
    }

    case 'GET_RECEIVE_ADDRESS': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');
      return ok({ address: getActiveAccount(session).address });
    }

    case 'ESTIMATE_FEE': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      const { amount } = (message.payload ?? {}) as { amount?: number };
      if (!Number.isSafeInteger(amount) || !amount || amount <= 0) return fail('Invalid amount');

      try {
        const active = getActiveAccount(session);
        const scripthash = addressToScripthash(active.address);
        const estimate = await estimateTransactionFee(scripthash, amount);
        return ok(estimate);
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Fee estimation failed');
      }
    }

    case 'SIMULATE_TRANSACTION': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      const { to, amount } = message.payload as SendTransactionPayload;
      if (!to || !isValidAddress(to)) return fail('Invalid recipient address');
      if (!Number.isSafeInteger(amount) || !amount || amount <= 0) return fail('Invalid amount');

      try {
        const active = getActiveAccount(session);
        const scripthash = addressToScripthash(active.address);
        const balance = await electrum.getBalance(scripthash);
        const totalBalance = balance.confirmed + balance.unconfirmed;
        const simulation = await simulateTransaction(scripthash, to, amount, totalBalance);
        return ok(simulation);
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Simulation failed');
      }
    }

    case 'SEND_TRANSACTION': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      const { to, amount } = message.payload as SendTransactionPayload;
      if (!to || !isValidAddress(to)) return fail('Invalid recipient address');
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('Invalid amount');

      try {
        const active = getActiveAccount(session);
        const wif = getActiveWif(session);
        const scripthash = addressToScripthash(active.address);
        const rawTx = await buildTransaction(wif, scripthash, to, amount);
        const txid = await electrum.broadcastTransaction(rawTx);
        return ok({ txid });
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Transaction failed');
      }
    }

    case 'SEND_CONVERSION': {
      const session4 = await getSession();
      if (!session4) return fail('Wallet is locked');

      const { amountSat, fromCurrencyId, toCurrencyId, viaCurrencyId, direct } = message.payload as SendConversionPayload;
      if (!Number.isSafeInteger(amountSat) || amountSat <= 0) return fail('Invalid amount');
      if (!fromCurrencyId || !toCurrencyId || !viaCurrencyId) return fail('Missing currency parameters');
      // Validate currency IDs are proper base58check i-addresses (version 0x66)
      const isValidIAddr = (id: string): boolean => {
        try {
          if (!/^[a-zA-Z0-9]+$/.test(id)) return false;
          const decoded = utxoLib.address.fromBase58Check(id);
          return decoded.version === 0x66; // i-address version byte
        } catch { return false; }
      };
      if (!isValidIAddr(fromCurrencyId)) return fail('Invalid from currency ID');
      if (!isValidIAddr(toCurrencyId)) return fail('Invalid to currency ID');
      if (!isValidIAddr(viaCurrencyId)) return fail('Invalid via currency ID');

      try {
        const active4 = getActiveAccount(session4);
        const wif4 = getActiveWif(session4);
        const scripthash4 = addressToScripthash(active4.address);
        const rawTx = await buildConversionTransaction(
          wif4, scripthash4, active4.address,
          amountSat, fromCurrencyId, toCurrencyId, viaCurrencyId, !!direct,
        );
        const txid = await electrum.broadcastTransaction(rawTx);
        return ok({ txid });
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Conversion failed');
      }
    }

    case 'GET_MNEMONIC': {
      const lockoutMsg2 = await checkUnlockRateLimit();
      if (lockoutMsg2) return fail(lockoutMsg2);

      const { password } = message.payload as GetMnemonicPayload;
      const mnemonicVaultResult = await chrome.storage.local.get('vault');
      const mnemonicVault = mnemonicVaultResult.vault as { encryptedVault: string } | undefined;
      if (!mnemonicVault) return fail('No wallet found');

      try {
        const decrypted = await decryptVault(mnemonicVault.encryptedVault, password);
        const data = JSON.parse(decrypted) as VaultPayload;
        await resetUnlockAttempts();
        // Reconstruct mnemonic from entropy (only when user explicitly requests it)
        const entropy = new Uint8Array(data.entropy);
        const mnemonic = entropyToMnemonic(entropy, wordlist);
        entropy.fill(0);
        return ok({ mnemonic });
      } catch {
        await recordFailedUnlock();
        return fail('Incorrect password');
      }
    }

    case 'ADD_ADDRESS': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      const MAX_ACCOUNTS = 100;
      if (session.accounts.length >= MAX_ACCOUNTS) {
        return fail(`Maximum of ${MAX_ACCOUNTS} accounts reached`);
      }

      const nextIndex = session.accounts.length;
      const seedBuf = Buffer.from(session.seed);
      const { address } = deriveKeyFromSeed(seedBuf, nextIndex);
      seedBuf.fill(0);
      const newAccount: Account = { index: nextIndex, address };
      session.accounts.push(newAccount);
      await setSession(session);
      await chrome.storage.local.set({ addressCount: session.accounts.length });

      return ok({ account: { index: newAccount.index, address: newAccount.address } });
    }

    case 'SWITCH_ADDRESS': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      const { index } = message.payload as { index: number };
      const target = session.accounts.find(a => a.index === index);
      if (!target) return fail('Address not found');

      session.activeIndex = index;
      await setSession(session);
      await chrome.storage.local.set({ activeAddressIndex: index });
      // Clear cached balance so dashboard fetches fresh data for new address
      await chrome.storage.local.remove('balance');

      return ok({ address: target.address });
    }

    case 'GET_ADDRESSES': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      const namesResult = await chrome.storage.local.get('accountNames');
      const names = (namesResult.accountNames as Record<number, string>) ?? {};

      return ok({
        accounts: session.accounts.map(a => ({
          index: a.index,
          address: a.address,
          name: names[a.index] || `Address ${a.index + 1}`,
        })),
        activeIndex: session.activeIndex,
      });
    }

    case 'RENAME_ADDRESS': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      const { index: renameIndex, name: newName } = message.payload as { index: number; name: string };
      if (typeof renameIndex !== 'number' || !session.accounts.find(a => a.index === renameIndex)) {
        return fail('Address not found');
      }
      const trimmedName = (newName ?? '').trim().slice(0, 32);

      const namesResult = await chrome.storage.local.get('accountNames');
      const names = (namesResult.accountNames as Record<number, string>) ?? {};

      if (trimmedName && trimmedName !== `Address ${renameIndex + 1}`) {
        names[renameIndex] = trimmedName;
      } else {
        delete names[renameIndex];
      }
      await chrome.storage.local.set({ accountNames: names });

      return ok({ name: trimmedName || `Address ${renameIndex + 1}` });
    }

    case 'RESET_AUTO_LOCK': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');
      await resetAutoLock();
      return ok();
    }

    // --- dApp Login Handlers ---

    case 'GET_PENDING_LOGIN': {
      const { requestId: pendingId } = message.payload as { requestId: string };
      const req = pendingLogins.get(pendingId);
      if (!req) return fail('No pending login request');

      // Verify the challenge signature against on-chain identity (cache result)
      if (req.signatureVerified === undefined) {
        req.signatureVerified = false;
        if (req.requestingId) {
          req.signatureVerified = await verifyChallengeSignature(req.uri, req.requestingId);
        }
      }

      return ok({
        id: req.id,
        origin: req.origin,
        challengeJson: req.challengeJson,
        webhookUrl: req.webhookUrl,
        requestingId: req.requestingId,
        signatureVerified: req.signatureVerified,
      });
    }

    case 'DAPP_LOGIN_DEEPLINK': {
      const { uri, _reqId: loginReqId } = message.payload as { uri: string; _reqId?: number };
      if (!uri) return fail('Missing deeplink URI');
      if (uri.length > 10_000) return fail('Deeplink URI too large');

      try {
        const request = LoginConsentRequest.fromWalletDeeplinkUri(uri);

        // Reject challenges without a valid timestamp or older than 5 minutes
        const CHALLENGE_MAX_AGE_SEC = 300;
        const createdAt = request.challenge.created_at;
        if (!createdAt || createdAt <= 0) {
          return fail('Challenge missing timestamp');
        }
        const nowSec = Math.floor(Date.now() / 1000);
        if (createdAt > nowSec + 60) {
          return fail('Challenge timestamp is in the future');
        }
        const challengeAge = nowSec - createdAt;
        if (challengeAge > CHALLENGE_MAX_AGE_SEC) {
          return fail('Challenge expired — please request a new login');
        }

        const challengeJson = request.challenge.toJson();

        // Extract webhook URL for display in approval popup
        const webhookRedirect = request.challenge.redirect_uris?.find(
          (r: any) => r.vdxfkey === LOGIN_CONSENT_WEBHOOK_VDXF_KEY.vdxfid
        );
        const webhookUrl = webhookRedirect?.uri;

        const id = crypto.randomUUID();
        const tabId = sender?.tab?.id ?? 0;
        if (!sender?.tab?.url) {
          return fail('Cannot verify request origin');
        }
        const origin = new URL(sender.tab.url).origin;

        // Per-origin popup rate limiting
        const lastLogin = lastPopupByOrigin.get(origin) ?? 0;
        if (Date.now() - lastLogin < POPUP_COOLDOWN_MS) {
          return fail('Please wait before making another request');
        }

        // Purge expired entries before adding
        purgeExpiredRequests();
        if (pendingLogins.size >= MAX_PENDING_LOGINS) {
          return fail('Too many pending login requests');
        }

        const pending: PendingLoginRequest & { createdAt: number } = {
          id,
          uri,
          tabId,
          origin,
          challengeJson,
          webhookUrl,
          requestingId: request.signing_id || undefined,
          _reqId: loginReqId,
          createdAt: Date.now(),
        };
        pendingLogins.set(id, pending);

        lastPopupByOrigin.set(origin, Date.now());
        const popup = await chrome.windows.create({
          url: `popup.html?approval=login&requestId=${id}`,
          type: 'popup',
          width: 380,
          height: 620,
        });

        if (popup?.id != null) {
          pending.windowId = popup.id;
        }

        return ok({ requestId: id });
      } catch (err) {
        await debugLog('BG', 'Failed to parse deeplink:', err);
        return fail(err instanceof Error ? err.message : 'Invalid deeplink');
      }
    }

    case 'DAPP_APPROVE': {
      const { requestId, verusId } = message.payload as { requestId: string; verusId: string };
      const pending = pendingLogins.get(requestId);
      if (!pending) return fail('No pending login request');

      // Block approval if challenge signature was not verified
      if (pending.signatureVerified !== true) {
        return fail('Cannot approve: challenge signature not verified');
      }

      // Atomically claim: delete immediately to prevent double-approval races
      pendingLogins.delete(requestId);

      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      try {
        await debugLog('BG', 'DAPP_APPROVE start');
        const active = getActiveAccount(session);
        const wif = getActiveWif(session);

        // Re-parse original request from stored URI
        const request = LoginConsentRequest.fromWalletDeeplinkUri(pending.uri);

        // Convert VerusID name to i-address
        const signingId = toIAddress(verusId);

        // Get current block height
        const blockHeight = await electrum.getCurrentBlock();

        // Build Decision wrapping the original Request
        const decision = new LoginConsentDecision({
          decision_id: request.challenge.challenge_id,
          request: {
            system_id: request.system_id,
            signing_id: request.signing_id,
            signature: request.signature,
            challenge: request.challenge,
          },
          created_at: Math.floor(Date.now() / 1000),
        });

        // Build Response
        const response = new LoginConsentResponse({
          system_id: request.system_id,
          signing_id: signingId,
          decision: {
            decision_id: decision.decision_id,
            request: {
              system_id: request.system_id,
              signing_id: request.signing_id,
              signature: request.signature,
              challenge: request.challenge,
            },
            created_at: decision.created_at,
          },
        });

        // Compute decision hash (signature version 2)
        const hash = response.getDecisionHash(blockHeight, 2);

        // Sign using IdentitySignature (produces the structured buffer the sidecar expects)
        const keyPair = utxoLib.ECPair.fromWIF(wif, VERUS_NETWORK);
        const idSig = new utxoLib.IdentitySignature(
          VERUS_NETWORK,
          2,          // version
          5,          // hashType = HASH_SHA256
          blockHeight,
          null,       // signatures (will be added by signHashOffline)
          request.system_id,  // chainId
          signingId,          // identity i-address
        );
        idSig.signHashOffline(hash, keyPair);
        const base64Sig = idSig.toBuffer().toString('base64');

        // Zero sensitive key material
        try { keyPair.getPrivateKeyBuffer().fill(0); } catch (e) {
          await debugLog('BG', 'WARNING: Failed to zero key after signing:', e);
        }

        // Set signature on response
        response.signature = new VerusIDSignature(
          { signature: base64Sig },
          LOGIN_CONSENT_RESPONSE_SIG_VDXF_KEY,
        );

        // Serialize response to JSON
        const responseJson = response.toJson();

        // Find webhook URI from challenge redirect_uris
        const webhookUri = request.challenge.redirect_uris?.find(
          (r: any) => r.vdxfkey === LOGIN_CONSENT_WEBHOOK_VDXF_KEY.vdxfid
        );

        if (!webhookUri?.uri) {
          return fail('No webhook URI found in challenge');
        }

        if (!isValidWebhookUrl(webhookUri.uri)) {
          return fail('Webhook URL must be HTTPS and not a private/local address');
        }

        // Verify webhook domain matches the requesting page's origin
        if (pending.origin) {
          try {
            const webhookHost = new URL(webhookUri.uri).hostname;
            const originHost = new URL(pending.origin).hostname;
            // Allow exact match or subdomain (e.g., api.example.com for origin example.com)
            if (webhookHost !== originHost && !webhookHost.endsWith('.' + originHost)) {
              return fail(`Webhook domain (${webhookHost}) does not match requesting origin (${originHost})`);
            }
          } catch {
            return fail('Invalid webhook or origin URL');
          }
        }

        // POST signed response to webhook (15s timeout)
        const webhookController = new AbortController();
        const webhookTimeout = setTimeout(() => webhookController.abort(), 15_000);
        let postResult: Response;
        try {
          postResult = await fetch(webhookUri.uri, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(responseJson),
            signal: webhookController.signal,
          });
        } finally {
          clearTimeout(webhookTimeout);
        }

        if (!postResult.ok) {
          return fail(`Webhook POST failed: HTTP ${postResult.status}`);
        }

        // Notify the originating tab
        if (pending.tabId) {
          chrome.tabs.sendMessage(pending.tabId, {
            type: 'DAPP_RESPONSE',
            success: true,
            requestId,
            _reqId: pending._reqId,
          }).catch(() => {});
        }

        return ok({ posted: true });
      } catch (err) {
        await debugLog('BG', 'DAPP_APPROVE error:', err);
        // Notify the originating tab of failure (pending was already claimed)
        if (pending.tabId) {
          chrome.tabs.sendMessage(pending.tabId, {
            type: 'DAPP_RESPONSE',
            success: false,
            error: err instanceof Error ? err.message : 'Login approval failed',
            requestId,
            _reqId: pending._reqId,
          }).catch(() => {});
        }
        return fail(err instanceof Error ? err.message : 'Login approval failed');
      }
    }

    case 'GET_CURRENCY_BALANCES': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      try {
        const active = getActiveAccount(session);
        const balances = await insight.getCurrencyBalances(active.address);
        // Cache in storage
        await chrome.storage.local.set({ currencyBalances: balances });
        return ok(balances);
      } catch (err) {
        // Try returning cached balances on failure
        const cached = await chrome.storage.local.get('currencyBalances');
        if (cached.currencyBalances) return ok(cached.currencyBalances);
        return fail(err instanceof Error ? err.message : 'Failed to fetch currency balances');
      }
    }

    case 'SEND_CURRENCY_TRANSACTION': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      const { to, currencyName, amount } = message.payload as SendCurrencyPayload;
      if (!to || !isValidAddress(to)) return fail('Invalid recipient address');
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        return fail('Invalid amount');
      }

      try {
        const active = getActiveAccount(session);
        const wif = getActiveWif(session);
        const currencyId = resolveCurrencyId(currencyName);
        // Safe coin→satoshi conversion avoiding float precision issues
        const [whole, frac = ''] = String(amount).split('.');
        const paddedFrac = (frac + '00000000').slice(0, 8);
        const amountSat = Number(whole) * 1e8 + Number(paddedFrac);
        if (!Number.isSafeInteger(amountSat) || amountSat <= 0) {
          return fail('Amount out of range');
        }

        // Get UTXOs from Insight (CC-aware)
        const utxos = await insight.getAddressUtxos(active.address);

        // Build the currency transaction
        const rawTx = buildCurrencyTransaction(
          wif,
          active.address,
          utxos,
          to,
          currencyId,
          amountSat,
        );

        // Broadcast via Insight
        const txid = await insight.broadcastTransaction(rawTx);
        return ok({ txid });
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Currency transaction failed');
      }
    }

    // --- VerusID Handlers ---

    case 'GET_IDENTITY': {
      const { nameOrAddress } = message.payload as { nameOrAddress: string };
      if (!nameOrAddress) return fail('Name or address required');
      try {
        const result = await verusid.getIdentity(nameOrAddress);
        return ok(result);
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Identity lookup failed');
      }
    }

    case 'SET_LINKED_VERUSID': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');
      const { name } = message.payload as { name: string };
      if (!name) return fail('VerusID name required');
      try {
        const result = await verusid.getIdentity(name);
        const active = getActiveAccount(session);
        if (!result.identity.primaryaddresses.includes(active.address)) {
          return fail('This identity does not control your active address');
        }
        await chrome.storage.local.set({
          [`verusid_${active.address}`]: {
            friendlyname: result.friendlyname,
            identityaddress: result.identity.identityaddress,
            status: result.status,
          },
        });
        return ok({ friendlyname: result.friendlyname });
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Failed to link VerusID');
      }
    }

    case 'GET_LINKED_VERUSID': {
      const session = await getSession();
      if (!session) return fail('Wallet is locked');
      const active = getActiveAccount(session);

      // Check cache first
      const cacheKey = `verusids_${active.address}`;
      const cached = await chrome.storage.local.get(cacheKey);
      if (cached[cacheKey]) {
        const all = cached[cacheKey] as Array<{ friendlyname: string; identityaddress: string; status: string }>;
        return ok({ linked: all[0] ?? null, all });
      }

      // Auto-detect: look up identities controlled by this address
      try {
        const identities = await verusid.getIdentitiesByAddress(active.address);
        if (identities.length > 0) {
          // Resolve parent names to build friendly names
          const parentCache = new Map<string, string>();
          const all = await Promise.all(identities.map(async (id) => {
            let parentName = parentCache.get(id.parent);
            if (parentName === undefined) {
              try {
                const parentResult = await verusid.getIdentity(id.parent);
                parentName = parentResult?.identity?.name ?? '';
              } catch {
                parentName = '';
              }
              parentCache.set(id.parent, parentName);
            }
            const friendlyname = parentName
              ? `${id.name}.${parentName}@`
              : `${id.name}@`;
            return {
              friendlyname,
              identityaddress: id.identityaddress,
              status: 'active',
            };
          }));
          // Cache all
          await chrome.storage.local.set({ [cacheKey]: all });
          return ok({ linked: all[0], all });
        }
      } catch {
        // RPC unavailable — no linked ID
      }

      return ok({ linked: null, all: [] });
    }

    // --- dApp Send Transaction Handlers ---

    case 'DAPP_SEND_REQUEST': {
      const MAX_COIN_AMOUNT = 200_000_000; // Verus max supply
      const payload = message.payload as { to: string; amount: number; currency?: string; _reqId?: number };
      if (!payload?.to || typeof payload.amount !== 'number' || !Number.isFinite(payload.amount) || payload.amount <= 0) {
        return fail('Invalid send request: missing to or amount');
      }
      if (payload.amount > MAX_COIN_AMOUNT) {
        return fail('Amount exceeds maximum');
      }
      if (payload.currency != null && typeof payload.currency !== 'string') {
        return fail('Invalid currency field');
      }
      if (!isValidAddress(payload.to)) {
        return fail('Invalid recipient address');
      }

      const id = crypto.randomUUID();
      const tabId = sender?.tab?.id ?? 0;
      if (!sender?.tab?.url) {
        return fail('Cannot verify request origin');
      }
      const origin = new URL(sender.tab.url).origin;

      // Per-origin popup rate limiting
      const lastSend = lastPopupByOrigin.get(origin) ?? 0;
      if (Date.now() - lastSend < POPUP_COOLDOWN_MS) {
        return fail('Please wait before making another request');
      }

      if (pendingSends.size >= MAX_PENDING_LOGINS) {
        return fail('Too many pending send requests');
      }

      const pending: PendingSendRequest & { createdAt: number } = {
        id,
        tabId,
        origin,
        to: payload.to,
        amount: payload.amount,
        currency: payload.currency || 'VRSC',
        _reqId: payload._reqId,
        createdAt: Date.now(),
      };
      pendingSends.set(id, pending);

      lastPopupByOrigin.set(origin, Date.now());
      const popup = await chrome.windows.create({
        url: `popup.html?approval=send&requestId=${id}`,
        type: 'popup',
        width: 380,
        height: 620,
      });

      if (popup?.id != null) {
        pending.windowId = popup.id;
      }

      return ok({ requestId: id });
    }

    case 'GET_PENDING_SEND': {
      const { requestId: pendingSendId } = message.payload as { requestId: string };
      const req = pendingSends.get(pendingSendId);
      if (!req) return fail('No pending send request');
      return ok({
        id: req.id,
        origin: req.origin,
        to: req.to,
        amount: req.amount,
        currency: req.currency,
      });
    }

    case 'DAPP_APPROVE_SEND': {
      const { requestId: approveSendId } = message.payload as { requestId: string };
      const pending = pendingSends.get(approveSendId);
      if (!pending) return fail('No pending send request');

      // Atomically claim: delete immediately to prevent double-approval races
      pendingSends.delete(approveSendId);

      const session = await getSession();
      if (!session) return fail('Wallet is locked');

      try {
        const active = getActiveAccount(session);
        const wif = getActiveWif(session);
        let txid: string;

        if (pending.currency === 'VRSC') {
          // Native VRSC send — convert coins to satoshis
          const [whole, frac = ''] = String(pending.amount).split('.');
          const paddedFrac = (frac + '00000000').slice(0, 8);
          const amountSat = Number(whole) * 1e8 + Number(paddedFrac);
          if (!Number.isSafeInteger(amountSat) || amountSat <= 0) {
            return fail('Amount out of range');
          }

          const scripthash = addressToScripthash(active.address);
          const rawTx = await buildTransaction(wif, scripthash, pending.to, amountSat);
          txid = await electrum.broadcastTransaction(rawTx);
        } else {
          // Currency send via Insight
          const currencyId = resolveCurrencyId(pending.currency);
          const [whole, frac = ''] = String(pending.amount).split('.');
          const paddedFrac = (frac + '00000000').slice(0, 8);
          const amountSat = Number(whole) * 1e8 + Number(paddedFrac);
          if (!Number.isSafeInteger(amountSat) || amountSat <= 0) {
            return fail('Amount out of range');
          }

          const utxos = await insight.getAddressUtxos(active.address);
          const rawTx = buildCurrencyTransaction(wif, active.address, utxos, pending.to, currencyId, amountSat);
          txid = await insight.broadcastTransaction(rawTx);
        }

        // Notify the originating tab
        if (pending.tabId) {
          chrome.tabs.sendMessage(pending.tabId, {
            type: 'DAPP_SEND_RESPONSE',
            success: true,
            txid,
            _reqId: pending._reqId,
          }).catch(() => {});
        }

        return ok({ txid });
      } catch (err) {
        // Notify the originating tab of failure (pending was already claimed)
        if (pending.tabId) {
          chrome.tabs.sendMessage(pending.tabId, {
            type: 'DAPP_SEND_RESPONSE',
            success: false,
            error: err instanceof Error ? err.message : 'Transaction failed',
            _reqId: pending._reqId,
          }).catch(() => {});
        }
        return fail(err instanceof Error ? err.message : 'Transaction failed');
      }
    }

    case 'DAPP_REJECT_SEND': {
      const { requestId: rejectSendId } = message.payload as { requestId: string };
      const pending = pendingSends.get(rejectSendId);
      if (pending?.tabId) {
        chrome.tabs.sendMessage(pending.tabId, {
          type: 'DAPP_SEND_RESPONSE',
          success: false,
          error: 'User rejected',
          _reqId: pending._reqId,
        }).catch(() => {});
      }
      pendingSends.delete(rejectSendId);
      return ok();
    }

    case 'DAPP_REJECT': {
      const { requestId: rejectId } = message.payload as { requestId: string };
      const pending = pendingLogins.get(rejectId);
      if (pending?.tabId) {
        chrome.tabs.sendMessage(pending.tabId, {
          type: 'DAPP_RESPONSE',
          success: false,
          error: 'User rejected',
          requestId: rejectId,
          _reqId: pending._reqId,
        }).catch(() => {});
      }
      pendingLogins.delete(rejectId);
      return ok();
    }

    default:
      return fail(`Unknown message type: ${(message as ExtensionMessage).type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message as ExtensionMessage, sender)
    .then(sendResponse)
    .catch(async (err) => {
      await debugLog('BG', 'UNHANDLED ERROR in handleMessage:', err);
      sendResponse(fail(err?.message ?? 'Unknown error'));
    });
  return true; // async response
});

// Clean up pending requests if approval window is closed without action
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, pending] of pendingLogins) {
    if (pending.windowId === windowId) {
      if (pending.tabId) {
        chrome.tabs.sendMessage(pending.tabId, {
          type: 'DAPP_RESPONSE',
          success: false,
          error: 'User closed approval window',
          requestId: id,
          _reqId: pending._reqId,
        }).catch(() => {});
      }
      pendingLogins.delete(id);
    }
  }

  for (const [id, pending] of pendingSends) {
    if (pending.windowId === windowId) {
      if (pending.tabId) {
        chrome.tabs.sendMessage(pending.tabId, {
          type: 'DAPP_SEND_RESPONSE',
          success: false,
          error: 'User closed approval window',
          _reqId: pending._reqId,
        }).catch(() => {});
      }
      pendingSends.delete(id);
    }
  }
});

export {};
