# Verus Web Wallet

A self-custodial Chrome Extension wallet for Verus (VRSC) and PBaaS currencies. Built as a Manifest V3 extension with TypeScript and React.

## Features

- **Send & Receive** VRSC and all PBaaS currencies (DAI.vETH, vETH, tBTC.vETH, etc.)
- **DeFi Swaps** via Verus protocol-level currency conversion (no smart contracts)
- **VerusID Login** with cryptographic challenge verification
- **dApp Integration** via `window.verus` provider and `verus://` deep link interception
- **Multi-Account** HD wallet (BIP39/BIP44, up to 100 derived accounts)
- **Dark / Light / System** theme support

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm (included with Node.js)

## Build

```bash
# Install dependencies
npm install

# Build for production
npm run build
```

The built extension will be in the `dist/` directory.

## Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

## Development

```bash
# Watch mode (rebuilds on file changes)
npm run dev

# Validate crypto libraries
npm run validate
```

## Project Structure

```
src/
  background/       Service worker — key management, signing, message routing
  core/
    keychain.ts      BIP39 mnemonic + BIP32 HD key derivation
    vault.ts         AES-256-GCM vault encryption (PBKDF2 900k iterations)
    transaction.ts   P2PKH + ReserveTransfer (conversion) tx builder
    currency-transaction.ts   PBaaS token (CC output) tx builder
    electrum.ts      Electrum proxy client (balance, UTXOs, broadcast)
    insight.ts       Insight API client (CC-aware tx history, token balances)
    verusid.ts       VerusID RPC client (identity lookups)
  popup/
    screens/         13 UI screens (Dashboard, Send, Receive, Swap, Settings, etc.)
    components/      SwapPanel, Spinner
    styles.css       All styles
  content-script/    Extension <-> page bridge (message relay)
  injected/          window.verus provider + deep link interception
  shared/types.ts    Shared TypeScript interfaces
  data/              Static currency routing map

vendor/
  utxo-lib/          VerusCoin fork of @bitgo/utxo-lib (pre-compiled dist only)
  bitcoin-ops/       VerusCoin fork with evals.json
```

## Vendor Libraries

The `vendor/` directory contains VerusCoin-specific forks that are not published on npm. They are included as pre-compiled build artifacts so `npm install` can resolve them locally:

- **utxo-lib** — forked from [VerusCoin/BitGoJS](https://github.com/ArkTechHub/BitGoJS) (`utxo-lib-verus` branch). Provides ECPair, HDNode, TransactionBuilder, and Verus network configuration (pubKeyHash `0x3c`, Sapling v4 transactions, Zcash Blake2b signing).
- **bitcoin-ops** — forked from [VerusCoin/bitcoin-ops](https://github.com/ArkTechHub/bitcoin-ops). Adds `evals.json` with CryptoCondition eval codes used by Verus.

All other dependencies are fetched from npm when you run `npm install`.

## Security

- **Vault**: AES-256-GCM + PBKDF2-SHA256 (900,000 iterations)
- **Key storage**: `chrome.storage.session` (memory-only, never persists unencrypted)
- **Mnemonic**: never stored — only entropy is vaulted, mnemonic reconstructed on demand
- **Key zeroing**: seed and keypair buffers actively zeroed after use
- **Brute-force protection**: exponential backoff on failed unlock attempts
- **Post-build tx verification**: signed transactions verified against user intent before broadcast
- **dApp isolation**: content script allowlist, origin validation, webhook SSRF protection
- **No eval()**: fully MV3 compliant, no remote code execution
- **Pure JS**: all crypto libraries are pure JavaScript (no WASM, no native bindings)

## Network

The wallet communicates with public Verus infrastructure only:

| Endpoint | Purpose |
|----------|---------|
| `el0-3.verus.io` | Electrum proxy (balance, UTXOs, fee estimation, broadcast) |
| `insight.verus.io` | Insight API (token balances, CC-aware tx history) |
| `api.verus.services` | Verus RPC (VerusID lookups, conversion estimates) |

No custom backend. No user data collection. Fully client-side.

## License

See individual `LICENSE` files in `vendor/` subdirectories for vendor library licenses.
