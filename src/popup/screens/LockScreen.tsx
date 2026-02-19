import React, { useState, useEffect } from 'react';
import { sendMsg } from '../App';

interface Props {
  onUnlocked: (address: string) => void;
  onReset: () => void;
}

export const LockScreen: React.FC<Props> = ({ onUnlocked, onReset }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Clear sensitive state on unmount
  useEffect(() => {
    return () => {
      setPassword('');
    };
  }, []);

  const handleUnlock = async () => {
    setError('');
    if (!password) return;

    setLoading(true);
    const res = await sendMsg('UNLOCK_WALLET', { password });
    setLoading(false);

    if (!res.success) {
      setError(res.error ?? 'Incorrect password');
      return;
    }

    const data = res.data as { address: string };
    setPassword('');
    onUnlocked(data.address);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleUnlock();
  };

  return (
    <div className="screen lock-screen">
      <div className="lock-icon">🔒</div>
      <h2>Wallet Locked</h2>
      <p className="subtitle">Enter your password to unlock</p>
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      {error && <p className="error">{error}</p>}
      <button
        className="btn btn-primary"
        onClick={handleUnlock}
        disabled={loading}
      >
        {loading ? 'Unlocking...' : 'Unlock'}
      </button>

      {!showResetConfirm ? (
        <button
          className="btn btn-text reset-wallet-btn"
          onClick={() => setShowResetConfirm(true)}
        >
          Reset Wallet
        </button>
      ) : (
        <div className="reset-confirm">
          <p className="reset-warning">This will permanently delete your wallet. Make sure you have your recovery phrase backed up.</p>
          <div className="reset-confirm-buttons">
            <button className="btn btn-danger" onClick={async () => {
              const res = await sendMsg('RESET_WALLET');
              if (res.success) {
                onReset();
              }
            }}>
              Yes, Reset Wallet
            </button>
            <button className="btn btn-secondary" onClick={() => {
              setShowResetConfirm(false);
            }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
