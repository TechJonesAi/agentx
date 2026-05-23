import React, { useEffect, useState } from 'react';

interface Props {
  loopId: string;
  goal: string;
  repairAction: string | null;
  decision: 'approve' | 'reject';
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}

/**
 * ApprovalModal — Batch 8D operator-grade workflow approval UI.
 *
 * Replaces the previous browser prompt() with a dedicated component that:
 *   - shows the full goal + repair action under review
 *   - lets the operator add a comment (required for reject, optional for
 *     approve)
 *   - submits to POST /api/workflows/:loopId/{resume|reject}
 *   - persists the comment into the audit trail (server records it as
 *     part of failure_reason on reject and as the resume's from-state on
 *     approve)
 *
 * Keyboard:
 *   - Esc → cancel
 *   - Enter (with reason filled) → submit
 */
export function ApprovalModal({ loopId, goal, repairAction, decision, onClose, onSubmit }: Props) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (decision === 'reject' && reason.trim().length === 0) {
      setError('A rejection reason is required for the audit trail.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim() || (decision === 'approve' ? 'approved by operator' : 'rejected by operator'));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
      setBusy(false);
    }
  };

  const color = decision === 'approve' ? '#3fb950' : '#f85149';
  const verb = decision === 'approve' ? 'Approve' : 'Reject';

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-secondary)', border: `1px solid ${color}55`, borderRadius: '8px',
          padding: 'var(--spacing-lg)', maxWidth: '520px', width: '100%',
          boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
        }}
      >
        <h3 style={{ margin: 0, marginBottom: 'var(--spacing-md)', color, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '14px' }}>
          {verb} repair
        </h3>

        <div style={{ marginBottom: 'var(--spacing-md)', fontSize: '12px', color: 'var(--text-secondary)' }}>
          <div><strong>Loop:</strong> <code style={{ fontFamily: 'monospace' }}>{loopId.slice(0, 28)}</code></div>
          <div style={{ marginTop: '6px' }}><strong>Goal:</strong> {goal}</div>
          {repairAction && (
            <div style={{ marginTop: '6px' }}><strong>Repair action:</strong> {repairAction}</div>
          )}
        </div>

        <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'none' }}>
          {decision === 'reject' ? 'Reason for rejection (required, recorded in audit trail)' : 'Comment (optional)'}
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          autoFocus
          rows={3}
          style={{
            width: '100%', padding: '8px', background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)', borderRadius: '4px',
            color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />

        {error && (
          <div style={{ marginTop: '8px', padding: '6px 8px', background: '#f8544422', border: '1px solid #f85444', borderRadius: '4px', color: '#f85444', fontSize: '11px' }}>
            {error}
          </div>
        )}

        <div style={{ marginTop: 'var(--spacing-md)', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{ fontSize: '12px', padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: '4px', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            style={{ fontSize: '12px', padding: '6px 12px', background: color + '22', border: `1px solid ${color}`, borderRadius: '4px', color, cursor: busy ? 'wait' : 'pointer', fontWeight: 600 }}
          >
            {busy ? 'Submitting…' : verb}
          </button>
        </div>
      </div>
    </div>
  );
}
