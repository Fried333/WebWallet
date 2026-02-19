import React, { useEffect, useState } from 'react';
import { sendMsg } from '../App';
import type { VerusIdentityInfo } from '@shared/types';

interface Props {
  requestId: string;
}

export const ApprovalScreen: React.FC<Props> = ({ requestId }) => {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');
  const [challengeJson, setChallengeJson] = useState<any>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | undefined>();
  const [requestingId, setRequestingId] = useState('');
  const [requestingName, setRequestingName] = useState('');
  const [signatureVerified, setSignatureVerified] = useState<boolean | null>(null);
  const [verusId, setVerusId] = useState('');
  const [allIds, setAllIds] = useState<VerusIdentityInfo[]>([]);

  useEffect(() => {
    (async () => {
      const [loginRes, idRes] = await Promise.all([
        sendMsg('GET_PENDING_LOGIN', { requestId }),
        sendMsg('GET_LINKED_VERUSID'),
      ]);

      if (loginRes.success) {
        const data = loginRes.data as {
          id: string; origin: string; challengeJson: any;
          webhookUrl?: string; requestingId?: string; signatureVerified?: boolean;
        };
        setOrigin(data.origin);
        setChallengeJson(data.challengeJson);
        setWebhookUrl(data.webhookUrl);
        setSignatureVerified(data.signatureVerified ?? null);
        if (data.requestingId) {
          setRequestingId(data.requestingId);
          // Resolve the i-address to a friendly name
          sendMsg('GET_IDENTITY', { nameOrAddress: data.requestingId }).then((idRes) => {
            if (idRes.success && idRes.data) {
              const info = idRes.data as { friendlyname?: string; identity?: { name?: string } };
              const name = info.friendlyname || info.identity?.name;
              if (name) setRequestingName(name);
            }
          }).catch(() => {});
        }
      } else {
        setError(loginRes.error ?? 'Failed to load request');
      }

      if (idRes.success && idRes.data) {
        const data = idRes.data as { linked: VerusIdentityInfo | null; all?: VerusIdentityInfo[] };
        const ids = data.all ?? (data.linked ? [data.linked] : []);
        setAllIds(ids);
        if (ids.length > 0) {
          setVerusId(ids[0].friendlyname);
        }
      }

      setLoading(false);
    })();
  }, [requestId]);

  const handleApprove = async () => {
    if (!verusId.trim()) {
      setError('Please enter your VerusID name');
      return;
    }
    setSubmitting(true);
    setError(null);

    const res = await sendMsg('DAPP_APPROVE', {
      requestId,
      verusId: verusId.trim(),
    });

    if (res.success) {
      window.close();
    } else {
      setError(res.error ?? 'Approval failed');
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    await sendMsg('DAPP_REJECT', { requestId });
    window.close();
  };

  if (loading) {
    return <div className="loading">Loading request...</div>;
  }

  const permissions = challengeJson?.requested_access ?? [];
  const challengeId = challengeJson?.challenge_id ?? '';

  return (
    <div className="screen approval-screen">
      <h2>Login Request</h2>

      <div className="approval-origin">
        <span className="approval-origin-label">From</span>
        <span className="approval-origin-value">{origin}</span>
      </div>

      {requestingId && (
        <div className={`approval-requesting-id ${signatureVerified === true ? 'approval-sig-verified' : signatureVerified === false ? 'approval-sig-unverified' : ''}`}>
          <span className="approval-detail-label">Requesting Identity</span>
          {requestingName && (
            <span className="approval-requesting-name">{requestingName}</span>
          )}
          <span className="approval-requesting-iaddr">{requestingId}</span>
          {signatureVerified === true && (
            <span className="approval-sig-badge approval-sig-badge-ok">Signature verified</span>
          )}
          {signatureVerified === false && (
            <span className="approval-sig-badge approval-sig-badge-fail">Signature not verified — identity may be spoofed</span>
          )}
        </div>
      )}

      <div className="approval-details">
        {webhookUrl && (
          <div className="approval-detail-row approval-detail-col">
            <span className="approval-detail-label">Response will be sent to</span>
            <span className="approval-detail-value approval-detail-mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
              {webhookUrl}
            </span>
          </div>
        )}
        {challengeId && (
          <div className="approval-detail-row">
            <span className="approval-detail-label">Challenge</span>
            <span className="approval-detail-value approval-detail-mono">
              {challengeId.slice(0, 16)}...
            </span>
          </div>
        )}
        {permissions.length > 0 && (
          <div className="approval-detail-row approval-detail-col">
            <span className="approval-detail-label">Requested Access</span>
            <ul className="approval-permissions">
              {permissions.map((p: any, i: number) => (
                <li key={i}>{p.vdxfkey ?? p.qualifiedname?.name ?? 'Permission'}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {allIds.length > 1 ? (
        <div className="approval-id-input">
          <label htmlFor="verus-id">Sign as</label>
          <select
            id="verus-id"
            value={verusId}
            onChange={(e) => setVerusId(e.target.value)}
            disabled={submitting}
          >
            {allIds.map((id) => (
              <option key={id.identityaddress} value={id.friendlyname}>
                {id.friendlyname}
              </option>
            ))}
          </select>
        </div>
      ) : allIds.length === 1 ? (
        <div className="approval-id-display">
          <span className="approval-id-label">Signing as</span>
          <span className="approval-id-name">{verusId}</span>
        </div>
      ) : (
        <div className="approval-id-input">
          <label htmlFor="verus-id">VerusID Name</label>
          <input
            id="verus-id"
            type="text"
            placeholder="e.g. MyName@"
            value={verusId}
            onChange={(e) => setVerusId(e.target.value)}
            disabled={submitting}
            autoFocus
          />
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <div className="approval-buttons">
        <button
          className="btn btn-secondary"
          onClick={handleReject}
          disabled={submitting}
        >
          Reject
        </button>
        <button
          className="btn btn-primary"
          onClick={handleApprove}
          disabled={submitting || !verusId.trim() || signatureVerified === false}
        >
          {submitting ? 'Signing...' : 'Approve'}
        </button>
      </div>
    </div>
  );
};
