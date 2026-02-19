import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface Props {
  address: string;
  onBack: () => void;
}

export const ReceiveScreen: React.FC<Props> = ({ address, onBack }) => {
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="screen receive-screen">
      <button className="btn-back" onClick={onBack}>&larr; Back</button>
      <h2>Receive VRSC</h2>
      <p className="subtitle">Share this address to receive Verus</p>

      <div className="qr-container">
        <QRCodeSVG
          value={address}
          size={200}
          bgColor="#ffffff"
          fgColor="#000000"
          level="M"
        />
      </div>

      <div className="address-display" onClick={copyAddress}>
        <p className="full-address">{address}</p>
        <button className="btn btn-secondary copy-btn">
          {copied ? 'Copied!' : 'Copy Address'}
        </button>
      </div>
    </div>
  );
};
