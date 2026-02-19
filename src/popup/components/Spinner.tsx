import React from 'react';

export const Spinner: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <div className="swap-spinner" style={{ width: size, height: size }} />
);
