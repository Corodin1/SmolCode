import { ArrowLeft, ExternalLink, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { AutomationRule, ProjectRecord } from '../../shared/types';
import { formatRelativeTime } from '../../utils/audio-notify';

interface AutomationsViewProps {
  project: ProjectRecord | null;
  projects: ProjectRecord[];
  automations: AutomationRule[];
  onBack: () => void;
  onSaveAutomation: (rule: Partial<AutomationRule> & { projectId: string }) => Promise<void>;
  onDeleteAutomation: (id: string) => Promise<void>;
  onRunAutomationNow: (id: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}

const TEMPLATES = [
  {
    name: 'Test & Typecheck Sweep',
    cronExpr: '0 * * * *',
    prompt: 'Run project tests and typecheck, diagnose any regressions, and propose fixes.',
  },
  {
    name: 'Security & Code Audit',
    cronExpr: '0 9 * * *',
    prompt: 'Inspect workspace files and dependencies for security or error-handling gaps.',
  },
];

const SCHEDULE_PRESETS = [
  { label: 'Every 15m', cron: '*/15 * * * *' },
  { label: 'Every 30m', cron: '*/30 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 9am', cron: '0 9 * * *' },
];

export function AutomationsView({
  project,
  projects,
  automations,
  onBack,
  onSaveAutomation,
  onDeleteAutomation,
  onRunAutomationNow,
  onOpenThread,
}: AutomationsViewProps) {
  const [targetProjectId, setTargetProjectId] = useState(project?.id ?? projects[0]?.id ?? '');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cronExpr, setCronExpr] = useState('0 * * * *');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const pid = targetProjectId || project?.id || projects[0]?.id;
    if (!pid || !name.trim() || !prompt.trim()) return;
    await onSaveAutomation({
      projectId: pid,
      name: name.trim(),
      prompt: prompt.trim(),
      cronExpr: cronExpr.trim() || '0 * * * *',
      enabled: true,
    });
    setName('');
    setPrompt('');
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 24px',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="pressable hover-surface"
            onClick={onBack}
            style={{
              height: 30,
              padding: '0 10px',
              borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-surface)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
            }}
          >
            <ArrowLeft size={13} aria-hidden="true" />
            <span>Thread</span>
          </button>
          <div>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Automations</h1>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              Scheduled background tasks running in your local workspaces
            </p>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Quick Templates */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.name}
                type="button"
                className="codex-pill pressable hover-surface"
                onClick={() => {
                  setName(tpl.name);
                  setPrompt(tpl.prompt);
                  setCronExpr(tpl.cronExpr);
                }}
              >
                <Plus size={11} aria-hidden="true" />
                <span>{tpl.name}</span>
              </button>
            ))}
          </div>

          {/* Create Automation Form */}
          <form
            onSubmit={(e) => void handleCreate(e)}
            style={{
              padding: 16,
              borderRadius: 12,
              border: '1px solid var(--border-default)',
              background: 'var(--bg-elevated)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 8 }}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Automation name (e.g. Nightly test sweep)"
                required
                style={{
                  height: 32,
                  padding: '0 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-canvas)',
                  fontSize: 12.5,
                }}
              />
              <select
                value={targetProjectId || project?.id || ''}
                onChange={(e) => setTargetProjectId(e.target.value)}
                aria-label="Target workspace"
                style={{
                  height: 32,
                  padding: '0 8px',
                  borderRadius: 8,
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-canvas)',
                  fontSize: 12.5,
                }}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {SCHEDULE_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  className="codex-pill pressable hover-surface"
                  onClick={() => setCronExpr(p.cron)}
                  style={{
                    height: 24,
                    fontSize: 11.5,
                    borderColor: cronExpr === p.cron ? 'var(--border-strong)' : 'var(--border-subtle)',
                    background: cronExpr === p.cron ? 'var(--bg-surface-active)' : 'var(--bg-surface)',
                  }}
                >
                  {p.label}
                </button>
              ))}
              <input
                type="text"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                className="mono"
                aria-label="Cron expression"
                style={{
                  width: 130,
                  height: 26,
                  padding: '0 8px',
                  borderRadius: 7,
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-canvas)',
                  fontSize: 11.5,
                }}
              />
            </div>

            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Instruction prompt for this scheduled run..."
              required
              style={{
                width: '100%',
                padding: 10,
                borderRadius: 8,
                border: '1px solid var(--border-default)',
                background: 'var(--bg-canvas)',
                fontSize: 12.5,
              }}
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="submit"
                className="pressable codex-primary-btn"
                disabled={!projects.length || !name.trim() || !prompt.trim()}
                style={{
                  height: 30,
                  padding: '0 14px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--accent-primary)',
                  color: 'var(--accent-primary-fg)',
                  fontSize: 12.5,
                  fontWeight: 500,
                }}
              >
                Create automation
              </button>
            </div>
          </form>

          {/* Active Rules */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {automations.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                No scheduled automations configured yet.
              </div>
            ) : (
              automations.map((rule) => {
                const proj = projects.find((p) => p.id === rule.projectId);
                return (
                  <div
                    key={rule.id}
                    style={{
                      padding: 14,
                      borderRadius: 11,
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-elevated)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) =>
                        void onSaveAutomation({ ...rule, enabled: e.target.checked })
                      }
                      aria-label={`Enable automation ${rule.name}`}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{rule.name}</span>
                        {proj && (
                          <span className="codex-pill" style={{ height: 20, fontSize: 11 }}>
                            {proj.name}
                          </span>
                        )}
                        <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {rule.cronExpr}
                        </span>
                      </div>
                      <p
                        style={{
                          margin: '3px 0 4px',
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {rule.prompt}
                      </p>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        Status: {rule.lastStatus}
                        {rule.lastRunAt ? ` · last run ${formatRelativeTime(rule.lastRunAt)}` : ''}
                      </div>
                    </div>

                    {rule.lastThreadId && (
                      <button
                        type="button"
                        className="pressable hover-surface"
                        onClick={() => onOpenThread(rule.lastThreadId!)}
                        style={{
                          height: 28,
                          padding: '0 10px',
                          borderRadius: 7,
                          border: '1px solid var(--border-subtle)',
                          background: 'var(--bg-surface)',
                          fontSize: 12,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                        }}
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                        <span>View thread</span>
                      </button>
                    )}

                    <button
                      type="button"
                      className="pressable hover-surface"
                      onClick={() => void onRunAutomationNow(rule.id)}
                      aria-label={`Run ${rule.name} now`}
                      title="Run now"
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 7,
                        border: '1px solid var(--border-subtle)',
                        background: 'var(--bg-surface)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Play size={13} aria-hidden="true" />
                    </button>

                    <button
                      type="button"
                      className="pressable hover-surface"
                      onClick={() => void onDeleteAutomation(rule.id)}
                      aria-label={`Delete ${rule.name}`}
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 7,
                        border: '1px solid var(--border-subtle)',
                        background: 'transparent',
                        color: 'var(--accent-red)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
