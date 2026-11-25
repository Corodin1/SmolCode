import { stripCopiedHashlinePrefixes } from './hashline';

export interface FuzzyPatchResult {
  nextContent: string;
  linesAdded: number;
  linesRemoved: number;
  matchTier: 'exact' | 'indent-trimmed' | 'whitespace-normalized';
  minChangedLine: number;
  maxChangedLine: number;
}

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function countCommonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function leadingWhitespace(line: string): string {
  const m = line.match(/^(\s*)/);
  return m ? m[1] : '';
}

function adjustIndentation(
  matchedFirstLine: string,
  oldFirstLine: string,
  newLines: string[],
): string[] {
  const targetIndent = leadingWhitespace(matchedFirstLine);
  const oldIndent = leadingWhitespace(oldFirstLine);
  if (targetIndent === oldIndent) return newLines;

  return newLines.map((ln) => {
    if (!ln.trim()) return '';
    if (oldIndent && ln.startsWith(oldIndent)) {
      return targetIndent + ln.slice(oldIndent.length);
    }
    if (!oldIndent) {
      return targetIndent + ln;
    }
    return ln;
  });
}

function findClosestSnippet(fileLines: string[], queryLines: string[]): string {
  const target = queryLines.map((l) => l.trim()).filter(Boolean);
  if (target.length === 0 || fileLines.length === 0) return '';
  const winSize = Math.min(fileLines.length, Math.max(4, target.length + 2));
  let bestStart = 0;
  let bestScore = -1;

  for (let i = 0; i <= Math.max(0, fileLines.length - winSize); i++) {
    let score = 0;
    for (let j = 0; j < winSize; j++) {
      const fLine = fileLines[i + j]?.trim() ?? '';
      for (const qLine of target) {
        if (fLine === qLine) score += 10;
        else if (qLine.length > 4 && fLine.includes(qLine)) score += 5;
        else score += Math.min(3, Math.floor(countCommonPrefix(fLine, qLine) / 6));
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  return fileLines
    .slice(bestStart, bestStart + winSize)
    .map((l, idx) => `${bestStart + idx + 1}| ${l}`)
    .join('\n');
}

export function applyFuzzyPatch(
  originalText: string,
  oldText: string,
  newText: string,
): FuzzyPatchResult {
  const eol = detectEol(originalText);
  const normOrig = originalText.replace(/\r\n/g, '\n');
  const normOld = stripCopiedHashlinePrefixes(oldText).replace(/\r\n/g, '\n');
  const normNew = stripCopiedHashlinePrefixes(newText).replace(/\r\n/g, '\n');

  if (!normOld) {
    throw new Error('oldText must not be empty.');
  }

  // Tier 1: Exact unique substring match
  const firstIdx = normOrig.indexOf(normOld);
  if (firstIdx !== -1) {
    const secondIdx = normOrig.indexOf(normOld, firstIdx + 1);
    if (secondIdx !== -1) {
      throw new Error(
        'oldText matched multiple locations; include 1-2 surrounding lines so it is unique.',
      );
    }
    const before = normOrig.slice(0, firstIdx);
    const startLine = before.split('\n').length;
    const oldLineCount = normOld.split('\n').length;
    const newLineCount = normNew.split('\n').length;
    const nextNorm = before + normNew + normOrig.slice(firstIdx + normOld.length);
    return {
      nextContent: eol === '\r\n' ? nextNorm.replace(/\n/g, '\r\n') : nextNorm,
      linesAdded: newLineCount,
      linesRemoved: oldLineCount,
      matchTier: 'exact',
      minChangedLine: startLine,
      maxChangedLine: startLine + newLineCount - 1,
    };
  }

  const origLines = normOrig.split('\n');
  const oldLines = normOld.split('\n');
  const newLines = normNew.split('\n');

  // Strip trailing empty line if model ended oldText with trailing newline
  if (oldLines.length > 1 && oldLines[oldLines.length - 1] === '') {
    oldLines.pop();
    if (newLines.length > 1 && newLines[newLines.length - 1] === '') {
      newLines.pop();
    }
  }

  // Tier 2: Line-trimmed indentation-tolerant match
  const trimmedOld = oldLines.map((l) => l.trim());
  const tier2Matches: number[] = [];
  for (let i = 0; i <= origLines.length - trimmedOld.length; i++) {
    let ok = true;
    for (let j = 0; j < trimmedOld.length; j++) {
      if (origLines[i + j].trim() !== trimmedOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) tier2Matches.push(i);
  }

  if (tier2Matches.length === 1) {
    const startIdx = tier2Matches[0];
    const indentedNew = adjustIndentation(origLines[startIdx], oldLines[0], newLines);
    const updated = [
      ...origLines.slice(0, startIdx),
      ...indentedNew,
      ...origLines.slice(startIdx + oldLines.length),
    ].join('\n');
    return {
      nextContent: eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated,
      linesAdded: indentedNew.length,
      linesRemoved: oldLines.length,
      matchTier: 'indent-trimmed',
      minChangedLine: startIdx + 1,
      maxChangedLine: startIdx + indentedNew.length,
    };
  }

  // Tier 3: Whitespace-normalized line match (handles spacing around punctuation/operators too)
  const collapseTight = (s: string) => s.replace(/\s+/g, '');
  const collapsedOld = oldLines.map(collapseTight);
  const tier3Matches: number[] = [];
  for (let i = 0; i <= origLines.length - collapsedOld.length; i++) {
    let ok = true;
    for (let j = 0; j < collapsedOld.length; j++) {
      if (collapseTight(origLines[i + j]) !== collapsedOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) tier3Matches.push(i);
  }

  if (tier3Matches.length === 1) {
    const startIdx = tier3Matches[0];
    const indentedNew = adjustIndentation(origLines[startIdx], oldLines[0], newLines);
    const updated = [
      ...origLines.slice(0, startIdx),
      ...indentedNew,
      ...origLines.slice(startIdx + oldLines.length),
    ].join('\n');
    return {
      nextContent: eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated,
      linesAdded: indentedNew.length,
      linesRemoved: oldLines.length,
      matchTier: 'whitespace-normalized',
      minChangedLine: startIdx + 1,
      maxChangedLine: startIdx + indentedNew.length,
    };
  }

  const closest = findClosestSnippet(origLines, oldLines);
  throw new Error(
    `oldText not found cleanly. Closest lines in file:\n${closest}`,
  );
}
