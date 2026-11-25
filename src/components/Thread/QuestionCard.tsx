import { ArrowLeft, ArrowRight, Check, HelpCircle, MessageSquarePlus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { QuestionItem, UserQuestionPrompt } from '../../shared/types';

interface QuestionCardProps {
  prompt: UserQuestionPrompt;
  onSubmitAnswer: (
    answers: string[],
    answersByQuestion?: Record<string, string[]>,
  ) => void;
}

function parseRecommendedOption(label: string): {
  isRecommended: boolean;
  displayLabel: string;
} {
  const match = label.match(/^\s*\(Recommended\)\s*(.*)$/i);
  if (!match) {
    return { isRecommended: false, displayLabel: label };
  }
  return {
    isRecommended: true,
    displayLabel: match[1]?.trim() || label,
  };
}

export function QuestionCard({ prompt, onSubmitAnswer }: QuestionCardProps) {
  const items: QuestionItem[] = useMemo(
    () =>
      prompt.questions && prompt.questions.length > 0
        ? prompt.questions
        : [
            {
              id: 'q-1',
              question: prompt.question,
              options: prompt.options,
              allowCustom: prompt.allowCustom,
              multiSelect: prompt.multiSelect,
            },
          ],
    [prompt],
  );

  const [activeIdx, setActiveIdx] = useState(0);
  const [selectedMap, setSelectedMap] = useState<Record<string, string[]>>({});
  const [customOpenMap, setCustomOpenMap] = useState<Record<string, boolean>>({});
  const [customTextMap, setCustomTextMap] = useState<Record<string, string>>({});

  const answered = Boolean(prompt.answer && prompt.answer.length > 0);
  const clampedIdx = Math.min(activeIdx, Math.max(0, items.length - 1));
  const current = items[clampedIdx];
  const isMultiQuestion = items.length > 1;
  const isMultiSelect = Boolean(current.multiSelect);
  const selectedForCurrent = selectedMap[current.id] ?? [];
  const customOpen = Boolean(customOpenMap[current.id]);
  const customText = customTextMap[current.id] ?? '';

  const buildEffectiveAnswers = useCallback(
    (overrideMap?: Record<string, string[]>) => {
      const map = overrideMap ?? selectedMap;
      const byQuestion: Record<string, string[]> = {};
      const flat: string[] = [];
      for (const item of items) {
        const picked = [...(map[item.id] ?? [])];
        const typed = (customTextMap[item.id] ?? '').trim();
        if (typed && (customOpenMap[item.id] || picked.length === 0)) {
          if (!picked.includes(typed)) picked.push(typed);
        }
        byQuestion[item.id] = picked;
        if (isMultiQuestion) {
          flat.push(`${item.question}: ${picked.join(', ') || '(Skipped)'}`);
        } else {
          flat.push(...picked);
        }
      }
      return { flat, byQuestion };
    },
    [customOpenMap, customTextMap, isMultiQuestion, items, selectedMap],
  );

  const handleOptionClick = (label: string) => {
    if (isMultiSelect) {
      setSelectedMap((prev) => {
        const cur = prev[current.id] ?? [];
        const next = cur.includes(label)
          ? cur.filter((x) => x !== label)
          : [...cur, label];
        return { ...prev, [current.id]: next };
      });
      return;
    }

    const nextMap = { ...selectedMap, [current.id]: [label] };
    setSelectedMap(nextMap);
    setCustomOpenMap((prev) => ({ ...prev, [current.id]: false }));

    if (!isMultiQuestion) {
      onSubmitAnswer([label]);
      return;
    }

    if (clampedIdx < items.length - 1) {
      setActiveIdx(clampedIdx + 1);
    }
  };

  const handleSubmitAll = () => {
    const { flat, byQuestion } = buildEffectiveAnswers();
    const cleanedFlat = flat.length > 0 ? flat : ['(No selection)'];
    onSubmitAnswer(cleanedFlat, byQuestion);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (answered) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key >= '1' && e.key <= '9') {
      const optIdx = Number(e.key) - 1;
      if (optIdx >= 0 && optIdx < current.options.length) {
        e.preventDefault();
        handleOptionClick(current.options[optIdx].label);
      }
    } else if (e.key === 'Enter' && (isMultiQuestion || isMultiSelect)) {
      const hasAny =
        selectedForCurrent.length > 0 || (customOpen && customText.trim().length > 0);
      if (hasAny) {
        e.preventDefault();
        if (isMultiQuestion && clampedIdx < items.length - 1) {
          setActiveIdx(clampedIdx + 1);
        } else {
          handleSubmitAll();
        }
      }
    }
  };

  const hasCurrentAnswer =
    selectedForCurrent.length > 0 || (customOpen && customText.trim().length > 0);
  const progressRatio = (clampedIdx + 1) / items.length;

  return (
    <div
      className="ag-question-card"
      tabIndex={answered ? undefined : 0}
      onKeyDown={handleKeyDown}
    >
      <div className="ag-question-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span className="ag-question-icon" aria-hidden="true">
            <HelpCircle size={14} />
          </span>
          <span className="ag-question-step-label">
            {isMultiQuestion
              ? `Question ${clampedIdx + 1} of ${items.length}`
              : 'Clarification'}
          </span>
          {isMultiSelect && !answered && (
            <span className="ag-question-mode-pill">Select multiple</span>
          )}
        </div>

        {isMultiQuestion && !answered && (
          <div className="ag-question-step-dots" role="tablist" aria-label="Question steps">
            {items.map((item, idx) => {
              const itemHasAnswer =
                (selectedMap[item.id]?.length ?? 0) > 0 ||
                Boolean((customTextMap[item.id] ?? '').trim());
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={idx === clampedIdx}
                  aria-label={`Question ${idx + 1}`}
                  className={`ag-question-dot ${
                    idx === clampedIdx ? 'active' : itemHasAnswer ? 'done' : ''
                  }`}
                  onClick={() => setActiveIdx(idx)}
                >
                  {idx + 1}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {isMultiQuestion && !answered && (
        <div className="ag-question-progress-track" aria-hidden="true">
          <div
            className="ag-question-progress-fill"
            style={{ transform: `scaleX(${progressRatio})` }}
          />
        </div>
      )}

      {answered ? (
        <div className="ag-question-answered-list">
          {items.map((item) => {
            const picked =
              prompt.answersByQuestion?.[item.id] ??
              (!isMultiQuestion ? prompt.answer : undefined) ??
              [];
            return (
              <div key={item.id} className="ag-question-answered-pill">
                <Check size={13} style={{ color: 'var(--accent-green)', flexShrink: 0 }} aria-hidden="true" />
                <span>
                  {isMultiQuestion ? `${item.question}: ` : 'Answered: '}
                  <strong>{picked.join(', ') || prompt.answer?.join(', ')}</strong>
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="ag-question-prompt-title">{current.question}</div>

          <div className="ag-question-options" role={isMultiSelect ? 'group' : 'radiogroup'}>
            {current.options.map((opt, optIdx) => {
              const { isRecommended, displayLabel } = parseRecommendedOption(opt.label);
              const isSelected = selectedForCurrent.includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  role={isMultiSelect ? 'checkbox' : 'radio'}
                  aria-checked={isSelected}
                  className={`ag-question-option pressable hover-surface${
                    isSelected ? ' selected' : ''
                  }${isRecommended ? ' recommended' : ''}`}
                  onClick={() => handleOptionClick(opt.label)}
                >
                  <span className="ag-question-keycap" aria-hidden="true">
                    {optIdx + 1}
                  </span>
                  <span className="ag-question-option-body">
                    <span className="ag-question-option-top">
                      <span className="ag-question-option-label">{displayLabel}</span>
                      {isRecommended && (
                        <span className="ag-question-recommended-badge">Recommended</span>
                      )}
                    </span>
                    {opt.description && (
                      <span className="ag-question-option-desc">{opt.description}</span>
                    )}
                  </span>
                  <span
                    className={`ag-question-indicator ${isMultiSelect ? 'square' : 'circle'}${
                      isSelected ? ' checked' : ''
                    }`}
                    aria-hidden="true"
                  >
                    {isSelected && <Check size={11} />}
                  </span>
                </button>
              );
            })}

            {current.allowCustom && (
              <button
                type="button"
                className={`ag-question-option ag-question-other-toggle pressable hover-surface${
                  customOpen ? ' selected' : ''
                }`}
                aria-expanded={customOpen}
                onClick={() =>
                  setCustomOpenMap((prev) => ({
                    ...prev,
                    [current.id]: !prev[current.id],
                  }))
                }
              >
                <span className="ag-question-keycap" aria-hidden="true">
                  <MessageSquarePlus size={11} />
                </span>
                <span className="ag-question-option-body">
                  <span className="ag-question-option-label">Other</span>
                  <span className="ag-question-option-desc">
                    Provide a custom answer or nuance
                  </span>
                </span>
              </button>
            )}
          </div>

          {current.allowCustom && (customOpen || current.options.length === 0) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!customText.trim()) return;
                if (!isMultiQuestion && !isMultiSelect) {
                  onSubmitAnswer([customText.trim()]);
                } else if (isMultiQuestion && clampedIdx < items.length - 1) {
                  setActiveIdx(clampedIdx + 1);
                } else {
                  handleSubmitAll();
                }
              }}
              style={{ display: 'flex', gap: 6 }}
            >
              <input
                type="text"
                value={customText}
                onChange={(e) =>
                  setCustomTextMap((prev) => ({ ...prev, [current.id]: e.target.value }))
                }
                placeholder="Type your custom response..."
                aria-label="Custom answer"
                style={{
                  flex: 1,
                  height: 32,
                  padding: '0 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-canvas)',
                  fontSize: 12.5,
                }}
              />
              {!isMultiQuestion && !isMultiSelect && (
                <button
                  type="submit"
                  className="pressable codex-primary-btn"
                  disabled={!customText.trim()}
                  style={{
                    height: 32,
                    padding: '0 12px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'var(--accent-primary)',
                    color: 'var(--accent-primary-fg)',
                    fontSize: 12.5,
                    fontWeight: 500,
                  }}
                >
                  Reply
                </button>
              )}
            </form>
          )}

          {(isMultiQuestion || isMultiSelect) && (
            <div className="ag-question-footer">
              <div>
                {isMultiQuestion && clampedIdx > 0 && (
                  <button
                    type="button"
                    className="pressable hover-surface"
                    onClick={() => setActiveIdx(clampedIdx - 1)}
                    style={{
                      height: 30,
                      padding: '0 10px',
                      borderRadius: 7,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-surface)',
                      fontSize: 12,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <ArrowLeft size={12} aria-hidden="true" />
                    Back
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {isMultiQuestion && clampedIdx < items.length - 1 ? (
                  <button
                    type="button"
                    className="pressable codex-primary-btn"
                    onClick={() => setActiveIdx(clampedIdx + 1)}
                    disabled={!hasCurrentAnswer}
                    style={{
                      height: 30,
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
                    Next
                    <ArrowRight size={12} aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="pressable codex-primary-btn"
                    onClick={handleSubmitAll}
                    disabled={!hasCurrentAnswer}
                    style={{
                      height: 30,
                      padding: '0 13px',
                      borderRadius: 7,
                      border: 'none',
                      background: 'var(--accent-primary)',
                      color: 'var(--accent-primary-fg)',
                      fontSize: 12,
                      fontWeight: 600,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <Check size={12} aria-hidden="true" />
                    {isMultiQuestion ? 'Submit answers' : 'Continue'}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
