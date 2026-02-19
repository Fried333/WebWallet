import React, { useEffect, useState, useCallback, Component } from 'react';
import type { ExtensionResponse, WalletState } from '@shared/types';

// --- Theme ---
type ThemeSetting = 'light' | 'dark' | 'system';

function resolveTheme(setting: ThemeSetting): 'light' | 'dark' {
  if (setting === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return setting;
}

export function applyTheme(setting: ThemeSetting): void {
  document.body.setAttribute('data-theme', resolveTheme(setting));
}
import { OnboardingScreen } from './screens/OnboardingScreen';
import { CreateWalletScreen } from './screens/CreateWalletScreen';
import { ImportWalletScreen } from './screens/ImportWalletScreen';
import { LockScreen } from './screens/LockScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { ReceiveScreen } from './screens/ReceiveScreen';
import { SendScreen } from './screens/SendScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TransactionDetailScreen } from './screens/TransactionDetailScreen';
import { AccountSelectorScreen } from './screens/AccountSelectorScreen';
import { ApprovalScreen } from './screens/ApprovalScreen';
import { SendApprovalScreen } from './screens/SendApprovalScreen';
import { CurrencyDetailScreen } from './screens/CurrencyDetailScreen';
import './styles.css';

// Detect approval mode from URL params
const urlParams = new URLSearchParams(window.location.search);
const approvalType = urlParams.get('approval');
const approvalRequestId = urlParams.get('requestId');

// --- Error Boundary ---
interface EBState { error: string | null }
class ErrorBoundary extends Component<{ children: React.ReactNode }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(err: Error) { return { error: err.message }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, color: 'var(--error)', fontSize: 13 }}>
          <p><strong>UI Error:</strong> {this.state.error}</p>
          <button
            style={{ marginTop: 10, padding: '6px 12px', background: 'var(--btn-secondary-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}
            onClick={() => this.setState({ error: null })}
          >Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

type Screen =
  | 'loading'
  | 'onboarding'
  | 'create'
  | 'import'
  | 'lock'
  | 'dashboard'
  | 'receive'
  | 'send'
  | 'settings'
  | 'tx-detail'
  | 'account-selector'
  | 'approval'
  | 'send-approval'
  | 'currency-detail';

export function sendMsg(type: string, payload?: unknown): Promise<ExtensionResponse> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ success: false, error: `Timeout waiting for ${type}` });
    }, 30_000);

    try {
      chrome.runtime.sendMessage({ type, payload }, (response: ExtensionResponse) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response ?? { success: false, error: 'No response from background' });
      });
    } catch (err) {
      clearTimeout(timeout);
      resolve({ success: false, error: String(err) });
    }
  });
}

const AppInner: React.FC = () => {
  const [screen, setScreen] = useState<Screen>('loading');
  const [address, setAddress] = useState<string | null>(null);
  const [selectedTxid, setSelectedTxid] = useState<string | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState<string>('VRSC');
  const [selectedCurrencyBalance, setSelectedCurrencyBalance] = useState<number>(0);

  const isApprovalMode = (approvalType === 'login' || approvalType === 'send') && !!approvalRequestId;

  const checkState = useCallback(async () => {
    const res = await sendMsg('GET_WALLET_STATE');
    if (!res.success) {
      setScreen(isApprovalMode ? 'lock' : 'onboarding');
      return;
    }

    const state = res.data as WalletState;
    if (!state.initialized) {
      setScreen('onboarding');
    } else if (state.locked) {
      setScreen('lock');
    } else {
      setAddress(state.address);
      if (isApprovalMode) {
        setScreen(approvalType === 'send' ? 'send-approval' : 'approval');
      } else {
        setScreen('dashboard');
      }
    }
  }, [isApprovalMode]);

  // Apply theme on mount
  useEffect(() => {
    chrome.storage.local.get('theme', (result) => {
      const setting = (result.theme as ThemeSetting) || 'dark';
      applyTheme(setting);
    });

    // Listen for system theme changes when set to "system"
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      chrome.storage.local.get('theme', (result) => {
        const setting = (result.theme as ThemeSetting) || 'dark';
        if (setting === 'system') applyTheme('system');
      });
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    checkState();
  }, [checkState]);

  // Reset auto-lock timer on user interaction
  useEffect(() => {
    const resetTimer = () => sendMsg('RESET_AUTO_LOCK');
    window.addEventListener('click', resetTimer);
    window.addEventListener('keydown', resetTimer);
    return () => {
      window.removeEventListener('click', resetTimer);
      window.removeEventListener('keydown', resetTimer);
    };
  }, []);

  const onWalletCreated = (addr: string) => {
    setAddress(addr);
    setScreen('dashboard');
  };

  const onUnlocked = (addr: string) => {
    setAddress(addr);
    if (isApprovalMode) {
      setScreen(approvalType === 'send' ? 'send-approval' : 'approval');
    } else {
      setScreen('dashboard');
    }
  };

  const renderScreen = () => {
    switch (screen) {
      case 'loading':
        return <div className="loading">Loading...</div>;
      case 'onboarding':
        return (
          <OnboardingScreen
            onCreateNew={() => setScreen('create')}
            onImport={() => setScreen('import')}
          />
        );
      case 'create':
        return (
          <CreateWalletScreen
            onCreated={onWalletCreated}
            onBack={() => setScreen('onboarding')}
          />
        );
      case 'import':
        return (
          <ImportWalletScreen
            onImported={onWalletCreated}
            onBack={() => setScreen('onboarding')}
          />
        );
      case 'lock':
        return <LockScreen onUnlocked={onUnlocked} onReset={() => {
          setAddress(null);
          setScreen('onboarding');
        }} />;
      case 'dashboard':
        return (
          <DashboardScreen
            address={address!}
            onSend={() => {
              setSelectedCurrency('VRSC');
              setScreen('send');
            }}
            onReceive={() => setScreen('receive')}
            onSettings={() => setScreen('settings')}
            onTxDetail={(txid) => {
              setSelectedTxid(txid);
              setScreen('tx-detail');
            }}
            onAccountSelector={() => setScreen('account-selector')}
            onCurrencySelect={(name, bal) => {
              setSelectedCurrency(name);
              setSelectedCurrencyBalance(bal);
              setScreen('currency-detail');
            }}
          />
        );
      case 'account-selector':
        return (
          <AccountSelectorScreen
            onBack={() => setScreen('dashboard')}
            onAccountChanged={(addr) => {
              setAddress(addr);
              setScreen('dashboard');
            }}
          />
        );
      case 'receive':
        return (
          <ReceiveScreen
            address={address!}
            onBack={() => setScreen('dashboard')}
          />
        );
      case 'send':
        return (
          <SendScreen
            address={address!}
            currency={selectedCurrency}
            onBack={() => setScreen('dashboard')}
            onSent={() => setScreen('dashboard')}
          />
        );
      case 'settings':
        return (
          <SettingsScreen
            onBack={() => setScreen('dashboard')}
            onLocked={() => setScreen('lock')}
          />
        );
      case 'tx-detail':
        return (
          <TransactionDetailScreen
            txid={selectedTxid!}
            onBack={() => setScreen('dashboard')}
          />
        );
      case 'currency-detail':
        return (
          <CurrencyDetailScreen
            currencyName={selectedCurrency}
            balance={selectedCurrencyBalance}
            onSend={() => setScreen('send')}
            onReceive={() => setScreen('receive')}
            onBack={() => setScreen('dashboard')}
          />
        );
      case 'approval':
        return <ApprovalScreen requestId={approvalRequestId!} />;
      case 'send-approval':
        return <SendApprovalScreen requestId={approvalRequestId!} />;
    }
  };

  return (
    <div className="wallet-container">
      <header className="wallet-header">
        <h1>Verus Wallet</h1>
      </header>
      <main className="wallet-main">
        {renderScreen()}
      </main>
    </div>
  );
};

export const App: React.FC = () => (
  <ErrorBoundary>
    <AppInner />
  </ErrorBoundary>
);
