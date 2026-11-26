import { useEffect, useState } from 'react';
import type {
  AgentStreamEvent,
  ApprovalRequest,
  ThreadRecord,
  TurnRecord,
} from '../shared/types';

export function useAgentStream(params: {
  activeThreadId: string | null;
  onThreadStatusChange: (
    threadId: string,
    patch: Partial<ThreadRecord>,
  ) => void;
  onThreadReplaced: (thread: ThreadRecord) => void;
  onTurnFinished: (threadId: string, threadTitle?: string) => void;
  onApprovalRequested?: (request: ApprovalRequest) => void;
}) {
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [queueState, setQueueState] = useState<{
    activeThreadId: string | null;
    queuedThreadIds: string[];
  }>({ activeThreadId: null, queuedThreadIds: [] });

  useEffect(() => {
    if (!params.activeThreadId || !window.smolcode) {
      return;
    }
    let cancelled = false;
    void window.smolcode.listTurns(params.activeThreadId).then((loaded) => {
      if (!cancelled) setTurns(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [params.activeThreadId]);

  useEffect(() => {
    if (!window.smolcode) return;
    return window.smolcode.onAgentEvent((ev: AgentStreamEvent) => {
      if (ev.type === 'queue_updated') {
        setQueueState({
          activeThreadId: ev.activeThreadId,
          queuedThreadIds: ev.queuedThreadIds,
        });
        return;
      }

      if (ev.type === 'thread_status') {
        params.onThreadStatusChange(ev.threadId, { status: ev.status });
        return;
      }

      if (ev.type === 'thread_updated') {
        params.onThreadReplaced(ev.thread);
        return;
      }

      if (ev.type === 'approval_requested') {
        setPendingApprovals((prev) => [...prev, ev.request]);
        params.onApprovalRequested?.(ev.request);
        return;
      }

      if (ev.type === 'turn_created') {
        if (ev.threadId === params.activeThreadId) {
          setTurns((prev) =>
            prev.some((t) => t.id === ev.turn.id) ? prev : [...prev, ev.turn],
          );
        }
        return;
      }

      if (ev.type === 'thinking_delta') {
        if (ev.threadId === params.activeThreadId) {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === ev.turnId
                ? { ...t, thinking: (t.thinking ?? '') + ev.delta }
                : t,
            ),
          );
        }
        return;
      }

      if (ev.type === 'content_delta') {
        if (ev.threadId === params.activeThreadId) {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === ev.turnId ? { ...t, content: t.content + ev.delta } : t,
            ),
          );
        }
        return;
      }

      if (ev.type === 'tool_update') {
        if (ev.threadId === params.activeThreadId) {
          setTurns((prev) =>
            prev.map((t) => {
              if (t.id !== ev.turnId) return t;
              const existing = t.toolCalls ?? [];
              const idx = existing.findIndex((c) => c.id === ev.tool.id);
              const nextCalls =
                idx === -1
                  ? [...existing, ev.tool]
                  : existing.map((c, i) => (i === idx ? ev.tool : c));
              return { ...t, toolCalls: nextCalls };
            }),
          );
        }
        return;
      }

      if (ev.type === 'plan_proposed' || ev.type === 'plan_updated') {
        if (ev.threadId === params.activeThreadId) {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === ev.turnId ? { ...t, plan: ev.plan } : t,
            ),
          );
        }
        return;
      }

      if (ev.type === 'question_requested') {
        if (ev.threadId === params.activeThreadId) {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === ev.turnId ? { ...t, questionPrompt: ev.prompt } : t,
            ),
          );
        }
        return;
      }

      if (ev.type === 'image_generated') {
        if (ev.threadId === params.activeThreadId) {
          setTurns((prev) =>
            prev.map((t) => {
              if (t.id !== ev.turnId) return t;
              const existing = t.generatedImages ?? [];
              if (existing.some((img) => img.id === ev.image.id)) return t;
              return { ...t, generatedImages: [...existing, ev.image] };
            }),
          );
        }
        return;
      }

      if (ev.type === 'turn_completed') {
        params.onThreadStatusChange(ev.threadId, {
          status: 'idle',
          unread: ev.threadId !== params.activeThreadId,
          ...(ev.threadTitle ? { title: ev.threadTitle } : {}),
        });
        if (ev.threadId === params.activeThreadId) {
          setTurns((prev) =>
            prev.map((t) => (t.id === ev.turn.id ? ev.turn : t)),
          );
        }
        setPendingApprovals((prev) =>
          prev.filter((r) => r.threadId !== ev.threadId),
        );
        params.onTurnFinished(ev.threadId, ev.threadTitle);
        return;
      }

      if (ev.type === 'turn_error') {
        params.onThreadStatusChange(ev.threadId, { status: 'error' });
        if (ev.threadId === params.activeThreadId) {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === ev.turnId ? { ...t, content: ev.message } : t,
            ),
          );
        }
        setPendingApprovals((prev) =>
          prev.filter((r) => r.threadId !== ev.threadId),
        );
      }
    });
  }, [params]);

  const clearApproval = (requestId: string) => {
    setPendingApprovals((prev) => prev.filter((r) => r.id !== requestId));
  };

  const markQuestionAnsweredLocal = (
    turnId: string,
    answers: string[],
    answersByQuestion?: Record<string, string[]>,
  ) => {
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turnId && t.questionPrompt
          ? {
              ...t,
              questionPrompt: {
                ...t.questionPrompt,
                answer: answers,
                ...(answersByQuestion ? { answersByQuestion } : {}),
              },
            }
          : t,
      ),
    );
  };

  const markPlanApprovedLocal = (turnId: string) => {
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turnId && t.plan
          ? { ...t, plan: { ...t.plan, approved: true } }
          : t,
      ),
    );
  };

  return {
    turns: params.activeThreadId ? turns : [],
    setTurns,
    pendingApprovals,
    clearApproval,
    markQuestionAnsweredLocal,
    markPlanApprovedLocal,
    queueState,
  };
}
