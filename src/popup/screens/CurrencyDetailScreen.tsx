import React from 'react';

interface Props {
  currencyName: string;
  balance: number;
  onSend: () => void;
  onReceive: () => void;
  onBack: () => void;
}

export const CurrencyDetailScreen: React.FC<Props> = ({ currencyName, balance, onSend, onReceive, onBack }) => {
  return (
    <div className="screen currency-detail-screen">
      <button className="btn-back" onClick={onBack}>&larr; Back</button>

      <div className="currency-detail-header">
        <span className="currency-icon currency-detail-icon">
          {currencyName[0].toUpperCase()}
        </span>
        <h2>{currencyName}</h2>
      </div>

      <div className="currency-detail-balance">
        {balance.toFixed(8)} {currencyName}
      </div>

      <div className="currency-detail-actions">
        <button className="btn btn-primary" onClick={onSend}>Send</button>
        <button className="btn btn-secondary" onClick={onReceive}>Receive</button>
        <button
          className="btn btn-secondary currency-detail-swap-disabled"
          disabled
          title="Coming Soon"
        >
          Swap
        </button>
      </div>
    </div>
  );
};
