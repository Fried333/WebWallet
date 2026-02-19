// Shared types for the Verus Web Wallet

// --- Wallet State ---

export interface Account {
  index: number;
  address: string;
}

export interface WalletState {
  locked: boolean;
  initialized: boolean;
  address: string | null;
  accountCount: number;
}

export interface SessionData {
  seed: number[]; // BIP39 seed as byte array (mutable, can be zeroed — unlike hex strings)
  accounts: Account[];
  activeIndex: number;
}

// --- Electrum / Blockchain ---

export interface Balance {
  confirmed: number;   // satoshis
  unconfirmed: number; // satoshis
  lastUpdated: number; // timestamp ms
}

export interface UTXO {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number; // satoshis
}

export interface CurrencyTransfer {
  currency: string;  // human-readable name (e.g. "bitcoins")
  amount: number;    // coins (not satoshis), positive = received, negative = sent
}

export interface ConversionInfo {
  fromCurrency: string;   // human-readable name (e.g. "VRSC")
  toCurrency: string;     // human-readable name (e.g. "vETH")
  viaCurrency: string;    // basket name (e.g. "Bridge.vETH")
  fromAmount: number;     // coins (not satoshis)
  fee: number;            // conversion fee in coins
}

export interface TransactionSummary {
  txid: string;
  height: number;
  value: number;     // VRSC satoshis, positive = received, negative = sent
  timestamp?: number;
  confirmed: boolean;
  currencyTransfers?: CurrencyTransfer[]; // non-VRSC currency amounts in this tx
  conversionInfo?: ConversionInfo;        // present if this is a swap/conversion tx (outbound)
  isSwapIn?: boolean;                     // true if this is an import (received converted currency)
}

export interface FeeEstimate {
  feeRate: number;    // sat/KB
  estimatedFee: number; // satoshis for the specific tx
  inputCount: number;
  outputCount: number;
}

// --- Transaction Simulation ---

export interface TransactionSimulation {
  valid: boolean;
  amountSat: number;       // amount being sent (satoshis)
  feeSat: number;          // mining fee (satoshis)
  changeSat: number;       // change returned (satoshis)
  inputCount: number;      // UTXOs consumed
  outputCount: number;     // outputs created
  totalInputSat: number;   // total value of all inputs
  balanceAfterSat: number; // estimated remaining balance after tx
  warnings: string[];      // human-readable warnings
}

// --- Settings ---

export interface WalletSettings {
  autoLockMinutes: number;
}

// --- Message Types ---

export type MessageType =
  | 'CREATE_WALLET'
  | 'IMPORT_WALLET'
  | 'UNLOCK_WALLET'
  | 'LOCK_WALLET'
  | 'GET_WALLET_STATE'
  | 'GET_BALANCE'
  | 'GET_TRANSACTIONS'
  | 'GET_RECEIVE_ADDRESS'
  | 'ESTIMATE_FEE'
  | 'SEND_TRANSACTION'
  | 'SIMULATE_TRANSACTION'
  | 'GET_MNEMONIC'
  | 'RESET_AUTO_LOCK'
  | 'RESET_WALLET'
  | 'ADD_ADDRESS'
  | 'SWITCH_ADDRESS'
  | 'GET_ADDRESSES'
  | 'RENAME_ADDRESS'
  | 'PING'
  | 'DAPP_LOGIN_DEEPLINK'
  | 'DAPP_APPROVE'
  | 'DAPP_REJECT'
  | 'GET_PENDING_LOGIN'
  | 'GET_CURRENCY_BALANCES'
  | 'SEND_CURRENCY_TRANSACTION'
  | 'SEND_CONVERSION'
  | 'GET_IDENTITY'
  | 'SET_LINKED_VERUSID'
  | 'GET_LINKED_VERUSID'
  | 'DAPP_SEND_REQUEST'
  | 'GET_PENDING_SEND'
  | 'DAPP_APPROVE_SEND'
  | 'DAPP_REJECT_SEND';

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}

export interface ExtensionResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

// --- dApp Login Types ---

export interface PendingLoginRequest {
  id: string;
  uri: string;
  tabId: number;
  origin: string;
  windowId?: number;
  /** Serialized challenge JSON for display in approval popup */
  challengeJson: unknown;
  /** The webhook URL where the signed response will be POSTed */
  webhookUrl?: string;
  /** The i-address of the identity that signed the login challenge (the requesting party) */
  requestingId?: string;
  /** Cached result of challenge signature verification (undefined = not yet checked) */
  signatureVerified?: boolean;
  _reqId?: number;      // for promise resolution back to page
}

// --- dApp Send Types ---

export interface PendingSendRequest {
  id: string;
  tabId: number;
  origin: string;
  to: string;           // receiving address
  amount: number;       // coins (not satoshis)
  currency: string;     // 'VRSC' or currency name
  windowId?: number;
  _reqId?: number;      // for promise resolution back to page
}

// --- Message Payloads ---

export interface CreateWalletPayload {
  password: string;
}

export interface ImportWalletPayload {
  mnemonic: string;
  password: string;
}

export interface UnlockWalletPayload {
  password: string;
}

export interface SendTransactionPayload {
  to: string;
  amount: number; // satoshis
}

export interface SendConversionPayload {
  amountSat: number;       // amount in satoshis
  fromCurrencyId: string;  // i-address of source currency
  toCurrencyId: string;    // i-address of target currency
  viaCurrencyId: string;   // i-address of basket (conversion path)
  direct?: boolean;        // true when converting directly into a basket (no via)
}

export interface GetMnemonicPayload {
  password: string;
}

// --- Currency / Insight Types ---

/** Map of currency name → balance in coins (not satoshis) */
export interface CurrencyBalances {
  [currencyName: string]: number;
}

export interface InsightUTXO {
  address: string;
  txid: string;
  vout: number;
  scriptPubKey: string;
  amount: number;    // coins
  satoshis: number;
  height: number;
  confirmations: number;
}

export interface SendCurrencyPayload {
  to: string;
  currencyName: string;
  amount: number; // coins (not satoshis)
}

// --- VerusID Types ---

export interface VerusIdentityInfo {
  friendlyname: string;     // e.g. "player3.bitcoins@"
  identityaddress: string;  // i-address
  status: string;
}
