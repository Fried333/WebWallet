import React, { useEffect, useState, useCallback } from 'react';
import { sendMsg } from '../App';
import type { Balance, TransactionSummary, CurrencyBalances, VerusIdentityInfo } from '@shared/types';
import { SwapPanel } from '../components/SwapPanel';

interface Props {
  address: string;
  onSend: () => void;
  onReceive: () => void;
  onSettings: () => void;
  onTxDetail: (txid: string) => void;
  onAccountSelector: () => void;
  onCurrencySelect: (name: string, balance: number) => void;
}

function satToVRSC(sat: number): string {
  if (typeof sat !== 'number' || isNaN(sat)) return '0.00000000';
  return (sat / 1e8).toFixed(8);
}

type Tab = 'currencies' | 'swap' | 'activity';

export const DashboardScreen: React.FC<Props> = ({ address, onSend, onReceive, onSettings, onTxDetail, onAccountSelector, onCurrencySelect }) => {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [currencyBalances, setCurrencyBalances] = useState<CurrencyBalances>({});
  const [txs, setTxs] = useState<TransactionSummary[]>([]);
  const [linkedId, setLinkedId] = useState<VerusIdentityInfo | null>(null);
  const [accountName, setAccountName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('currencies');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [balRes, txRes, currRes, idRes, addrRes] = await Promise.all([
        sendMsg('GET_BALANCE'),
        sendMsg('GET_TRANSACTIONS'),
        sendMsg('GET_CURRENCY_BALANCES'),
        sendMsg('GET_LINKED_VERUSID'),
        sendMsg('GET_ADDRESSES'),
      ]);

      if (balRes.success && balRes.data) {
        setBalance(balRes.data as Balance);
      } else if (balRes.error) {
        setError(balRes.error);
      }

      if (txRes.success && Array.isArray(txRes.data)) {
        setTxs(txRes.data as TransactionSummary[]);
      }

      if (currRes.success && currRes.data) {
        setCurrencyBalances(currRes.data as CurrencyBalances);
      }

      if (idRes.success && idRes.data) {
        setLinkedId((idRes.data as { linked: VerusIdentityInfo | null }).linked);
      }

      if (addrRes.success && addrRes.data) {
        const addrData = addrRes.data as { accounts: Array<{ index: number; address: string; name: string }>; activeIndex: number };
        const active = addrData.accounts.find(a => a.index === addrData.activeIndex);
        if (active) setAccountName(active.name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    }

    setLoading(false);
  }, [address]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const [copiedTarget, setCopiedTarget] = useState<'address' | 'id' | null>(null);

  const copyToClipboard = (text: string, target: 'address' | 'id') => {
    navigator.clipboard.writeText(text);
    setCopiedTarget(target);
    setTimeout(() => setCopiedTarget(null), 1500);
  };

  return (
    <div className="screen dashboard-screen">
      <div className="dashboard-top">
        <button className="btn-icon account-selector-btn" onClick={onAccountSelector} title="Accounts">
          &#9862;
        </button>
        <button className="btn-icon settings-btn" onClick={onSettings} title="Settings">
          &#9881;
        </button>
      </div>

      <div className="balance-section">
        {accountName && <p className="account-name-label">{accountName}</p>}
        <p className="balance-label">Balance</p>
        {loading ? (
          <p className="balance-amount">Loading...</p>
        ) : (
          <>
            <p className="balance-amount">
              {balance ? satToVRSC(balance.confirmed) : '0.00000000'} VRSC
            </p>
            {balance && balance.unconfirmed !== 0 && (
              <p className="balance-pending">
                {balance.unconfirmed > 0 ? '+' : ''}{satToVRSC(balance.unconfirmed)} pending
              </p>
            )}
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div className={`address-bar${copiedTarget === 'address' ? ' address-bar-copied' : ''}`} onClick={() => copyToClipboard(address, 'address')}>
        <span className="address-text">{copiedTarget === 'address' ? 'Copied' : address}</span>
      </div>

      {linkedId && (
        <div className="verusid-badge" onClick={() => copyToClipboard(linkedId.friendlyname, 'id')}>
          {copiedTarget === 'id' ? 'Copied' : linkedId.friendlyname}
        </div>
      )}

      <div className="action-buttons">
        <button className="btn btn-primary" onClick={() => onSend()}>Send</button>
        <button className="btn btn-secondary" onClick={onReceive}>Receive</button>
      </div>

      <div className="dashboard-tabs">
        <button
          className={`dashboard-tab${activeTab === 'currencies' ? ' dashboard-tab-active' : ''}`}
          onClick={() => setActiveTab('currencies')}
        >
          Currencies
        </button>
        <button
          className={`dashboard-tab${activeTab === 'swap' ? ' dashboard-tab-active' : ''}`}
          onClick={() => setActiveTab('swap')}
        >
          Swap
        </button>
        <button
          className={`dashboard-tab${activeTab === 'activity' ? ' dashboard-tab-active' : ''}`}
          onClick={() => setActiveTab('activity')}
        >
          Activity
        </button>
      </div>

      <div className="tab-content">
        {activeTab === 'currencies' && (
          <div className="currency-list">
            <div
              className="currency-row"
            >
              <div className="currency-info">
                <span className="currency-icon">V</span>
                <span className="currency-name">VRSC</span>
              </div>
              <div className="currency-balance">
                <span className="currency-confirmed">
                  {balance ? satToVRSC(balance.confirmed) : '0.00000000'}
                </span>
                {balance && balance.unconfirmed !== 0 && (
                  <span className="currency-unconfirmed">
                    {balance.unconfirmed > 0 ? '+' : ''}{satToVRSC(balance.unconfirmed)} pending
                  </span>
                )}
              </div>
            </div>
            {Object.entries(currencyBalances)
              .filter(([name, bal]) => name !== 'VRSC' && bal > 0)
              .map(([name, bal]) => {
                // Compute pending amount from unconfirmed txs with this currency
                const pendingAmount = txs
                  .filter(tx => !tx.confirmed && tx.currencyTransfers)
                  .reduce((sum, tx) => {
                    const ct = tx.currencyTransfers!.find(c => c.currency === name);
                    return ct ? sum + ct.amount : sum;
                  }, 0);
                return (
                  <div
                    key={name}
                    className="currency-row currency-row-clickable"
                    onClick={() => onCurrencySelect(name, bal)}
                  >
                    <div className="currency-info">
                      <span className="currency-icon">{name[0].toUpperCase()}</span>
                      <span className="currency-name">{name}</span>
                    </div>
                    <div className="currency-balance">
                      <span className="currency-confirmed">{bal.toFixed(8)}</span>
                      {pendingAmount !== 0 && (
                        <span className="currency-unconfirmed">
                          {pendingAmount > 0 ? '+' : ''}{pendingAmount} pending
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        )}

        {activeTab === 'swap' && (
          <SwapPanel
            currencyBalances={currencyBalances}
            vrscBalance={balance ? balance.confirmed / 1e8 : 0}
          />
        )}

        {activeTab === 'activity' && (
          <div className="tx-section">
            {txs.length === 0 ? (
              <p className="tx-empty">No transactions yet</p>
            ) : (
              <div className="tx-list">
                {txs.slice(0, 20).map((tx, i) => (
                  <div
                    key={tx.txid || i}
                    className="tx-item tx-item-clickable"
                    onClick={() => tx.txid && onTxDetail(tx.txid)}
                  >
                    <div className="tx-left">
                      {tx.conversionInfo ? (
                        <span className="tx-amount tx-out">
                          <span className="tx-swap-badge">Swap Out</span>
                          {satToVRSC(tx.value)} VRSC
                        </span>
                      ) : tx.isSwapIn && tx.currencyTransfers && tx.currencyTransfers.length > 0 ? (
                        <>
                          {tx.currencyTransfers.filter(ct => ct.amount > 0).map((ct, ci) => (
                            <span key={ci} className="tx-amount tx-in">
                              <span className="tx-swap-badge tx-swap-in-badge">Swap In</span>
                              +{ct.amount.toFixed(8)} {ct.currency}
                            </span>
                          ))}
                        </>
                      ) : tx.currencyTransfers && tx.currencyTransfers.length > 0 ? (
                        <>
                          {tx.currencyTransfers.map((ct, ci) => (
                            <span key={ci} className={`tx-amount ${ct.amount >= 0 ? 'tx-in' : 'tx-out'}`}>
                              {ct.amount >= 0 ? '+' : ''}{ct.amount.toFixed(8)} {ct.currency}
                            </span>
                          ))}
                          {tx.value !== 0 && (
                            <span className={`tx-amount tx-fee-line ${tx.value >= 0 ? 'tx-in' : 'tx-out'}`}>
                              {tx.value >= 0 ? '+' : ''}{satToVRSC(tx.value)} VRSC
                            </span>
                          )}
                        </>
                      ) : (
                        <span className={`tx-amount ${tx.value >= 0 ? 'tx-in' : 'tx-out'}`}>
                          {tx.value >= 0 ? '+' : ''}{satToVRSC(tx.value)} VRSC
                        </span>
                      )}
                      <span className="tx-id">{tx.txid ? `${tx.txid.slice(0, 16)}...` : 'unknown'}</span>
                    </div>
                    <div className="tx-right">
                      <span className={`tx-status ${tx.confirmed ? 'tx-confirmed' : 'tx-pending'}`}>
                        {tx.confirmed ? 'Confirmed' : 'Pending'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <button className="btn btn-text refresh-btn" onClick={fetchData}>
        Refresh
      </button>
    </div>
  );
};
