import React, { useEffect, useState } from 'react';
import { sendMsg } from '../App';
import type { TransactionSimulation } from '@shared/types';

interface Props {
  requestId: string;
}

const HIGH_VALUE_THRESHOLD = 10; // coins

function satToVRSC(sat: number): string {
  return (sat / 1e8).toFixed(8);
}

export const SendApprovalScreen: React.FC<Props> = ({ requestId }) => {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState(0);
  const [currency, setCurrency] = useState('VRSC');
  const [simulation, setSimulation] = useState<TransactionSimulation | null>(null);

  useEffect(() => {
    (async () => {
      const res = await sendMsg('GET_PENDING_SEND', { requestId });
      if (res.success) {
        const data = res.data as { id: string; origin: string; to: string; amount: number; currency: string };
        setOrigin(data.origin);
        setTo(data.to);
        setAmount(data.amount);
        setCurrency(data.currency);

        // Run simulation for VRSC sends
        if (data.currency === 'VRSC') {
          const [whole, frac = ''] = String(data.amount).split('.');
          const paddedFrac = (frac + '00000000').slice(0, 8);
          const amountSat = Number(whole) * 1e8 + Number(paddedFrac);
          const simRes = await sendMsg('SIMULATE_TRANSACTION', { to: data.to, amount: amountSat });
          if (simRes.success) {
            setSimulation(simRes.data as TransactionSimulation);
          }
        }
      } else {
        setError(res.error ?? 'Failed to load request');
      }
      setLoading(false);
    })();
  }, [requestId]);

  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);

    const res = await sendMsg('DAPP_APPROVE_SEND', { requestId });
    if (res.success) {
      window.close();
    } else {
      setError(res.error ?? 'Transaction failed');
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    await sendMsg('DAPP_REJECT_SEND', { requestId });
    window.close();
  };

  if (loading) {
    return <div className="loading">Loading request...</div>;
  }

  const isHighValue = amount >= HIGH_VALUE_THRESHOLD;

  return (
    <div className="screen approval-screen">
      <h2>Send Request</h2>

      <div className="approval-origin">
        <span className="approval-origin-label">From</span>
        <span className="approval-origin-value">{origin}</span>
      </div>

      <div className="send-amount">
        <span className="send-amount-value">{amount}</span>
        <span className="send-amount-currency">{currency}</span>
      </div>

      {isHighValue && (
        <div className="approval-warning approval-warning-high-value">
          Large transaction — verify the recipient address carefully
        </div>
      )}

      <div className="approval-details">
        <div className="approval-detail-row approval-detail-col">
          <span className="approval-detail-label">Recipient</span>
          <span className="send-recipient">{to}</span>
        </div>
        <div className="approval-detail-row">
          <span className="approval-detail-label">Amount</span>
          <span className="approval-detail-value approval-detail-mono">{amount} {currency}</span>
        </div>
        {simulation && (
          <>
            <div className="approval-detail-row">
              <span className="approval-detail-label">Fee</span>
              <span className="approval-detail-value approval-detail-mono">{satToVRSC(simulation.feeSat)} VRSC</span>
            </div>
            <div className="approval-detail-row">
              <span className="approval-detail-label">Balance after</span>
              <span className="approval-detail-value approval-detail-mono">{satToVRSC(simulation.balanceAfterSat)} VRSC</span>
            </div>
          </>
        )}
      </div>

      {simulation && !simulation.valid && (
        <div className="approval-warning">
          Transaction would fail: {simulation.warnings[0] ?? 'unknown error'}
        </div>
      )}

      {simulation?.warnings && simulation.warnings.length > 0 && simulation.valid && (
        <div className="sim-warnings">
          {simulation.warnings.map((w, i) => (
            <p key={i} className="warning">{w}</p>
          ))}
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <div className="approval-buttons">
        <button
          className="btn btn-secondary"
          onClick={handleReject}
          disabled={submitting}
        >
          Reject
        </button>
        <button
          className="btn btn-primary"
          onClick={handleApprove}
          disabled={submitting || (simulation !== null && !simulation.valid)}
        >
          {submitting ? 'Sending...' : 'Approve'}
        </button>
      </div>
    </div>
  );
};
