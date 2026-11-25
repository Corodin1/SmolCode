import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SmolCodeStore } from '../../electron/store/database';
import { SnapshotManager } from '../../electron/store/snapshots';
import { UndoService } from '../../electron/store/undo-service';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('Local Snapshot Rollback (git-independent)', () => {
  it('captures, diffs, and restores snapshots including removing added files', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'smolcode-snap-work-'));
    const storeRoot = mkdtempSync(join(tmpdir(), 'smolcode-snap-store-'));
    tempDirs.push(workdir, storeRoot);

    writeFileSync(join(workdir, 'a.txt'), 'original\n', 'utf8');
    const store = new SmolCodeStore(join(storeRoot, 'test.db'));
    const snaps = new SnapshotManager(store, join(storeRoot, 'blobs'));
    const proj = store.upsertProject({ name: 'snap', rootPath: workdir });
    const th = store.createThread({
      projectId: proj.id,
      title: 'Test',
      mainModel: 'm',
      fastModel: 'f',
      effort: 'medium',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    const snapId = snaps.captureSnapshot(th.id, workdir);
    writeFileSync(join(workdir, 'a.txt'), 'mutated\n', 'utf8');
    writeFileSync(join(workdir, 'extra.txt'), 'new file\n', 'utf8');

    const diffs = snaps.diffSnapshotToWorkdir(snapId);
    expect(diffs.map((d) => d.path)).toEqual(['a.txt', 'extra.txt']);

    const restored = snaps.restoreSnapshot(snapId);
    expect(restored.restoredFiles).toEqual(['a.txt']);
    expect(restored.removedFiles).toEqual(['extra.txt']);
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(workdir, 'extra.txt'))).toBe(false);
    store.close();
  });

  it('previews, executes, and reverts UndoService rollback across turn pairs and composer drafts', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'smolcode-undo-work-'));
    const storeRoot = mkdtempSync(join(tmpdir(), 'smolcode-undo-store-'));
    tempDirs.push(workdir, storeRoot);

    writeFileSync(join(workdir, 'a.txt'), 'v1\n', 'utf8');
    writeFileSync(join(workdir, 'b.txt'), 'v1\n', 'utf8');

    const store = new SmolCodeStore(join(storeRoot, 'undo.db'));
    const snaps = new SnapshotManager(store, join(storeRoot, 'blobs'));
    const undo = new UndoService(store, snaps);
    const proj = store.upsertProject({ name: 'undo', rootPath: workdir });
    const th = store.createThread({
      projectId: proj.id,
      title: 'Undo thread',
      mainModel: 'm',
      fastModel: 'f',
      effort: 'medium',
      approvalPolicy: 'auto',
      draftText: 'next unsent note',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    const snap1 = snaps.captureSnapshot(th.id, workdir);
    store.insertTurn({
      id: 'u1',
      threadId: th.id,
      role: 'user',
      content: 'First prompt',
      createdAt: 100,
    });
    writeFileSync(join(workdir, 'a.txt'), 'v2\n', 'utf8');
    store.insertTurn({
      id: 'a1',
      threadId: th.id,
      role: 'assistant',
      content: 'Done 1',
      snapshotId: snap1,
      createdAt: 101,
    });

    const snap2 = snaps.captureSnapshot(th.id, workdir);
    const chip = { id: 'file:b.txt', kind: 'file' as const, label: 'b.txt', filePath: 'b.txt' };
    store.insertTurn({
      id: 'u2',
      threadId: th.id,
      role: 'user',
      content: 'Second prompt',
      chips: [chip],
      createdAt: 200,
    });
    writeFileSync(join(workdir, 'b.txt'), 'v2\n', 'utf8');
    writeFileSync(join(workdir, 'added.txt'), 'hello\n', 'utf8');
    store.insertTurn({
      id: 'a2',
      threadId: th.id,
      role: 'assistant',
      content: 'Done 2',
      snapshotId: snap2,
      createdAt: 201,
    });

    // Previewing from user turn u2 resolves paired assistant snapshot snap2
    const preview = undo.previewUndoToTurn(th.id, 'u2');
    expect(preview.rollbackStartTurnId).toBe('u2');
    expect(preview.snapshotId).toBe(snap2);
    expect(preview.turnsToRemoveCount).toBe(2);
    expect(preview.restoredPrompt).toBe('Second prompt');
    expect(preview.fileChanges.map((f) => `${f.path}:${f.status}`)).toEqual([
      'added.txt:added',
      'b.txt:modified',
    ]);

    // Execute rollback via assistant turn a2 -> removes [u2, a2], restores files, loads draft
    const { result } = undo.executeUndoToTurn(th.id, 'a2');
    expect(result.turnsRemoved).toBe(2);
    expect(result.restoredPrompt).toBe('Second prompt');
    expect(result.restoredChips).toEqual([chip]);
    expect(store.listTurns(th.id).map((t) => t.id)).toEqual(['u1', 'a1']);
    expect(store.getThread(th.id)?.draftText).toBe('Second prompt');
    expect(readFileSync(join(workdir, 'b.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(workdir, 'added.txt'))).toBe(false);
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('v2\n');

    // Revert undo brings back [u2, a2], files, and previous draft
    const reverted = undo.revertUndoRollback(th.id, result.redoId);
    expect(reverted.turnsRestored).toBe(2);
    expect(store.listTurns(th.id).map((t) => t.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(store.getThread(th.id)?.draftText).toBe('next unsent note');
    expect(readFileSync(join(workdir, 'b.txt'), 'utf8')).toBe('v2\n');
    expect(readFileSync(join(workdir, 'added.txt'), 'utf8')).toBe('hello\n');

    // Conversation-only turn without snapshot rolls back cleanly too
    store.insertTurn({
      id: 'u3',
      threadId: th.id,
      role: 'user',
      content: 'Chat only',
      createdAt: 300,
    });
    store.insertTurn({
      id: 'a3',
      threadId: th.id,
      role: 'assistant',
      content: 'No files touched',
      snapshotId: null,
      createdAt: 301,
    });
    const chatPreview = undo.previewUndoToTurn(th.id, 'u3');
    expect(chatPreview.hasSnapshot).toBe(false);
    expect(chatPreview.fileChanges).toEqual([]);
    const chatExec = undo.executeUndoToTurn(th.id, 'u3');
    expect(chatExec.result.turnsRemoved).toBe(2);
    expect(store.listTurns(th.id).map((t) => t.id)).toEqual(['u1', 'a1', 'u2', 'a2']);

    store.close();
  });
});
