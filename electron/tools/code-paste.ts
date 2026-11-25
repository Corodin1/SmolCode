import { stripCopiedHashlinePrefixes } from '../intel/hashline';

export type CodePasteKind = 'file_write' | 'replace_symbol' | 'replace_range';

export interface ParsedCodePasteBlock {
  kind: CodePasteKind;
  filePath: string;
  symbolName?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  rawMatch: string;
  truncationError?: string;
}

export interface CodePasteExtractionResult {
  blocks: ParsedCodePasteBlock[];
  cleanedContent: string;
}

const TAG_NAMES: CodePasteKind[] = ['file_write', 'replace_symbol', 'replace_range'];
const MAX_OPEN_TAG_LOOKAHEAD = 32;

const PLACEHOLDER_OMISSION_PATTERNS: RegExp[] = [
  /^\s*(?:#|\/\/|\/\*|<!--|--)\s*\.\.\.\s*(?:existing|rest\s+of|remaining|unchanged|previous|omitted|other|same\s+as\s+before)\b/im,
  /^\s*\.\.\.\s*(?:existing\s+code|rest\s+of\s+(?:the\s+)?file|remaining\s+code|unchanged\s+code|code\s+omitted)\b/im,
];

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const rx = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const m of attrString.matchAll(rx)) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = val.trim();
  }
  return attrs;
}

function unwrapTagBody(rawBody: string): string {
  let body = rawBody.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const fenceMatch = body.match(/^```[a-zA-Z0-9_.-]*\r?\n([\s\S]*?)\r?\n```$/);
  if (fenceMatch) {
    body = fenceMatch[1];
  }
  return stripCopiedHashlinePrefixes(body);
}

export function validateCodePasteContent(content: string): string | null {
  for (const rx of PLACEHOLDER_OMISSION_PATTERNS) {
    const match = content.match(rx);
    if (match) {
      return `Code block rejected: contains placeholder omission marker "${match[0].trim()}". Provide complete code or use <replace_symbol>/<replace_range> for scoped edits.`;
    }
  }
  return null;
}

export function checkFileWriteShrinkGuard(
  relPath: string,
  originalText: string,
  nextText: string,
): string | null {
  const origLines = originalText.split(/\r?\n/).length;
  const nextLines = nextText.split(/\r?\n/).length;
  if (origLines > 40 && nextLines < origLines * 0.4) {
    return `Refused <file_write> on existing file "${relPath}": it shrinks the file from ${origLines} to ${nextLines} lines (>60% reduction). Use <replace_symbol> or <replace_range> for scoped edits.`;
  }
  return null;
}

function resolveBlockPath(attrs: Record<string, string>): string {
  return attrs.path ?? attrs.filepath ?? attrs.file_path ?? attrs.file ?? '';
}

function buildBlockSummary(block: ParsedCodePasteBlock): string {
  if (block.kind === 'file_write') {
    return `[Applied file_write(${block.filePath})]`;
  }
  if (block.kind === 'replace_symbol') {
    return `[Applied replace_symbol(${block.filePath}::${block.symbolName ?? ''})]`;
  }
  return `[Applied replace_range(${block.filePath}:${block.startLine ?? ''}-${block.endLine ?? ''})]`;
}

export function extractCodePasteBlocks(
  content: string,
  thinking?: string,
): CodePasteExtractionResult {
  const blocks: ParsedCodePasteBlock[] = [];

  const scanAndClean = (source: string): string => {
    const closedRx = /<(file_write|replace_symbol|replace_range)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cleaned = source.replace(closedRx, (full, rawKind: string, rawAttrs: string, rawBody: string) => {
      const kind = rawKind.toLowerCase() as CodePasteKind;
      const attrs = parseAttributes(rawAttrs);
      const filePath = resolveBlockPath(attrs);
      const block: ParsedCodePasteBlock = {
        kind,
        filePath,
        ...(attrs.symbol ? { symbolName: attrs.symbol } : {}),
        ...(attrs.start !== undefined ? { startLine: Number(attrs.start) } : {}),
        ...(attrs.end !== undefined ? { endLine: Number(attrs.end) } : {}),
        content: unwrapTagBody(rawBody),
        rawMatch: full,
      };
      blocks.push(block);
      return buildBlockSummary(block);
    });

    // Detect unclosed/truncated blocks at the tail so the model gets a clear diagnostic
    const unclosedRx = /<(file_write|replace_symbol|replace_range)\b([^>]*)>([\s\S]*)$/i;
    const unclosed = cleaned.match(unclosedRx);
    if (unclosed) {
      const kind = unclosed[1].toLowerCase() as CodePasteKind;
      const attrs = parseAttributes(unclosed[2]);
      const filePath = resolveBlockPath(attrs);
      const block: ParsedCodePasteBlock = {
        kind,
        filePath,
        ...(attrs.symbol ? { symbolName: attrs.symbol } : {}),
        ...(attrs.start !== undefined ? { startLine: Number(attrs.start) } : {}),
        ...(attrs.end !== undefined ? { endLine: Number(attrs.end) } : {}),
        content: '',
        rawMatch: unclosed[0],
        truncationError: `Truncated <${kind}> block for "${filePath || 'unknown'}" (missing closing </${kind}>). Retry with a smaller <replace_symbol> or <replace_range> block.`,
      };
      blocks.push(block);
      cleaned = cleaned.replace(unclosedRx, buildBlockSummary(block));
    }

    return cleaned.trim();
  };

  const cleanedContent = scanAndClean(content);
  if (blocks.length === 0 && thinking?.trim()) {
    scanAndClean(thinking);
  }

  return { blocks, cleanedContent };
}

export interface TagPreviewInfo {
  kind: CodePasteKind;
  filePath: string;
  symbolName?: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Buffers `<file_write>`, `<replace_symbol>`, and `<replace_range>` bodies
 * during `onContentDelta` streaming so large raw code pastes do not flood the
 * chat prose bubble while still streaming normal prose immediately.
 */
export class StreamingCodeTagFilter {
  private buffer = '';
  private activeTag: TagPreviewInfo | null = null;

  constructor(
    private readonly onProseDelta: (delta: string) => void,
    private readonly onTagStart?: (info: TagPreviewInfo) => void,
    private readonly onTagEnd?: (info: TagPreviewInfo) => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      if (this.activeTag) {
        const closeTag = `</${this.activeTag.kind}>`;
        const closeIdx = this.buffer.toLowerCase().indexOf(closeTag);
        if (closeIdx === -1) {
          // Keep just enough tail to catch a split closing tag
          const keepTail = closeTag.length - 1;
          if (this.buffer.length > keepTail) {
            this.buffer = this.buffer.slice(-keepTail);
          }
          return;
        }
        const finished = this.activeTag;
        this.buffer = this.buffer.slice(closeIdx + closeTag.length);
        this.activeTag = null;
        this.onTagEnd?.(finished);
        continue;
      }

      const ltIdx = this.buffer.indexOf('<');
      if (ltIdx === -1) {
        this.onProseDelta(this.buffer);
        this.buffer = '';
        return;
      }

      if (ltIdx > 0) {
        this.onProseDelta(this.buffer.slice(0, ltIdx));
        this.buffer = this.buffer.slice(ltIdx);
      }

      // Check if `<...` starts one of our code-paste tags
      const lower = this.buffer.toLowerCase();
      const couldBeTag = TAG_NAMES.some(
        (name) => lower.startsWith(`<${name}`) || `<${name}`.startsWith(lower),
      );
      if (!couldBeTag) {
        // Not a code-paste tag; emit `<` and continue scanning
        this.onProseDelta('<');
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const openMatch = this.buffer.match(
        /^<(file_write|replace_symbol|replace_range)\b([^>]*)>/i,
      );
      if (!openMatch) {
        // Guard against runaway `<` without `>`
        if (this.buffer.length > 260 || this.buffer.includes('\n')) {
          this.onProseDelta(this.buffer.slice(0, Math.min(this.buffer.length, MAX_OPEN_TAG_LOOKAHEAD)));
          this.buffer = this.buffer.slice(Math.min(this.buffer.length, MAX_OPEN_TAG_LOOKAHEAD));
          continue;
        }
        return;
      }

      const kind = openMatch[1].toLowerCase() as CodePasteKind;
      const attrs = parseAttributes(openMatch[2]);
      const info: TagPreviewInfo = {
        kind,
        filePath: resolveBlockPath(attrs),
        ...(attrs.symbol ? { symbolName: attrs.symbol } : {}),
        ...(attrs.start !== undefined ? { startLine: Number(attrs.start) } : {}),
        ...(attrs.end !== undefined ? { endLine: Number(attrs.end) } : {}),
      };
      this.buffer = this.buffer.slice(openMatch[0].length);
      this.activeTag = info;
      this.onTagStart?.(info);
    }
  }

  flush(): void {
    if (!this.activeTag && this.buffer.length > 0) {
      this.onProseDelta(this.buffer);
    }
    this.buffer = '';
    this.activeTag = null;
  }
}
