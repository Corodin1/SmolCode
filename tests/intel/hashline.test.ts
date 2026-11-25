import { describe, expect, it } from 'vitest';
import { applyFuzzyPatch } from '../../electron/intel/fuzzy-patch';
import {
  applyHashlineEdits,
  formatHashlineSlice,
  lineHash,
  parseAnchor,
} from '../../electron/intel/hashline';

describe('Hashline patch engine', () => {
  it('formats lines with deterministic 2-char hashes and parses anchors', () => {
    const src = 'const a = 1;\nconst b = 2;\n';
    const formatted = formatHashlineSlice(src, 1, 2);
    const lines = formatted.split('\n');
    expect(lines[0]).toBe(`1:${lineHash('const a = 1;')}| const a = 1;`);
    expect(lines[1]).toBe(`2:${lineHash('const b = 2;')}| const b = 2;`);
    expect(parseAnchor(`1:${lineHash('const a = 1;')}| const a = 1;`)).toEqual({
      line: 1,
      hash: lineHash('const a = 1;'),
    });
  });

  it('replaces, inserts, and deletes ranges while preserving CRLF line endings', () => {
    const src = 'line1\r\nline2\r\nline3\r\nline4\r\n';
    const h2 = lineHash('line2');
    const h3 = lineHash('line3');
    const h4 = lineHash('line4');

    const res = applyHashlineEdits(src, [
      {
        op: 'replace_range',
        startAnchor: `2:${h2}`,
        endAnchor: `3:${h3}`,
        content: 'updated2\nupdated3',
      },
      {
        op: 'insert_after',
        startAnchor: `4:${h4}`,
        content: 'line5',
      },
    ]);

    expect(res.nextContent).toBe('line1\r\nupdated2\r\nupdated3\r\nline4\r\nline5\r\n');
    expect(res.linesAdded).toBe(3);
    expect(res.linesRemoved).toBe(2);
  });

  it('recovers automatically when line numbers drift within radius', () => {
    const src = '// header 1\n// header 2\nfunction target() {\n  return 42;\n}\n';
    const targetHash = lineHash('  return 42;');
    // Intentionally pass stale line number 2 instead of actual line 4
    const res = applyHashlineEdits(src, [
      {
        op: 'replace_range',
        startAnchor: `2:${targetHash}`,
        endAnchor: `2:${targetHash}`,
        content: '  return 99;',
      },
    ]);
    expect(res.nextContent).toContain('return 99;');
  });

  it('returns actionable live anchors when hash does not match', () => {
    const src = 'alpha\nbeta\ngamma\n';
    expect(() =>
      applyHashlineEdits(src, [
        { op: 'replace_range', startAnchor: '2:zz', endAnchor: '2:zz', content: 'x' },
      ]),
    ).toThrow(/Current lines around 2/);
  });

  it('matches indentation-shifted and whitespace-normalized blocks via 3-tier fuzzy patch', () => {
    const src = 'function demo() {\r\n    const val = a + b;\r\n    return val;\r\n}\r\n';
    const res = applyFuzzyPatch(
      src,
      'const val = a+b;\nreturn val;',
      'const val = a * b;\nreturn val;',
    );
    expect(res.matchTier).toBe('whitespace-normalized');
    expect(res.nextContent).toBe(
      'function demo() {\r\n    const val = a * b;\r\n    return val;\r\n}\r\n',
    );
  });

  it('supports L-prefixed anchors, insert_before, and strips copied line:hash| prefixes', () => {
    const src = 'const a = 1;\nconst b = 2;\n';
    const h1 = lineHash('const a = 1;');
    const h2 = lineHash('const b = 2;');

    const res = applyHashlineEdits(src, [
      {
        op: 'insert_before',
        startAnchor: `L1:${h1}`,
        content: '1:zz| // header comment',
      },
      {
        op: 'replace_range',
        startAnchor: `line 2:${h2}`,
        endAnchor: `2:${h2}`,
        content: `2:${h2}| const b = 3;`,
      },
    ]);
    expect(res.nextContent).toBe('// header comment\nconst a = 1;\nconst b = 3;\n');

    const fuzzy = applyFuzzyPatch(
      res.nextContent,
      `2:${h1}| const a = 1;`,
      `2:${h1}| const a = 10;`,
    );
    expect(fuzzy.nextContent).toBe('// header comment\nconst a = 10;\nconst b = 3;\n');
  });

  it('parses file-prefixed and #L anchors and gives actionable hint on empty anchor', () => {
    expect(parseAnchor('#L42:a7')).toEqual({ line: 42, hash: 'a7' });
    expect(parseAnchor('main.py:42:a7')).toEqual({ line: 42, hash: 'a7' });
    expect(parseAnchor('main.py#L42:a7')).toEqual({ line: 42, hash: 'a7' });
    expect(() => parseAnchor('')).toThrow(/<replace_range/);
  });
});
