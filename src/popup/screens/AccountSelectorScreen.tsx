import React, { useEffect, useState } from 'react';
import { sendMsg } from '../App';

interface AccountInfo {
  index: number;
  address: string;
  name: string;
}

interface Props {
  onBack: () => void;
  onAccountChanged: (address: string) => void;
}

export const AccountSelectorScreen: React.FC<Props> = ({ onBack, onAccountChanged }) => {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editName, setEditName] = useState('');

  const fetchAccounts = async () => {
    const res = await sendMsg('GET_ADDRESSES');
    if (res.success && res.data) {
      const data = res.data as { accounts: AccountInfo[]; activeIndex: number };
      setAccounts(data.accounts);
      setActiveIndex(data.activeIndex);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchAccounts();
  }, []);

  const handleSwitch = async (index: number) => {
    if (editingIndex !== null) return;
    if (index === activeIndex) {
      onBack();
      return;
    }
    const res = await sendMsg('SWITCH_ADDRESS', { index });
    if (res.success && res.data) {
      const { address } = res.data as { address: string };
      onAccountChanged(address);
    }
  };

  const handleAdd = async () => {
    setAdding(true);
    const res = await sendMsg('ADD_ADDRESS');
    if (res.success) {
      await fetchAccounts();
    }
    setAdding(false);
  };

  const startRename = (e: React.MouseEvent, acc: AccountInfo) => {
    e.stopPropagation();
    setEditingIndex(acc.index);
    setEditName(acc.name);
  };

  const saveRename = async () => {
    if (editingIndex === null) return;
    await sendMsg('RENAME_ADDRESS', { index: editingIndex, name: editName });
    setEditingIndex(null);
    await fetchAccounts();
  };

  const cancelRename = () => {
    setEditingIndex(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') saveRename();
    if (e.key === 'Escape') cancelRename();
  };

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="screen account-selector-screen">
      <button className="btn-back" onClick={onBack}>&larr; Back</button>
      <h2>Accounts</h2>

      <div className="account-list">
        {accounts.map((acc) => (
          <div
            key={acc.index}
            className={`account-item ${acc.index === activeIndex ? 'account-item-active' : ''}`}
            onClick={() => handleSwitch(acc.index)}
          >
            <div className="account-item-info">
              {editingIndex === acc.index ? (
                <div className="account-rename" onClick={e => e.stopPropagation()}>
                  <input
                    type="text"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={saveRename}
                    maxLength={32}
                    autoFocus
                    className="account-rename-input"
                  />
                </div>
              ) : (
                <span className="account-item-label">
                  {acc.name}
                  <button
                    className="account-rename-btn"
                    onClick={(e) => startRename(e, acc)}
                    title="Rename"
                  >
                    &#9998;
                  </button>
                </span>
              )}
              <span className="account-item-address">{acc.address}</span>
            </div>
            {acc.index === activeIndex && (
              <span className="account-item-check">&#10003;</span>
            )}
          </div>
        ))}
      </div>

      <button
        className="btn btn-secondary add-address-btn"
        onClick={handleAdd}
        disabled={adding}
      >
        {adding ? 'Adding...' : '+ Add Address'}
      </button>
    </div>
  );
};
