export interface HashlineEdit {
  op: 'replace_range' | 'insert_after' | 'insert_before' | 'delete_range';
  startAnchor: string;
  endAnchor?: string;
  content?: string;
}

/**
 * Strips accidental `42:a7| ` or `42| ` prefixes when small models copy lines
 * verbatim from `read_range`/`read_symbol` output into patch content.
 */
export function stripCopiedHashlinePrefixes(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return text;
  const hasHashPrefix = nonEmpty.every((l) => /^\s*\d+:[0-9a-zA-Z]{2}\|\s?/.test(l));
  if (hasHashPrefix) {
    return lines.map((l) => l.replace(/^\s*\d+:[0-9a-zA-Z]{2}\|\s?/, '')).join('\n');
  }
  const hasLineNumPrefix = nonEmpty.length >= 2 && nonEmpty.every((l) => /^\s*\d+\|\s?/.test(l));
  if (hasLineNumPrefix) {
    return lines.map((l) => l.replace(/^\s*\d+\|\s?/, '')).join('\n');
  }
  return text;
}

export interface HashlineResult {
  nextContent: string;
  linesAdded: number;
  linesRemoved: number;
  appliedEdits: number;
  minChangedLine: number;
  maxChangedLine: number;
}

export function lineHash(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) return '00';
  let h = 0x811c9dc5;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const code = (h >>> 0) % 1296;
  return code.toString(36).padStart(2, '0');
}

export function formatHashlineSlice(
  text: string,
  startLine = 1,
  endLine?: number,
): string {
  const lines = text.split(/\r?\n/);
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine ?? lines.length);
  const out: string[] = [];
  for (let ln = from; ln <= to; ln++) {
    const raw = lines[ln - 1] ?? '';
    out.push(`${ln}:${lineHash(raw)}| ${raw}`);
  }
  return out.join('\n');
}

export function parseAnchor(anchor: string): { line: number; hash: string | null } {
  let cleaned = anchor.trim().split('|')[0].trim();
  // Strip optional file prefix like "main.py#L42:a7" or "src/a.ts:42:a7" (must contain non-digits before separator)
  const filePrefixMatch = cleaned.match(
    /^[^\s:#]*[a-zA-Z_./\\][^\s:#]*(?:#L?|:)(\d+(?::[0-9a-zA-Z]{2})?)$/i,
  );
  if (filePrefixMatch) {
    cleaned = filePrefixMatch[1];
  }
  cleaned = cleaned.replace(/^#?(?:line\s+|l(?=\d))/i, '').trim();
  const match = cleaned.match(/^(\d+)(?::([0-9a-zA-Z]{2}))?$/);
  if (!match) {
    if (!cleaned) {
      throw new Error(
        `Missing hashline anchor "${anchor}". Pass "<line>:<2charHash>" (e.g. "42:a7") in edits[].startAnchor, or use <replace_range path="..." start="..." end="...">...</replace_range> or patch_file(filePath, oldText, newText).`,
      );
    }
    throw new Error(
      `Invalid hashline anchor "${anchor}". Expected "<line>:<2charHash>", e.g. "42:a7".`,
    );
  }
  return {
    line: Number(match[1]),
    hash: match[2] ? match[2].toLowerCase() : null,
  };
}

function detectLineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function resolveAnchorLine(
  lines: string[],
  anchorStr: string,
  driftRadius = 15,
): number {
  const { line, hash } = parseAnchor(anchorStr);
  if (line < 1 || line > lines.length) {
    throw new Error(
      `Anchor "${anchorStr}" out of range (file has ${lines.length} lines).`,
    );
  }
  const exactIdx = line - 1;
  if (!hash || lineHash(lines[exactIdx]) === hash) {
    return exactIdx;
  }

  // Tier 2: search nearby lines for line-drift matches (non-blank hashes)
  if (hash !== '00') {
    let bestIdx = -1;
    let bestDist = Infinity;
    const minIdx = Math.max(0, exactIdx - driftRadius);
    const maxIdx = Math.min(lines.length - 1, exactIdx + driftRadius);
    for (let i = minIdx; i <= maxIdx; i++) {
      if (lineHash(lines[i]) === hash) {
        const dist = Math.abs(i - exactIdx);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
    }
    if (bestIdx !== -1) {
      return bestIdx;
    }
  }

  // Tier 3: fail loudly with the exact live anchors around that line so the 9B model self-corrects in 1 turn
  const windowStart = Math.max(1, line - 3);
  const windowEnd = Math.min(lines.length, line + 3);
  const snippet: string[] = [];
  for (let ln = windowStart; ln <= windowEnd; ln++) {
    snippet.push(`${ln}:${lineHash(lines[ln - 1])}| ${lines[ln - 1]}`);
  }
  throw new Error(
    `Anchor mismatch at "${anchorStr}". Current lines around ${line}:\n${snippet.join('\n')}`,
  );
}

export function applyHashlineEdits(
  originalText: string,
  edits: HashlineEdit[],
): HashlineResult {
  if (edits.length === 0) {
    return {
      nextContent: originalText,
      linesAdded: 0,
      linesRemoved: 0,
      appliedEdits: 0,
      minChangedLine: 1,
      maxChangedLine: 1,
    };
  }

  const eol = detectLineEnding(originalText);
  const trailingNewline = originalText.endsWith('\n');
  const lines = originalText.split(/\r?\n/);
  if (trailingNewline && lines[lines.length - 1] === '') {
    lines.pop();
  }

  // Resolve all anchors against the original line snapshot first
  const resolved = edits.map((edit) => {
    const startIdx = resolveAnchorLine(lines, edit.startAnchor);
    const isInsert = edit.op === 'insert_after' || edit.op === 'insert_before';
    const endIdx = isInsert
      ? startIdx
      : edit.endAnchor
        ? resolveAnchorLine(lines, edit.endAnchor)
        : startIdx;

    if (endIdx < startIdx) {
      throw new Error(
        `Invalid range: endAnchor (${edit.endAnchor}) precedes startAnchor (${edit.startAnchor}).`,
      );
    }

    const cleanedContent =
      edit.op === 'delete_range'
        ? ''
        : stripCopiedHashlinePrefixes(edit.content ?? '');
    const replacementLines =
      edit.op === 'delete_range'
        ? []
        : cleanedContent.replace(/\r\n/g, '\n').split('\n');

    return {
      op: edit.op,
      startIdx,
      endIdx,
      replacementLines,
    };
  });

  // Sort descending by startIdx so lower edits never shift upper indices
  resolved.sort((a, b) => b.startIdx - a.startIdx);

  // Reject overlapping ranges
  for (let i = 0; i < resolved.length - 1; i++) {
    const later = resolved[i];
    const earlier = resolved[i + 1];
    const laterIsInsert = later.op === 'insert_after' || later.op === 'insert_before';
    const earlierIsInsert = earlier.op === 'insert_after' || earlier.op === 'insert_before';
    if (!earlierIsInsert && !laterIsInsert && later.startIdx <= earlier.endIdx) {
      throw new Error('Overlapping hashline edit ranges in a single patch call.');
    }
    if (!earlierIsInsert && later.op === 'insert_before' && later.startIdx < earlier.endIdx) {
      throw new Error('Overlapping hashline edit ranges in a single patch call.');
    }
  }

  let linesAdded = 0;
  let linesRemoved = 0;
  let minChangedLine = lines.length;
  let maxChangedLine = 1;

  for (const item of resolved) {
    const startLn = item.startIdx + 1;
    minChangedLine = Math.min(minChangedLine, startLn);
    if (item.op === 'insert_after') {
      lines.splice(item.startIdx + 1, 0, ...item.replacementLines);
      linesAdded += item.replacementLines.length;
      maxChangedLine = Math.max(maxChangedLine, startLn + item.replacementLines.length);
    } else if (item.op === 'insert_before') {
      lines.splice(item.startIdx, 0, ...item.replacementLines);
      linesAdded += item.replacementLines.length;
      maxChangedLine = Math.max(maxChangedLine, startLn + item.replacementLines.length - 1);
    } else if (item.op === 'delete_range') {
      const count = item.endIdx - item.startIdx + 1;
      lines.splice(item.startIdx, count);
      linesRemoved += count;
      maxChangedLine = Math.max(maxChangedLine, startLn);
    } else {
      const count = item.endIdx - item.startIdx + 1;
      lines.splice(item.startIdx, count, ...item.replacementLines);
      linesRemoved += count;
      linesAdded += item.replacementLines.length;
      maxChangedLine = Math.max(maxChangedLine, startLn + item.replacementLines.length - 1);
    }
  }

  let nextContent = lines.join(eol);
  if (trailingNewline && nextContent.length > 0 && !nextContent.endsWith(eol)) {
    nextContent += eol;
  }

  return {
    nextContent,
    linesAdded,
    linesRemoved,
    appliedEdits: edits.length,
    minChangedLine: Math.max(1, minChangedLine),
    maxChangedLine: Math.max(minChangedLine, maxChangedLine),
  };
}
