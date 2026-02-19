import React, { useEffect, useState } from 'react';
import { sendMsg } from '../App';
import type { TransactionSummary } from '@shared/types';

interface Props {
  txid: string;
  onBack: () => void;
}

function satToVRSC(sat: number): string {
  if (typeof sat !== 'number' || isNaN(sat)) return '0.00000000';
  return (sat / 1e8).toFixed(8);
}

export const TransactionDetailScreen: React.FC<Props> = ({ txid, onBack }) => {
  const [tx, setTx] = useState<TransactionSummary | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await sendMsg('GET_TRANSACTIONS');
      if (res.success && Array.isArray(res.data)) {
        const found = (res.data as TransactionSummary[]).find((t) => t.txid === txid);
        if (found) setTx(found);
      }
    })();
  }, [txid]);

  const copyTxid = async () => {
    await navigator.clipboard.writeText(txid);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const openExplorer = () => {
    if (!/^[a-fA-F0-9]{64}$/.test(txid)) return;
    chrome.tabs.create({ url: `https://explorer.verus.io/tx/${txid}` });
  };

  return (
    <div className="screen tx-detail-screen">
      <button className="btn-back" onClick={onBack}>&larr; Back</button>
      <h2>Transaction Details</h2>

      {tx ? (
        <>
          <div className="tx-detail-amount-section">
            {tx.conversionInfo ? (
              <>
                <span className="tx-detail-amount tx-out">
                  {satToVRSC(tx.value)} VRSC
                </span>
                <span className="tx-detail-direction tx-swap-direction">Swap Out</span>
              </>
            ) : tx.isSwapIn && tx.currencyTransfers && tx.currencyTransfers.length > 0 ? (
              <>
                {tx.currencyTransfers.filter(ct => ct.amount > 0).map((ct, ci) => (
                  <span key={ci} className="tx-detail-amount tx-in">
                    +{ct.amount.toFixed(8)} {ct.currency}
                  </span>
                ))}
                <span className="tx-detail-direction tx-swap-direction">Swap In</span>
              </>
            ) : tx.currencyTransfers && tx.currencyTransfers.length > 0 ? (
              <>
                {tx.currencyTransfers.map((ct, ci) => (
                  <span key={ci} className={`tx-detail-amount ${ct.amount >= 0 ? 'tx-in' : 'tx-out'}`}>
                    {ct.amount >= 0 ? '+' : ''}{ct.amount.toFixed(8)} {ct.currency}
                  </span>
                ))}
                {tx.value !== 0 && (
                  <span className={`tx-detail-amount tx-fee-line ${tx.value >= 0 ? 'tx-in' : 'tx-out'}`}>
                    {tx.value >= 0 ? '+' : ''}{satToVRSC(tx.value)} VRSC (fee)
                  </span>
                )}
              </>
            ) : (
              <span className={`tx-detail-amount ${tx.value >= 0 ? 'tx-in' : 'tx-out'}`}>
                {tx.value >= 0 ? '+' : ''}{satToVRSC(tx.value)} VRSC
              </span>
            )}
            {!tx.conversionInfo && (
              <span className={`tx-detail-direction ${(tx.currencyTransfers?.[0]?.amount ?? tx.value) >= 0 ? 'tx-in' : 'tx-out'}`}>
                {(tx.currencyTransfers?.[0]?.amount ?? tx.value) >= 0 ? 'Received' : 'Sent'}
              </span>
            )}
          </div>

          {tx.conversionInfo && (
            <div className="tx-detail-conversion">
              <div className="tx-detail-conv-row">
                <span className="tx-detail-label">Converting</span>
                <span>{tx.conversionInfo.fromAmount} {tx.conversionInfo.fromCurrency}</span>
              </div>
              <div className="tx-detail-conv-row">
                <span className="tx-detail-label">To</span>
                <span>{tx.conversionInfo.toCurrency}</span>
              </div>
              <div className="tx-detail-conv-row">
                <span className="tx-detail-label">Via</span>
                <span>{tx.conversionInfo.viaCurrency}</span>
              </div>
              {tx.conversionInfo.fee > 0 && (
                <div className="tx-detail-conv-row">
                  <span className="tx-detail-label">Conversion Fee</span>
                  <span>{tx.conversionInfo.fee} {tx.conversionInfo.fromCurrency}</span>
                </div>
              )}
            </div>
          )}

          <div className="tx-detail-info">
            <div className="tx-detail-row">
              <span className="tx-detail-label">Status</span>
              <span className={tx.confirmed ? 'tx-confirmed' : 'tx-pending'}>
                {tx.confirmed ? 'Confirmed' : 'Pending'}
              </span>
            </div>

            {tx.height > 0 && (
              <div className="tx-detail-row">
                <span className="tx-detail-label">Block Height</span>
                <span>{tx.height.toLocaleString()}</span>
              </div>
            )}

            <div className="tx-detail-row tx-detail-row-col">
              <span className="tx-detail-label">Transaction ID</span>
              <span className="tx-detail-txid" onClick={copyTxid} title="Click to copy">
                {txid}
              </span>
              <span className="copy-hint">{copied ? 'Copied!' : 'Click to copy'}</span>
            </div>
          </div>

          <button className="btn btn-primary" onClick={openExplorer}>
            View on Explorer
          </button>
        </>
      ) : (
        <p className="loading">Loading...</p>
      )}
    </div>
  );
};
