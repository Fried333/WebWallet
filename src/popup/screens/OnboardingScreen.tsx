import React from 'react';

interface Props {
  onCreateNew: () => void;
  onImport: () => void;
}

export const OnboardingScreen: React.FC<Props> = ({ onCreateNew, onImport }) => (
  <div className="screen onboarding-screen">
    <div className="onboarding-logo">V</div>
    <h2>Welcome to Verus Wallet</h2>
    <p className="subtitle">Self-custodial VRSC wallet</p>
    <div className="onboarding-buttons">
      <button className="btn btn-primary" onClick={onCreateNew}>
        Create New Wallet
      </button>
      <button className="btn btn-secondary" onClick={onImport}>
        Import Existing Wallet
      </button>
    </div>
  </div>
);
