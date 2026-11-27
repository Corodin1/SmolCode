import { normalizeGuardPath } from './loop-guard';

export interface CachedRangeEntry {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines?: number;
  output: string;
  source: 'prefetch' | 'tool';
  stepId: string;
  stepNumber: number;
  folded: boolean;
}

export interface CachedSymbolEntry {
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  output: string;
  source: 'prefetch' | 'tool';
  stepId: string;
  stepNumber: number;
  folded: boolean;
}

export type ReadCacheLookup =
  | { hit: 'miss' }
  | { hit: 'in_context'; pointer: string; coveredStart: number; coveredEnd: number }
  | { hit: 'folded_cached'; output: string; coveredStart: number; coveredEnd: number };

export interface CoalescedBatchPlan {
  /** Merged [startLine, endLine] override for primary read_range calls. */
  mergedRanges: Map<number, { startLine: number; endLine: number }>;
  /** Secondary read_range indices mapped to the primary index they were merged into. */
  mergedInto: Map<number, number>;
}

function formatSourceLabel(source: 'prefetch' | 'tool', stepNumber: number): string {
  return source === 'prefetch' ? 'Prefetched Context Slices' : `step ${stepNumber}`;
}

export class TurnReadCache {
  private rangeEntries = new Map<string, CachedRangeEntry[]>();
  private symbolEntries = new Map<string, CachedSymbolEntry[]>();

  recordRange(entry: Omit<CachedRangeEntry, 'folded'>): void {
    const normPath = normalizeGuardPath(entry.filePath);
    if (!normPath) return;

    const list = this.rangeEntries.get(normPath) ?? [];
    const existingIdx = list.findIndex(
      (item) => item.startLine === entry.startLine && item.endLine === entry.endLine,
    );
    const next: CachedRangeEntry = {
      ...entry,
      filePath: normPath,
      folded: false,
    };
    if (existingIdx >= 0) {
      list[existingIdx] = next;
    } else {
      list.push(next);
    }
    this.rangeEntries.set(normPath, list);
  }

  recordSymbol(entry: Omit<CachedSymbolEntry, 'folded'>): void {
    const normPath = normalizeGuardPath(entry.filePath);
    if (!normPath || !entry.symbolName.trim()) return;

    const list = this.symbolEntries.get(normPath) ?? [];
    const symKey = entry.symbolName.trim();
    const existingIdx = list.findIndex((item) => item.symbolName === symKey);
    const next: CachedSymbolEntry = {
      ...entry,
      filePath: normPath,
      symbolName: symKey,
      folded: false,
    };
    if (existingIdx >= 0) {
      list[existingIdx] = next;
    } else {
      list.push(next);
    }
    this.symbolEntries.set(normPath, list);
  }

  markFolded(foldedCalls: Array<{ stepId?: string }>): void {
    const foldedStepIds = new Set(
      foldedCalls.map((c) => c.stepId).filter((id): id is string => Boolean(id)),
    );
    if (foldedStepIds.size === 0) return;

    for (const list of this.rangeEntries.values()) {
      for (const entry of list) {
        if (entry.source === 'tool' && foldedStepIds.has(entry.stepId)) {
          entry.folded = true;
        }
      }
    }
    for (const list of this.symbolEntries.values()) {
      for (const entry of list) {
        if (entry.source === 'tool' && foldedStepIds.has(entry.stepId)) {
          entry.folded = true;
        }
      }
    }
  }

  lookupRange(
    filePath: string,
    startLine: number,
    endLine: number,
    refreshStep?: { stepId: string; stepNumber: number },
  ): ReadCacheLookup {
    const normPath = normalizeGuardPath(filePath);
    if (!normPath) return { hit: 'miss' };

    const ranges = this.rangeEntries.get(normPath) ?? [];
    const symbols = this.symbolEntries.get(normPath) ?? [];

    const knownTotal = ranges.find((r) => r.totalLines !== undefined)?.totalLines;
    const reqStart = Number.isFinite(startLine) ? Math.max(1, Math.floor(startLine)) : 1;
    const rawEnd = Number.isFinite(endLine) ? Math.floor(endLine) : reqStart + 60;
    const reqEnd = Math.max(reqStart, Math.min(rawEnd, reqStart + 179));

    if (knownTotal !== undefined && reqStart > knownTotal) {
      return { hit: 'miss' };
    }
    const clampedReqEnd = knownTotal !== undefined ? Math.min(knownTotal, reqEnd) : reqEnd;

    // 1. Prefer any unfolded (still active in prompt) slice that covers [reqStart, clampedReqEnd]
    const activeRange = ranges.find(
      (r) => !r.folded && r.startLine <= reqStart && r.endLine >= clampedReqEnd,
    );
    if (activeRange) {
      return {
        hit: 'in_context',
        coveredStart: activeRange.startLine,
        coveredEnd: activeRange.endLine,
        pointer: `Already in ${formatSourceLabel(activeRange.source, activeRange.stepNumber)} (${normPath} L${activeRange.startLine}-${activeRange.endLine}, unchanged). Use those line:hash anchors directly to edit instead of re-reading.`,
      };
    }

    const activeSymbol = symbols.find(
      (s) => !s.folded && s.startLine <= reqStart && s.endLine >= clampedReqEnd,
    );
    if (activeSymbol) {
      return {
        hit: 'in_context',
        coveredStart: activeSymbol.startLine,
        coveredEnd: activeSymbol.endLine,
        pointer: `Already in ${formatSourceLabel(activeSymbol.source, activeSymbol.stepNumber)} (${normPath}::${activeSymbol.symbolName} L${activeSymbol.startLine}-${activeSymbol.endLine}, unchanged). Use those line:hash anchors directly to edit instead of re-reading.`,
      };
    }

    // 2. Otherwise serve from a folded cached slice without touching disk or penalizing LoopGuard
    const foldedRange = ranges.find(
      (r) => r.folded && r.startLine <= reqStart && r.endLine >= clampedReqEnd,
    );
    if (foldedRange) {
      if (refreshStep) {
        foldedRange.folded = false;
        foldedRange.stepId = refreshStep.stepId;
        foldedRange.stepNumber = refreshStep.stepNumber;
      }
      return {
        hit: 'folded_cached',
        output: foldedRange.output,
        coveredStart: foldedRange.startLine,
        coveredEnd: foldedRange.endLine,
      };
    }

    const foldedSymbol = symbols.find(
      (s) => s.folded && s.startLine <= reqStart && s.endLine >= clampedReqEnd,
    );
    if (foldedSymbol) {
      if (refreshStep) {
        foldedSymbol.folded = false;
        foldedSymbol.stepId = refreshStep.stepId;
        foldedSymbol.stepNumber = refreshStep.stepNumber;
      }
      return {
        hit: 'folded_cached',
        output: foldedSymbol.output,
        coveredStart: foldedSymbol.startLine,
        coveredEnd: foldedSymbol.endLine,
      };
    }

    return { hit: 'miss' };
  }

  lookupSymbol(
    filePath: string,
    symbolName: string,
    refreshStep?: { stepId: string; stepNumber: number },
  ): ReadCacheLookup {
    const normPath = normalizeGuardPath(filePath);
    const symKey = symbolName.trim();
    if (!normPath || !symKey) return { hit: 'miss' };

    const symbols = this.symbolEntries.get(normPath) ?? [];
    const active = symbols.find((s) => !s.folded && s.symbolName === symKey);
    if (active) {
      return {
        hit: 'in_context',
        coveredStart: active.startLine,
        coveredEnd: active.endLine,
        pointer: `Already in ${formatSourceLabel(active.source, active.stepNumber)} (${normPath}::${active.symbolName} L${active.startLine}-${active.endLine}, unchanged). Use those line:hash anchors directly to edit.`,
      };
    }

    const folded = symbols.find((s) => s.folded && s.symbolName === symKey);
    if (folded) {
      if (refreshStep) {
        folded.folded = false;
        folded.stepId = refreshStep.stepId;
        folded.stepNumber = refreshStep.stepNumber;
      }
      return {
        hit: 'folded_cached',
        output: folded.output,
        coveredStart: folded.startLine,
        coveredEnd: folded.endLine,
      };
    }

    return { hit: 'miss' };
  }

  invalidate(filePath?: string): void {
    if (!filePath) {
      this.rangeEntries.clear();
      this.symbolEntries.clear();
      return;
    }
    const normPath = normalizeGuardPath(filePath);
    if (!normPath) return;
    this.rangeEntries.delete(normPath);
    this.symbolEntries.delete(normPath);
  }
}

/**
 * Coalesces overlapping or adjacent `read_range` calls targeting the same file within a
 * single parallel step batch so disk I/O and prompt tokens are spent only once per span.
 */
export function coalesceRangeBatch(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
): CoalescedBatchPlan {
  const mergedRanges = new Map<number, { startLine: number; endLine: number }>();
  const mergedInto = new Map<number, number>();

  interface RangeRef {
    index: number;
    start: number;
    end: number;
  }

  const byFile = new Map<string, RangeRef[]>();
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (c.name !== 'read_range') continue;
    const normPath = normalizeGuardPath(String(c.arguments.filePath ?? ''));
    if (!normPath) continue;
    const rawStart = Number(c.arguments.startLine ?? 1);
    const start = Number.isFinite(rawStart) ? Math.max(1, Math.floor(rawStart)) : 1;
    const rawEnd = Number(c.arguments.endLine ?? start + 60);
    const end = Math.max(start, Math.min(Number.isFinite(rawEnd) ? Math.floor(rawEnd) : start + 60, start + 179));
    const list = byFile.get(normPath) ?? [];
    list.push({ index: i, start, end });
    byFile.set(normPath, list);
  }

  for (const refs of byFile.values()) {
    if (refs.length < 2) continue;
    const sorted = [...refs].sort((a, b) => a.start - b.start || a.end - b.end);
    let clusterPrimary = sorted[0];
    let clusterStart = clusterPrimary.start;
    let clusterEnd = clusterPrimary.end;

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      const combinedEnd = Math.max(clusterEnd, next.end);
      // Merge overlapping or adjacent spans if the combined window fits inside read_range's 180-line cap
      if (next.start <= clusterEnd + 1 && combinedEnd - clusterStart < 180) {
        clusterEnd = combinedEnd;
        mergedInto.set(next.index, clusterPrimary.index);
      } else {
        mergedRanges.set(clusterPrimary.index, { startLine: clusterStart, endLine: clusterEnd });
        clusterPrimary = next;
        clusterStart = next.start;
        clusterEnd = next.end;
      }
    }
    mergedRanges.set(clusterPrimary.index, { startLine: clusterStart, endLine: clusterEnd });
  }

  return { mergedRanges, mergedInto };
}
