import React, { useState } from 'react';
import { sendMsg } from '../App';
import type { FeeEstimate, TransactionSimulation } from '@shared/types';

interface Props {
  address: string;
  currency?: string;
  onBack: () => void;
  onSent: () => void;
}

type SendStep = 'input' | 'confirm' | 'result';

function satToVRSC(sat: number): string {
  return (sat / 1e8).toFixed(8);
}

function vrscToSat(vrsc: string): number {
  const trimmed = vrsc.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0;
  const parts = trimmed.split('.');
  const whole = parseInt(parts[0], 10);
  const fracStr = (parts[1] || '').padEnd(8, '0').slice(0, 8);
  const frac = parseInt(fracStr, 10);
  const sats = whole * 1e8 + frac;
  if (sats <= 0 || !Number.isSafeInteger(sats)) return 0;
  return sats;
}

export const SendScreen: React.FC<Props> = ({ address, currency = 'VRSC', onBack, onSent }) => {
  const isVRSC = currency === 'VRSC';
  const [step, setStep] = useState<SendStep>('input');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  const [simulation, setSimulation] = useState<TransactionSimulation | null>(null);
  const [resolvedAddress, setResolvedAddress] = useState('');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [txid, setTxid] = useState('');

  const resolveVerusId = async (name: string): Promise<string | null> => {
    setResolving(true);
    setError('');
    try {
      const res = await sendMsg('GET_IDENTITY', { nameOrAddress: name });
      if (res.success && res.data) {
        const data = res.data as { identity: { primaryaddresses: string[] } };
        const addr = data.identity.primaryaddresses[0];
        if (addr) {
          setResolvedAddress(addr);
          return addr;
        }
      }
      setError(res.error ?? 'VerusID not found');
      return null;
    } catch {
      setError('VerusID lookup failed');
      return null;
    } finally {
      setResolving(false);
    }
  };

  const handleRecipientBlur = async () => {
    if (recipient.trim().endsWith('@')) {
      await resolveVerusId(recipient.trim());
    } else {
      setResolvedAddress('');
    }
  };

  const handleEstimateFee = async () => {
    setError('');
    if (!recipient) {
      setError('Enter a recipient address');
      return;
    }

    // Resolve VerusID if needed
    let finalRecipient = recipient.trim();
    if (finalRecipient.endsWith('@')) {
      const resolved = resolvedAddress || await resolveVerusId(finalRecipient);
      if (!resolved) return;
      finalRecipient = resolved;
    }

    const amountSat = vrscToSat(amount);
    if (amountSat <= 0) {
      setError('Enter a valid amount');
      return;
    }

    setLoading(true);
    if (isVRSC) {
      // Run full simulation to validate the transaction before confirming
      const simRes = await sendMsg('SIMULATE_TRANSACTION', { to: finalRecipient, amount: amountSat });
      setLoading(false);

      if (!simRes.success) {
        setError(simRes.error ?? 'Simulation failed');
        return;
      }

      const sim = simRes.data as TransactionSimulation;
      setSimulation(sim);

      if (!sim.valid) {
        setError(sim.warnings[0] ?? 'Transaction would fail');
        return;
      }

      setFeeEstimate({
        feeRate: 0,
        estimatedFee: sim.feeSat,
        inputCount: sim.inputCount,
        outputCount: sim.outputCount,
      });
    } else {
      // For currency sends, fee is a fixed 0.0001 VRSC
      setFeeEstimate({ feeRate: 0, estimatedFee: 10000, inputCount: 0, outputCount: 0 });
      setSimulation(null);
      setLoading(false);
    }
    setStep('confirm');
  };

  const handleSend = async () => {
    setError('');
    setLoading(true);

    const finalAddr = resolvedAddress || recipient.trim();

    let res;
    if (isVRSC) {
      res = await sendMsg('SEND_TRANSACTION', {
        to: finalAddr,
        amount: vrscToSat(amount),
      });
    } else {
      res = await sendMsg('SEND_CURRENCY_TRANSACTION', {
        to: finalAddr,
        currencyName: currency,
        amount: parseFloat(amount),
      });
    }
    setLoading(false);

    if (!res.success) {
      setError(res.error ?? 'Transaction failed');
      return;
    }

    const data = res.data as { txid: string };
    setTxid(data.txid);
    setStep('result');
  };

  if (step === 'result') {
    return (
      <div className="screen send-screen">
        <h2>Transaction Sent</h2>
        <div className="success-icon">&#10003;</div>
        <p className="subtitle">Your transaction has been broadcast</p>
        <div className="tx-result">
          <label>Transaction ID</label>
          <p className="txid-text">{txid}</p>
        </div>
        <button className="btn btn-primary" onClick={onSent}>
          Back to Dashboard
        </button>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="screen send-screen">
        <button className="btn-back" onClick={() => setStep('input')}>&larr; Back</button>
        <h2>Confirm Transaction</h2>
        <div className="confirm-details">
          <div className="confirm-row">
            <span className="confirm-label">To</span>
            <span className="confirm-value confirm-address">
              {resolvedAddress
                ? <>{recipient.trim()}<br/>{resolvedAddress}</>
                : recipient}
            </span>
          </div>
          <div className="confirm-row">
            <span className="confirm-label">Amount</span>
            <span className="confirm-value">{amount} {currency}</span>
          </div>
          <div className="confirm-row">
            <span className="confirm-label">Fee</span>
            <span className="confirm-value">
              {feeEstimate ? satToVRSC(feeEstimate.estimatedFee) : '...'} VRSC
            </span>
          </div>
          {isVRSC && (
            <div className="confirm-row confirm-total">
              <span className="confirm-label">Total</span>
              <span className="confirm-value">
                {feeEstimate
                  ? satToVRSC(vrscToSat(amount) + feeEstimate.estimatedFee)
                  : '...'} VRSC
              </span>
            </div>
          )}
          {simulation && (
            <div className="confirm-row">
              <span className="confirm-label">Balance after</span>
              <span className="confirm-value">{satToVRSC(simulation.balanceAfterSat)} VRSC</span>
            </div>
          )}
        </div>
        {simulation?.warnings && simulation.warnings.length > 0 && (
          <div className="sim-warnings">
            {simulation.warnings.map((w, i) => (
              <p key={i} className="warning">{w}</p>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <button
          className="btn btn-primary"
          onClick={handleSend}
          disabled={loading}
        >
          {loading ? 'Sending...' : 'Confirm & Send'}
        </button>
      </div>
    );
  }

  return (
    <div className="screen send-screen">
      <button className="btn-back" onClick={onBack}>&larr; Back</button>
      <h2>Send {currency}</h2>
      <input
        type="text"
        placeholder="Recipient address or VerusID@"
        value={recipient}
        onChange={(e) => { setRecipient(e.target.value); setResolvedAddress(''); }}
        onBlur={handleRecipientBlur}
        autoFocus
      />
      {resolving && <p className="resolved-address">Resolving VerusID...</p>}
      {resolvedAddress && (
        <p className="resolved-address resolved-address-ok">
          Resolves to: {resolvedAddress.slice(0, 12)}...{resolvedAddress.slice(-6)}
        </p>
      )}
      <input
        type="text"
        placeholder={`Amount (${currency})`}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
      />
      {error && <p className="error">{error}</p>}
      <button
        className="btn btn-primary"
        onClick={handleEstimateFee}
        disabled={loading}
      >
        {loading ? 'Estimating...' : 'Continue'}
      </button>
    </div>
  );
};
