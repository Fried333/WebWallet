import React, { useState, useEffect } from 'react';
import { sendMsg } from '../App';

interface Props {
  onImported: (address: string) => void;
  onBack: () => void;
}

export const ImportWalletScreen: React.FC<Props> = ({ onImported, onBack }) => {
  const [mnemonic, setMnemonic] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Clear sensitive state on unmount
  useEffect(() => {
    return () => {
      setMnemonic('');
      setPassword('');
      setConfirmPassword('');
    };
  }, []);

  const handleImport = async () => {
    setError('');

    const words = mnemonic.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      setError('Recovery phrase must be 12 or 24 words');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    const res = await sendMsg('IMPORT_WALLET', { mnemonic, password });
    setLoading(false);

    if (!res.success) {
      setError(res.error ?? 'Failed to import wallet');
      return;
    }

    const data = res.data as { address: string };
    setMnemonic('');
    setPassword('');
    setConfirmPassword('');
    onImported(data.address);
  };

  return (
    <div className="screen import-screen">
      <button className="btn-back" onClick={onBack}>&larr; Back</button>
      <h2>Import Wallet</h2>
      <p className="subtitle">Enter your recovery phrase</p>
      <textarea
        className="mnemonic-input"
        placeholder="Enter your 12 or 24 word recovery phrase..."
        value={mnemonic}
        onChange={(e) => setMnemonic(e.target.value)}
        rows={4}
        autoFocus
      />
      <input
        type="password"
        placeholder="New password (min 8 characters)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
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
        onClick={handleImport}
        disabled={loading}
      >
        {loading ? 'Importing...' : 'Import Wallet'}
      </button>
    </div>
  );
};
