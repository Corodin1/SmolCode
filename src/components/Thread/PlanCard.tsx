import { Check, CheckCircle2, ListChecks, Loader2, Play } from 'lucide-react';
import type { StructuredPlan } from '../../shared/types';

interface PlanCardProps {
  plan: StructuredPlan;
  disabled?: boolean;
  onApproveAndImplement: () => void;
}

export function PlanCard({ plan, disabled, onApproveAndImplement }: PlanCardProps) {
  const doneCount = plan.steps.filter((s) => s.status === 'done').length;

  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid var(--border-default)',
        background: 'var(--bg-elevated)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <ListChecks size={15} style={{ color: 'var(--accent-blue)', flexShrink: 0 }} aria-hidden="true" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>{plan.title}</span>
        </div>

        {plan.approved ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span className="mono tabular-nums" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {doneCount}/{plan.steps.length} steps
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11.5,
                fontWeight: 500,
                color: 'var(--accent-green)',
              }}
            >
              <CheckCircle2 size={13} aria-hidden="true" />
              <span>Approved</span>
            </span>
          </div>
        ) : (
          <button
            type="button"
            className="pressable codex-primary-btn"
            disabled={disabled}
            onClick={onApproveAndImplement}
            style={{
              height: 28,
              padding: '0 12px',
              borderRadius: 7,
              border: 'none',
              background: 'var(--accent-primary)',
              color: 'var(--accent-primary-fg)',
              fontSize: 12,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <Play size={11} aria-hidden="true" />
            <span>Implement plan</span>
          </button>
        )}
      </div>

      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {plan.summary && (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
            {plan.summary}
          </p>
        )}

        <ol
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {plan.steps.map((step, idx) => {
            const isInProgress = step.status === 'in_progress';
            const isDone = step.status === 'done';
            return (
              <li
                key={step.id}
                data-status={step.status}
                className={isInProgress ? 'ag-plan-step-active' : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  fontSize: 13,
                  color: isDone ? 'var(--text-secondary)' : 'var(--text-primary)',
                  padding: isInProgress ? '4px 6px' : '2px 0',
                  borderRadius: 7,
                }}
              >
                <span
                  className="mono tabular-nums"
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: isInProgress
                      ? '1px solid var(--accent-brand)'
                      : '1px solid var(--border-default)',
                    background: isDone
                      ? 'var(--accent-green-soft)'
                      : isInProgress
                        ? 'var(--accent-brand-soft)'
                        : 'var(--bg-surface)',
                    color: isDone
                      ? 'var(--accent-green)'
                      : isInProgress
                        ? 'var(--accent-brand)'
                        : 'var(--text-muted)',
                    fontSize: 10.5,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  {isDone ? (
                    <Check size={10} aria-hidden="true" />
                  ) : isInProgress ? (
                    <Loader2 size={10} className="codex-spinner" aria-hidden="true" />
                  ) : (
                    idx + 1
                  )}
                </span>
                <span className={isInProgress ? 'shimmer-text' : undefined}>{step.title}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
