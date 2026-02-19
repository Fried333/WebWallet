import React, { useState, useEffect } from 'react';
import { sendMsg, applyTheme } from '../App';
import type { VerusIdentityInfo } from '@shared/types';

type ThemeSetting = 'light' | 'dark' | 'system';

interface Props {
  onBack: () => void;
  onLocked: () => void;
}

export const SettingsScreen: React.FC<Props> = ({ onBack, onLocked }) => {
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState<ThemeSetting>('dark');
  const [allIds, setAllIds] = useState<VerusIdentityInfo[]>([]);
  const [idLoading, setIdLoading] = useState(true);

  // Load theme preference and linked VerusID on mount; clear sensitive state on unmount
  useEffect(() => {
    chrome.storage.local.get('theme', (result) => {
      setTheme((result.theme as ThemeSetting) || 'dark');
    });
    sendMsg('GET_LINKED_VERUSID').then((res) => {
      if (res.success && res.data) {
        const data = res.data as { linked: VerusIdentityInfo | null; all?: VerusIdentityInfo[] };
        setAllIds(data.all ?? (data.linked ? [data.linked] : []));
      }
      setIdLoading(false);
    });
    return () => {
      setMnemonic('');
      setPassword('');
    };
  }, []);

  const handleThemeChange = (newTheme: ThemeSetting) => {
    setTheme(newTheme);
    applyTheme(newTheme);
    chrome.storage.local.set({ theme: newTheme });
  };

  const handleLock = async () => {
    await sendMsg('LOCK_WALLET');
    onLocked();
  };

  const handleViewPhrase = async () => {
    setError('');
    if (!password) {
      setError('Enter your password');
      return;
    }
    setLoading(true);
    const res = await sendMsg('GET_MNEMONIC', { password });
    setLoading(false);

    if (!res.success) {
      setError(res.error ?? 'Failed to decrypt');
      return;
    }

    const data = res.data as { mnemonic: string };
    setMnemonic(data.mnemonic);
    setShowMnemonic(true);
  };

  return (
    <div className="screen settings-screen">
      <button className="btn-back" onClick={onBack}>&larr; Back</button>
      <h2>Settings</h2>

      <div className="settings-section">
        <button className="btn btn-danger" onClick={handleLock}>
          Lock Wallet
        </button>
      </div>

      <div className="settings-section">
        <h3>Theme</h3>
        <div className="theme-selector">
          {(['light', 'dark', 'system'] as const).map((opt) => (
            <button
              key={opt}
              className={`theme-option${theme === opt ? ' theme-option-active' : ''}`}
              onClick={() => handleThemeChange(opt)}
            >
              {opt.charAt(0).toUpperCase() + opt.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <h3>VerusID</h3>
        {idLoading ? (
          <p className="subtitle" style={{ textAlign: 'left' }}>Detecting identities...</p>
        ) : allIds.length > 0 ? (
          <div className="phrase-unlock">
            {allIds.map((id) => (
              <div key={id.identityaddress} className="verusid-badge">
                {id.friendlyname}
              </div>
            ))}
          </div>
        ) : (
          <p className="subtitle" style={{ textAlign: 'left' }}>No VerusID found for this address</p>
        )}
      </div>

      <div className="settings-section">
        <h3>Recovery Phrase</h3>
        {showMnemonic ? (
          <div className="mnemonic-reveal">
            <div className="mnemonic-grid">
              {mnemonic.split(' ').map((w, i) => (
                <div key={i} className="mnemonic-word">
                  <span className="word-num">{i + 1}.</span> {w}
                </div>
              ))}
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => { setShowMnemonic(false); setMnemonic(''); setPassword(''); }}
            >
              Hide Phrase
            </button>
          </div>
        ) : (
          <div className="phrase-unlock">
            <p className="subtitle">Enter your password to view your recovery phrase</p>
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="error">{error}</p>}
            <button
              className="btn btn-secondary"
              onClick={handleViewPhrase}
              disabled={loading}
            >
              {loading ? 'Decrypting...' : 'View Recovery Phrase'}
            </button>
          </div>
        )}
      </div>

    </div>
  );
};
