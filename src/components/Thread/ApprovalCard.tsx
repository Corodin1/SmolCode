import { ShieldAlert } from 'lucide-react';
import type { ApprovalDecision, ApprovalRequest } from '../../shared/types';

interface ApprovalCardProps {
  request: ApprovalRequest;
  onDecision: (requestId: string, decision: ApprovalDecision) => void;
}

export function ApprovalCard({ request, onDecision }: ApprovalCardProps) {
  return (
    <div
      role="alertdialog"
      aria-label={request.title}
      style={{
        margin: '10px 0',
        padding: 14,
        borderRadius: 12,
        border: '1px solid var(--border-strong)',
        background: 'var(--bg-elevated)',
        boxShadow: 'var(--shadow-composer)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <ShieldAlert size={16} style={{ color: 'var(--accent-amber)' }} aria-hidden="true" />
        <span style={{ fontWeight: 600, fontSize: 13 }}>{request.title}</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {request.reason}
        </span>
      </div>

      <pre
        className="mono"
        style={{
          margin: '0 0 10px 0',
          padding: '8px 10px',
          borderRadius: 8,
          background: 'var(--bg-sidebar)',
          border: '1px solid var(--border-subtle)',
          fontSize: 12.5,
          overflowX: 'auto',
        }}
      >
        {request.commandOrPath}
      </pre>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className="pressable codex-primary-btn"
          onClick={() => onDecision(request.id, 'allow-once')}
          style={{
            height: 30,
            padding: '0 12px',
            borderRadius: 8,
            border: 'none',
            background: 'var(--accent-primary)',
            color: 'var(--accent-primary-fg)',
            fontSize: 12.5,
            fontWeight: 500,
          }}
        >
          Allow once
        </button>

        <button
          type="button"
          className="pressable hover-surface"
          onClick={() => onDecision(request.id, 'allow-session')}
          style={{
            height: 30,
            padding: '0 12px',
            borderRadius: 8,
            border: '1px solid var(--border-default)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            fontSize: 12.5,
            fontWeight: 500,
          }}
        >
          Allow for session
        </button>

        <button
          type="button"
          className="pressable hover-surface"
          onClick={() => onDecision(request.id, 'deny')}
          style={{
            height: 30,
            padding: '0 12px',
            borderRadius: 8,
            border: '1px solid var(--border-subtle)',
            background: 'transparent',
            color: 'var(--accent-red)',
            fontSize: 12.5,
            fontWeight: 500,
            marginLeft: 'auto',
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
