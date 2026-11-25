import { ArrowLeft, Pencil, Plus, Search, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { useState } from 'react';
import type { ProjectRecord, SkillEntry } from '../../shared/types';

interface SkillsViewProps {
  project: ProjectRecord | null;
  skills: SkillEntry[];
  onBack: () => void;
  onUseSkill: (skill: SkillEntry) => void;
  onCreateSkill: (input: {
    projectId?: string;
    scope: 'repo' | 'global';
    name: string;
    description: string;
    content: string;
    tags?: string[];
  }) => Promise<void>;
  onUpdateSkill?: (input: {
    projectId?: string;
    scope: 'repo' | 'global';
    name: string;
    description: string;
    content: string;
    tags?: string[];
  }) => Promise<void>;
  onDeleteSkill?: (sourcePath: string, projectId?: string) => Promise<void>;
  onGenerateWithAi?: () => void;
}

type ScopeFilter = 'all' | 'repo' | 'global' | 'builtin';

export function SkillsView({
  project,
  skills,
  onBack,
  onUseSkill,
  onCreateSkill,
  onUpdateSkill,
  onDeleteSkill,
  onGenerateWithAi,
}: SkillsViewProps) {
  const [query, setQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(skills[0]?.id ?? null);
  const [formMode, setFormMode] = useState<'closed' | 'create' | 'edit'>('closed');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [scope, setScope] = useState<'repo' | 'global'>(project ? 'repo' : 'global');
  const [content, setContent] = useState(
    '## Instructions\n\n1. Inspect target files.\n2. Apply changes cleanly.\n3. Verify before finishing.',
  );
  const [saving, setSaving] = useState(false);
  const [previewResource, setPreviewResource] = useState<{
    file: string;
    content: string;
  } | null>(null);

  const filtered = skills.filter((s) => {
    if (scopeFilter !== 'all' && s.scope !== scopeFilter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      (s.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  });
  const selected = filtered.find((s) => s.id === selectedId) ?? filtered[0] ?? null;

  const openCreateForm = (prefill?: SkillEntry) => {
    if (prefill) {
      setName(prefill.name);
      setDescription(prefill.description);
      setTagsText((prefill.tags ?? []).join(', '));
      setScope(project ? 'repo' : 'global');
      setContent(prefill.content);
      setFormMode('create');
    } else {
      setName('');
      setDescription('');
      setTagsText('');
      setScope(project ? 'repo' : 'global');
      setContent('## Instructions\n\n1. Inspect target files.\n2. Apply changes cleanly.');
      setFormMode('create');
    }
  };

  const openEditForm = (skill: SkillEntry) => {
    if (skill.scope === 'builtin') {
      openCreateForm(skill);
      return;
    }
    setName(skill.name);
    setDescription(skill.description);
    setTagsText((skill.tags ?? []).join(', '));
    setScope(skill.scope);
    setContent(skill.content);
    setFormMode('edit');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;
    const tags = tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      if (formMode === 'edit' && onUpdateSkill) {
        await onUpdateSkill({
          projectId: project?.id,
          scope,
          name: name.trim(),
          description: description.trim(),
          content: content.trim(),
          tags,
        });
      } else {
        await onCreateSkill({
          projectId: project?.id,
          scope,
          name: name.trim(),
          description: description.trim(),
          content: content.trim(),
          tags,
        });
      }
      setFormMode('closed');
      setName('');
      setDescription('');
      setTagsText('');
    } finally {
      setSaving(false);
    }
  };

  const handlePreviewCompanion = async (skill: SkillEntry, relFile: string) => {
    if (!window.smolcode?.readSkillResource) return;
    try {
      const text = await window.smolcode.readSkillResource(skill.sourcePath, relFile);
      setPreviewResource({ file: relFile, content: text });
    } catch {
      setPreviewResource({ file: relFile, content: '(Unable to read resource file)' });
    }
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
          gap: 12,
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
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Skills</h1>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              Loaded from `.smolcode/skills`, `.agents/skills`, `.codex/skills`, `~/.smolcode/skills`, and built-in starters
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onGenerateWithAi && (
            <button
              type="button"
              className="pressable hover-surface"
              onClick={onGenerateWithAi}
              style={{
                height: 32,
                padding: '0 12px',
                borderRadius: 8,
                border: '1px solid var(--border-default)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                fontSize: 12.5,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Wand2 size={13} style={{ color: 'var(--accent-brand)' }} aria-hidden="true" />
              <span>Generate with AI</span>
            </button>
          )}
          <button
            type="button"
            className="pressable codex-primary-btn"
            onClick={() =>
              formMode === 'closed' ? openCreateForm() : setFormMode('closed')
            }
            style={{
              height: 32,
              padding: '0 12px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--accent-primary)',
              color: 'var(--accent-primary-fg)',
              fontSize: 12.5,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Plus size={14} aria-hidden="true" />
            <span>New skill</span>
          </button>
        </div>
      </div>

      {formMode !== 'closed' && (
        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-sidebar)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 0.8fr 130px', gap: 10 }}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Skill slug (e.g. pr-review)"
              disabled={formMode === 'edit'}
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
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When should the agent use this skill?"
              style={{
                height: 32,
                padding: '0 10px',
                borderRadius: 8,
                border: '1px solid var(--border-default)',
                background: 'var(--bg-canvas)',
                fontSize: 12.5,
              }}
            />
            <input
              type="text"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="Tags (comma separated)"
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
              value={scope}
              onChange={(e) => setScope(e.target.value as 'repo' | 'global')}
              disabled={formMode === 'edit'}
              style={{
                height: 32,
                padding: '0 8px',
                borderRadius: 8,
                border: '1px solid var(--border-default)',
                background: 'var(--bg-canvas)',
                fontSize: 12.5,
              }}
            >
              {project && <option value="repo">Workspace</option>}
              <option value="global">Global</option>
            </select>
          </div>
          <textarea
            rows={5}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
            className="mono"
            style={{
              width: '100%',
              padding: 10,
              borderRadius: 8,
              border: '1px solid var(--border-default)',
              background: 'var(--bg-canvas)',
              fontSize: 12,
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              className="pressable hover-surface"
              onClick={() => setFormMode('closed')}
              style={{
                height: 30,
                padding: '0 12px',
                borderRadius: 8,
                border: '1px solid var(--border-default)',
                background: 'transparent',
                fontSize: 12.5,
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="pressable codex-primary-btn"
              disabled={saving}
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
              {formMode === 'edit' ? 'Save changes' : 'Create SKILL.md'}
            </button>
          </div>
        </form>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left List */}
        <div
          style={{
            width: 300,
            borderRight: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ padding: 12, borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              className="codex-input-shell"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                height: 32,
                padding: '0 10px',
                borderRadius: 8,
                border: '1px solid var(--border-default)',
                background: 'var(--bg-surface)',
              }}
            >
              <Search size={13} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills..."
                aria-label="Search skills"
                style={{
                  flex: 1,
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  fontSize: 12.5,
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: 4 }}>
              {(['all', 'repo', 'global', 'builtin'] as ScopeFilter[]).map((sc) => {
                const active = scopeFilter === sc;
                return (
                  <button
                    key={sc}
                    type="button"
                    className="pressable hover-surface"
                    onClick={() => setScopeFilter(sc)}
                    style={{
                      flex: 1,
                      height: 24,
                      borderRadius: 6,
                      border: active
                        ? '1px solid var(--accent-brand)'
                        : '1px solid var(--border-subtle)',
                      background: active ? 'var(--accent-brand-soft)' : 'transparent',
                      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                      fontSize: 11,
                      fontWeight: 500,
                      textTransform: 'capitalize',
                    }}
                  >
                    {sc === 'repo' ? 'Workspace' : sc === 'builtin' ? 'Built-in' : sc}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {filtered.length === 0 ? (
              <p style={{ padding: 16, textAlign: 'center', fontSize: 12.5, color: 'var(--text-muted)' }}>
                No matching skills found.
              </p>
            ) : (
              filtered.map((sk) => {
                const isSel = selected?.id === sk.id;
                return (
                  <button
                    key={sk.id}
                    type="button"
                    className="pressable hover-surface"
                    onClick={() => {
                      setSelectedId(sk.id);
                      setPreviewResource(null);
                    }}
                    style={{
                      width: '100%',
                      padding: '9px 10px',
                      borderRadius: 9,
                      border: isSel ? '1px solid var(--border-subtle)' : '1px solid transparent',
                      background: isSel ? 'var(--bg-surface-active)' : 'transparent',
                      textAlign: 'left',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      marginBottom: 2,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
                        /{sk.name}
                      </span>
                      <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{sk.scope}</span>
                    </div>
                    {sk.description && (
                      <span
                        style={{
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {sk.description}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right Detail */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {selected ? (
            <div style={{ maxWidth: 680 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 14,
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Sparkles size={16} style={{ color: 'var(--accent-blue)' }} aria-hidden="true" />
                  <h2 className="mono" style={{ margin: 0, fontSize: 16 }}>
                    /{selected.name}
                  </h2>
                  <span className="codex-pill" style={{ height: 22, fontSize: 11 }}>
                    {selected.scope}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    className="pressable hover-surface"
                    onClick={() => openEditForm(selected)}
                    style={{
                      height: 30,
                      padding: '0 10px',
                      borderRadius: 8,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-surface)',
                      fontSize: 12,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <Pencil size={12} aria-hidden="true" />
                    <span>{selected.scope === 'builtin' ? 'Customize' : 'Edit'}</span>
                  </button>
                  {selected.scope !== 'builtin' && onDeleteSkill && (
                    <button
                      type="button"
                      className="pressable hover-surface"
                      onClick={() => void onDeleteSkill(selected.sourcePath, project?.id)}
                      aria-label={`Delete skill ${selected.name}`}
                      style={{
                        height: 30,
                        padding: '0 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border-subtle)',
                        background: 'transparent',
                        color: 'var(--accent-red)',
                        fontSize: 12,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                      }}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      <span>Delete</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="pressable codex-primary-btn"
                    onClick={() => onUseSkill(selected)}
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
                    Use in composer
                  </button>
                </div>
              </div>
              {selected.description && (
                <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--text-secondary)' }}>
                  {selected.description}
                </p>
              )}
              {selected.tags && selected.tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {selected.tags.map((tag) => (
                    <span key={tag} className="codex-pill mono" style={{ height: 21, fontSize: 10.5 }}>
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
                {selected.sourcePath}
              </div>

              {selected.companionFiles && selected.companionFiles.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    Companion Files
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {selected.companionFiles.map((rf) => (
                      <button
                        key={rf}
                        type="button"
                        className="ag-file-pill mono pressable"
                        onClick={() => void handlePreviewCompanion(selected, rf)}
                      >
                        {rf}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {previewResource && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 4 }} className="mono">
                    {previewResource.file}
                  </div>
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: 12,
                      borderRadius: 10,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-canvas)',
                      fontSize: 12,
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {previewResource.content}
                  </pre>
                </div>
              )}

              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: 14,
                  borderRadius: 10,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-sidebar)',
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {selected.content}
              </pre>
            </div>
          ) : (
            <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Select a skill to inspect or create a new one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
