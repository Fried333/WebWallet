import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Spinner } from './Spinner';
import { sendMsg } from '../App';
import currencyMap from '../../data/currency-map.json';

interface Props {
  currencyBalances: { [name: string]: number };
  vrscBalance: number;
}

interface EstimateResult {
  converter: string;
  converterId: string;
  output: number;
  netInput: number;
  rate: number;
  direct?: boolean; // true when converting directly into a basket currency (no via)
}

type View = 'input' | 'confirm' | 'done';

const API_URL = 'https://api.verus.services';

function nameToId(name: string): string | undefined {
  const currencies = currencyMap.currencies as Record<string, string>;
  return Object.entries(currencies).find(([, n]) => n === name)?.[0];
}

// Check if a currency name is a basket itself
function isBasketCurrency(name: string): boolean {
  return name in (currencyMap.baskets as Record<string, unknown>);
}

function findBaskets(from: string, to: string): { name: string; id: string; direct: boolean }[] {
  const baskets = currencyMap.baskets as Record<string, { id: string; reserves: string[] }>;

  // Direct conversion: "to" is itself a basket that has "from" as a reserve
  if (baskets[to] && baskets[to].reserves.includes(from)) {
    return [{ name: to, id: baskets[to].id, direct: true }];
  }

  // Reserve-to-reserve: find baskets containing both currencies
  return Object.entries(baskets)
    .filter(([, b]) => b.reserves.includes(from) && b.reserves.includes(to))
    .map(([name, b]) => ({ name, id: b.id, direct: false }));
}

function getSwappableCurrencies(from: string): string[] {
  const baskets = currencyMap.baskets as Record<string, { id: string; reserves: string[] }>;
  const targets = new Set<string>();
  for (const [name, b] of Object.entries(baskets)) {
    if (b.reserves.includes(from)) {
      // Add reserve currencies
      for (const r of b.reserves) {
        if (r !== from) targets.add(r);
      }
      // Add the basket currency itself (direct conversion)
      if (name !== from) targets.add(name);
    }
  }
  return Array.from(targets).sort();
}

async function estimateConversion(
  fromId: string,
  toId: string,
  amount: number,
  viaId?: string,
): Promise<{ estimatedcurrencyout: number; netinputamount: number }> {
  const params: Record<string, unknown> = { currency: fromId, convertto: toId, amount };
  if (viaId) params.via = viaId;
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'estimateconversion', params: [params], id: 1 }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || 'Estimation failed');
  if (!json.result) throw new Error('No result from estimateconversion');
  return json.result;
}

export const SwapPanel: React.FC<Props> = ({ currencyBalances, vrscBalance }) => {
  const [fromCurrency, setFromCurrency] = useState('VRSC');
  const [toCurrency, setToCurrency] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [estimates, setEstimates] = useState<EstimateResult[]>([]);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<View>('input');
  const [converting, setConverting] = useState(false);
  const [txid, setTxid] = useState('');
  const quoteId = useRef(0);

  const heldCurrencies = useMemo(() => {
    const held = new Set<string>(['VRSC']);
    for (const [name, bal] of Object.entries(currencyBalances)) {
      if (bal > 0) held.add(name);
    }
    return Array.from(held).sort();
  }, [currencyBalances]);

  const toCurrencies = useMemo(() => {
    return getSwappableCurrencies(fromCurrency);
  }, [fromCurrency]);

  // Auto-fetch quote when from + amount + to are all set
  useEffect(() => {
    const amt = parseFloat(amount);
    if (!fromCurrency || !toCurrency || !amt || amt <= 0) {
      setEstimates([]);
      setError('');
      return;
    }

    const fromId = nameToId(fromCurrency);
    const toId = nameToId(toCurrency);
    if (!fromId || !toId) return;

    const baskets = findBaskets(fromCurrency, toCurrency);
    if (baskets.length === 0) {
      setError('No conversion path found');
      return;
    }

    const id = ++quoteId.current;
    setLoading(true);
    setEstimates([]);
    setError('');
    setShowAll(false);

    (async () => {
      const results: EstimateResult[] = [];
      for (const basket of baskets) {
        if (quoteId.current !== id) return;
        try {
          const res = await estimateConversion(fromId, toId, amt, basket.direct ? undefined : basket.id);
          results.push({
            converter: basket.name,
            converterId: basket.id,
            output: res.estimatedcurrencyout,
            netInput: res.netinputamount,
            rate: res.estimatedcurrencyout / res.netinputamount,
            direct: basket.direct,
          });
        } catch {
          // skip failed
        }
      }
      if (quoteId.current !== id) return;
      if (results.length === 0) {
        setError('Conversion failed. Try again later.');
      } else {
        results.sort((a, b) => b.output - a.output);
        setEstimates(results);
      }
      setLoading(false);
    })();

    return () => { quoteId.current++; };
  }, [fromCurrency, toCurrency, amount]);

  const handleFromChange = (name: string) => {
    setFromCurrency(name);
    setToCurrency('');
    setEstimates([]);
    setError('');
    setView('input');
  };

  const handleConvert = async () => {
    if (!best) return;
    const amt = parseFloat(amount);
    const fromId = nameToId(fromCurrency);
    const toId = nameToId(toCurrency);
    if (!fromId || !toId || !amt) return;

    setConverting(true);
    setError('');

    try {
      // String-based satoshi conversion to avoid floating-point precision loss
      const [whole, frac = ''] = amount.split('.');
      const amountSat = Number(whole) * 1e8 + Number((frac + '00000000').slice(0, 8));
      const res = await sendMsg('SEND_CONVERSION', {
        amountSat,
        fromCurrencyId: fromId,
        toCurrencyId: toId,
        viaCurrencyId: best.converterId,
        direct: best.direct || false,
      });
      if (res.success && res.data) {
        setTxid((res.data as { txid: string }).txid);
        setView('done');
      } else {
        setError(res.error || 'Conversion failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversion failed');
    }
    setConverting(false);
  };

  const resetSwap = () => {
    setAmount('');
    setToCurrency('');
    setEstimates([]);
    setError('');
    setTxid('');
    setView('input');
  };

  const best = estimates[0];
  const fromBalance = fromCurrency === 'VRSC' ? vrscBalance : (currencyBalances[fromCurrency] ?? 0);

  // Done view
  if (view === 'done' && txid) {
    return (
      <div className="swap-panel">
        <div className="swap-done">
          <span className="swap-done-icon">&#10003;</span>
          <span className="swap-done-title">Conversion Submitted</span>
          <span className="swap-done-txid">{txid}</span>
          <button className="btn btn-primary swap-convert-btn" onClick={resetSwap}>
            New Swap
          </button>
        </div>
      </div>
    );
  }

  // Confirm view
  if (view === 'confirm' && best) {
    const amt = parseFloat(amount);
    return (
      <div className="swap-panel">
        <button className="btn-back" onClick={() => setView('input')}>&larr; Back</button>

        <div className="swap-confirm-card">
          <div className="swap-confirm-row">
            <span className="swap-confirm-label">You send</span>
            <span className="swap-confirm-value">{amt.toFixed(8)} {fromCurrency}</span>
          </div>
          <div className="swap-confirm-row">
            <span className="swap-confirm-label">Estimated output</span>
            <span className="swap-confirm-value swap-confirm-highlight">{best.output.toFixed(8)} {toCurrency}</span>
          </div>
          <div className="swap-confirm-row">
            <span className="swap-confirm-label">Rate</span>
            <span className="swap-confirm-value">1 {fromCurrency} = {best.rate.toFixed(8)} {toCurrency}</span>
          </div>
          <div className="swap-confirm-row">
            <span className="swap-confirm-label">Via</span>
            <span className="swap-confirm-value">{best.converter}</span>
          </div>
        </div>

        {error && <p className="error">{error}</p>}

        <button
          className="btn btn-primary swap-convert-btn"
          onClick={handleConvert}
          disabled={converting}
        >
          {converting ? 'Converting...' : 'Convert Now'}
        </button>
      </div>
    );
  }

  // Input view
  return (
    <div className="swap-panel">
      {/* Compact row: From | Amount | To */}
      <div className="swap-row">
        <select
          className="swap-select-compact"
          value={fromCurrency}
          onChange={e => handleFromChange(e.target.value)}
        >
          {heldCurrencies.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <input
          type="text"
          className="swap-amount-compact"
          placeholder="0.00"
          value={amount}
          onChange={e => {
            const v = e.target.value;
            if (/^\d*\.?\d*$/.test(v)) {
              setAmount(v);
              setView('input');
            }
          }}
        />

        <span className="swap-arrow-inline">&rarr;</span>

        <select
          className="swap-select-compact"
          value={toCurrency}
          onChange={e => {
            setToCurrency(e.target.value);
            setEstimates([]);
            setError('');
            setView('input');
          }}
        >
          <option value="">To...</option>
          {toCurrencies.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      <span className="swap-balance">Bal: {fromBalance.toFixed(8)} {fromCurrency}</span>

      {/* Loading */}
      {loading && (
        <div className="swap-loading">
          <Spinner size={16} />
          <span className="swap-loading-text">Fetching rates...</span>
        </div>
      )}

      {/* Error */}
      {error && <p className="error">{error}</p>}

      {/* Best result */}
      {!loading && best && (
        <div className="swap-result-card">
          <div className="swap-result-main">
            <span className="swap-result-output">{best.output.toFixed(8)} {toCurrency}</span>
            <span className="swap-result-via">via {best.converter}</span>
          </div>
          <span className="swap-result-rate">1 {fromCurrency} = {best.rate.toFixed(8)} {toCurrency}</span>

          {estimates.length > 1 && (
            <>
              <button
                className="btn-text swap-show-all-btn"
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? 'Hide paths' : `Show all (${estimates.length})`}
              </button>
              {showAll && (
                <div className="swap-paths">
                  {estimates.map((est, i) => (
                    <div key={est.converter} className="swap-path-row">
                      <span className="swap-path-name">
                        {i === 0 && '\u2605 '}{est.converter}
                      </span>
                      <span className="swap-path-output">{est.output.toFixed(8)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          <button
            className="btn btn-primary swap-next-btn"
            onClick={() => setView('confirm')}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
};
