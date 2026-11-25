import { randomUUID } from 'node:crypto';
import type {
  ComposerChip,
  TurnRecord,
  UndoDiffFile,
  UndoDiffLine,
  UndoExecutionResult,
  UndoPreviewResult,
} from '../../src/shared/types';
import type { SmolCodeStore } from './database';
import type { SnapshotDiffFile, SnapshotManager } from './snapshots';

export interface ResolvedUndoTarget {
  targetTurn: TurnRecord;
  rollbackStartTurn: TurnRecord;
  pairedAssistantTurn?: TurnRecord;
  snapshotId: string | null;
  restoredPrompt: string;
  restoredChips: ComposerChip[];
  turnsToRemove: TurnRecord[];
}

interface RedoBufferEntry {
  redoId: string;
  threadId: string;
  workdir: string;
  preUndoSnapshotId: string | null;
  removedTurns: TurnRecord[];
  prevDraftText: string;
  prevDraftChips: ComposerChip[];
  createdAt: number;
}

const MAX_DIFF_LINES_PER_FILE = 240;
const MAX_REDO_ENTRIES = 12;

export function resolveUndoTarget(turns: TurnRecord[], turnId: string): ResolvedUndoTarget {
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx === -1) {
    throw new Error(`Turn not found: ${turnId}`);
  }
  const targetTurn = turns[idx];

  if (targetTurn.role === 'user') {
    const next = turns[idx + 1];
    const pairedAssistantTurn = next?.role === 'assistant' ? next : undefined;
    const snapshotId = pairedAssistantTurn?.snapshotId ?? targetTurn.snapshotId ?? null;
    return {
      targetTurn,
      rollbackStartTurn: targetTurn,
      pairedAssistantTurn,
      snapshotId,
      restoredPrompt: targetTurn.content,
      restoredChips: targetTurn.chips ?? [],
      turnsToRemove: turns.slice(idx),
    };
  }

  const prev = idx > 0 ? turns[idx - 1] : undefined;
  const pairedUser = prev?.role === 'user' ? prev : undefined;
  const rollbackStartTurn = pairedUser ?? targetTurn;
  const startIdx = pairedUser ? idx - 1 : idx;

  return {
    targetTurn,
    rollbackStartTurn,
    pairedAssistantTurn: targetTurn,
    snapshotId: targetTurn.snapshotId ?? null,
    restoredPrompt: pairedUser?.content ?? '',
    restoredChips: pairedUser?.chips ?? [],
    turnsToRemove: turns.slice(startIdx),
  };
}

function mapSnapshotDiffFile(file: SnapshotDiffFile): UndoDiffFile {
  const flatLines: UndoDiffLine[] = [];
  for (const line of file.hunks) {
    if (line.type === 'hunk') continue;
    flatLines.push({
      kind: line.type === 'del' ? 'remove' : line.type === 'add' ? 'add' : 'context',
      text: line.content,
      oldLine: line.oldLine ?? undefined,
      newLine: line.newLine ?? undefined,
    });
  }
  const truncated = flatLines.length > MAX_DIFF_LINES_PER_FILE;
  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    lines: truncated ? flatLines.slice(0, MAX_DIFF_LINES_PER_FILE) : flatLines,
    truncated,
  };
}

export class UndoService {
  private redoBuffers = new Map<string, RedoBufferEntry>();

  constructor(
    private readonly store: SmolCodeStore,
    private readonly snapshots: SnapshotManager,
  ) {}

  previewUndoToTurn(threadId: string, turnId: string): UndoPreviewResult {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const project = this.store.getProject(thread.projectId);
    if (!project) throw new Error(`Project not found: ${thread.projectId}`);

    const turns = this.store.listTurns(threadId);
    const resolved = resolveUndoTarget(turns, turnId);
    const rawDiffs = resolved.snapshotId
      ? this.snapshots.diffSnapshotToWorkdir(resolved.snapshotId, project.rootPath)
      : [];

    return {
      threadId,
      targetTurnId: turnId,
      rollbackStartTurnId: resolved.rollbackStartTurn.id,
      hasSnapshot: Boolean(resolved.snapshotId),
      snapshotId: resolved.snapshotId,
      restoredPrompt: resolved.restoredPrompt,
      restoredChips: resolved.restoredChips,
      turnsToRemoveCount: resolved.turnsToRemove.length,
      fileChanges: rawDiffs.map(mapSnapshotDiffFile),
    };
  }

  executeUndoToTurn(
    threadId: string,
    turnId: string,
    onInvalidate?: (workdir: string, changedPaths: string[]) => void,
  ): { result: UndoExecutionResult; updatedDraftThread: ReturnType<SmolCodeStore['updateThread']> } {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const project = this.store.getProject(thread.projectId);
    if (!project) throw new Error(`Project not found: ${thread.projectId}`);

    const turns = this.store.listTurns(threadId);
    const resolved = resolveUndoTarget(turns, turnId);
    const preUndoSnapshotId = resolved.snapshotId
      ? this.snapshots.captureSnapshot(threadId, project.rootPath)
      : null;

    const redoId = randomUUID();
    this.redoBuffers.set(redoId, {
      redoId,
      threadId,
      workdir: project.rootPath,
      preUndoSnapshotId,
      removedTurns: resolved.turnsToRemove,
      prevDraftText: thread.draftText,
      prevDraftChips: thread.draftChips ?? [],
      createdAt: Date.now(),
    });
    if (this.redoBuffers.size > MAX_REDO_ENTRIES) {
      const oldestKey = this.redoBuffers.keys().next().value;
      if (oldestKey) this.redoBuffers.delete(oldestKey);
    }

    let restoredFiles: string[] = [];
    let removedFiles: string[] = [];
    if (resolved.snapshotId) {
      const restored = this.snapshots.restoreSnapshot(resolved.snapshotId);
      restoredFiles = restored.restoredFiles;
      removedFiles = restored.removedFiles;
    }

    this.store.deleteTurnsAfter(threadId, resolved.rollbackStartTurn.id);
    const updatedDraftThread = this.store.updateThread(threadId, {
      draftText: resolved.restoredPrompt,
      draftChips: resolved.restoredChips,
    });

    onInvalidate?.(project.rootPath, [...restoredFiles, ...removedFiles]);

    return {
      result: {
        threadId,
        redoId,
        restoredPrompt: resolved.restoredPrompt,
        restoredChips: resolved.restoredChips,
        restoredFiles,
        removedFiles,
        turnsRemoved: resolved.turnsToRemove.length,
      },
      updatedDraftThread,
    };
  }

  revertUndoRollback(
    threadId: string,
    redoId: string,
    onInvalidate?: (workdir: string, changedPaths: string[]) => void,
  ): {
    restoredFiles: string[];
    removedFiles: string[];
    turnsRestored: number;
    updatedDraftThread: ReturnType<SmolCodeStore['updateThread']>;
  } {
    const entry = this.redoBuffers.get(redoId);
    if (!entry || entry.threadId !== threadId) {
      throw new Error('Undo history has expired or is no longer available.');
    }
    this.redoBuffers.delete(redoId);

    let restoredFiles: string[] = [];
    let removedFiles: string[] = [];
    if (entry.preUndoSnapshotId) {
      const restored = this.snapshots.restoreSnapshot(entry.preUndoSnapshotId);
      restoredFiles = restored.restoredFiles;
      removedFiles = restored.removedFiles;
    }

    const existingIds = new Set(this.store.listTurns(threadId).map((t) => t.id));
    for (const turn of entry.removedTurns) {
      if (!existingIds.has(turn.id)) {
        this.store.insertTurn(turn);
      }
    }

    const updatedDraftThread = this.store.updateThread(threadId, {
      draftText: entry.prevDraftText,
      draftChips: entry.prevDraftChips,
    });

    onInvalidate?.(entry.workdir, [...restoredFiles, ...removedFiles]);

    return {
      restoredFiles,
      removedFiles,
      turnsRestored: entry.removedTurns.length,
      updatedDraftThread,
    };
  }
}
