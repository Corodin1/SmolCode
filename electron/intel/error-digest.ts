// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const ERROR_LINE_PATTERN =
  /\b(error|failed|fail|exception|panic|fatal|syntaxerror|typeerror|referenceerror|ts\d{4}|e\d{4}|assert)\b|^\s*at\s+/i;

const NOISE_LINE_PATTERN =
  /^\s*(✓|ok\s+\d|PASS\s|info\s|warning:\s*$|[\s|─━•·]*$|added \d+ packages|\d+\s+files?\s+changed)/i;

export interface DigestedOutput {
  text: string;
  rawChars: number;
  digestedChars: number;
  savedTokensApprox: number;
}

export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '');
}

export function digestCommandOutput(
  rawOutput: string,
  exitCode: number,
  maxChars = 2400,
): DigestedOutput {
  const clean = stripAnsi(rawOutput).replace(/\r\n/g, '\n');
  const rawChars = clean.length;

  if (rawChars <= maxChars) {
    return {
      text: clean,
      rawChars,
      digestedChars: rawChars,
      savedTokensApprox: 0,
    };
  }

  const lines = clean.split('\n');
  const keepIndices = new Set<number>();

  // Always keep first 4 and last 8 lines for header/summary
  for (let i = 0; i < Math.min(4, lines.length); i++) keepIndices.add(i);
  for (let i = Math.max(0, lines.length - 8); i < lines.length; i++) keepIndices.add(i);

  // Keep error anchors and ±2 context lines (skipping noisy node_modules internals)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('node_modules/') || line.includes('node_modules\\')) continue;
    if (NOISE_LINE_PATTERN.test(line)) continue;
    if (ERROR_LINE_PATTERN.test(line)) {
      for (let ctx = Math.max(0, i - 2); ctx <= Math.min(lines.length - 1, i + 3); ctx++) {
        if (!lines[ctx].includes('node_modules')) {
          keepIndices.add(ctx);
        }
      }
    }
  }

  const sorted = [...keepIndices].sort((a, b) => a - b);
  const chunks: string[] = [];
  let prev = -1;
  const seenErrors = new Set<string>();

  for (const idx of sorted) {
    if (prev !== -1 && idx > prev + 1) {
      chunks.push(`... [${idx - prev - 1} lines folded] ...`);
    }
    const line = lines[idx];
    const norm = line.trim();
    if (norm.length > 0 && seenErrors.has(norm) && ERROR_LINE_PATTERN.test(norm)) {
      prev = idx;
      continue;
    }
    if (ERROR_LINE_PATTERN.test(norm)) {
      seenErrors.add(norm);
    }
    chunks.push(line);
    prev = idx;
  }

  let digested = `[exit=${exitCode}, raw_lines=${lines.length}]\n${chunks.join('\n')}`;
  if (digested.length > maxChars) {
    digested = `${digested.slice(0, maxChars)}\n...[output truncated to ${maxChars} chars]`;
  }

  return {
    text: digested,
    rawChars,
    digestedChars: digested.length,
    savedTokensApprox: Math.max(0, Math.round((rawChars - digested.length) / 4)),
  };
}
