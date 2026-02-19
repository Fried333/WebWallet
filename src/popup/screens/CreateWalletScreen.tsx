import React, { useState, useEffect } from 'react';
import { sendMsg } from '../App';

interface Props {
  onCreated: (address: string) => void;
  onBack: () => void;
}

type Step = 'password' | 'mnemonic' | 'confirm';

export const CreateWalletScreen: React.FC<Props> = ({ onCreated, onBack }) => {
  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [copied, setCopied] = useState(false);
  const [clipboardTimer, setClipboardTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  // Confirmation step state
  const [confirmIndices, setConfirmIndices] = useState<number[]>([]);
  const [confirmAnswers, setConfirmAnswers] = useState<Record<number, string>>({});

  // Clear sensitive state on unmount
  useEffect(() => {
    return () => {
      setPassword('');
      setConfirmPassword('');
      setMnemonic('');
      if (clipboardTimer) clearTimeout(clipboardTimer);
    };
  }, []);

  const handleCreatePassword = async () => {
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    const res = await sendMsg('CREATE_WALLET', { password });
    setLoading(false);

    if (!res.success) {
      setError(res.error ?? 'Failed to create wallet');
      return;
    }

    const data = res.data as { mnemonic: string; address: string };
    setMnemonic(data.mnemonic);
    setAddress(data.address);

    // Pick 3 random word indices for confirmation
    const words = data.mnemonic.split(' ');
    const indices: number[] = [];
    while (indices.length < 3) {
      const idx = Math.floor(Math.random() * words.length);
      if (!indices.includes(idx)) indices.push(idx);
    }
    indices.sort((a, b) => a - b);
    setConfirmIndices(indices);

    setStep('mnemonic');
  };

  const handleConfirmMnemonic = () => {
    setStep('confirm');
  };

  const handleVerify = () => {
    const words = mnemonic.split(' ');
    for (const idx of confirmIndices) {
      if ((confirmAnswers[idx] ?? '').trim().toLowerCase() !== words[idx]) {
        setError(`Word #${idx + 1} is incorrect`);
        return;
      }
    }
    // Clear sensitive data before navigating
    setMnemonic('');
    setPassword('');
    setConfirmPassword('');
    onCreated(address);
  };

  if (step === 'password') {
    return (
      <div className="screen create-screen">
        <button className="btn-back" onClick={onBack}>&larr; Back</button>
        <h2>Create New Wallet</h2>
        <p className="subtitle">Set a password to encrypt your wallet</p>
        <input
          type="password"
          placeholder="Password (min 8 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          placeholder="Confirm password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button
          className="btn btn-primary"
          onClick={handleCreatePassword}
          disabled={loading}
        >
          {loading ? 'Creating...' : 'Continue'}
        </button>
      </div>
    );
  }

  if (step === 'mnemonic') {
    const words = mnemonic.split(' ');
    return (
      <div className="screen create-screen">
        <h2>Recovery Phrase</h2>
        <p className="subtitle">Write down these 24 words in order. Keep them safe!</p>
        <div className="mnemonic-grid">
          {words.map((w, i) => (
            <div key={i} className="mnemonic-word">
              <span className="word-num">{i + 1}.</span> {w}
            </div>
          ))}
        </div>
        <button
          className="btn btn-secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(mnemonic);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
            // Auto-clear clipboard after 30 seconds
            if (clipboardTimer) clearTimeout(clipboardTimer);
            const timer = setTimeout(() => {
              navigator.clipboard.writeText('').catch(() => {});
            }, 30_000);
            setClipboardTimer(timer);
          }}
        >
          {copied ? 'Copied!' : 'Copy Recovery Phrase'}
        </button>
        <button className="btn btn-primary" onClick={handleConfirmMnemonic}>
          I've Written It Down
        </button>
      </div>
    );
  }

  // Confirm step
  return (
    <div className="screen create-screen">
      <h2>Verify Recovery Phrase</h2>
      <p className="subtitle">Enter the requested words to confirm you saved your phrase</p>
      {confirmIndices.map((idx) => (
        <div key={idx} className="confirm-word-row">
          <label>Word #{idx + 1}</label>
          <input
            type="text"
            placeholder={`Enter word #${idx + 1}`}
            value={confirmAnswers[idx] ?? ''}
            onChange={(e) =>
              setConfirmAnswers((prev) => ({ ...prev, [idx]: e.target.value }))
            }
          />
        </div>
      ))}
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary" onClick={handleVerify}>
        Verify & Continue
      </button>
    </div>
  );
};
