import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';

interface CodeBlockProps {
  code: string;
  language?: string;
}

const KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'import',
  'from',
  'export',
  'default',
  'async',
  'await',
  'type',
  'interface',
  'class',
  'extends',
  'implements',
  'new',
  'try',
  'catch',
  'finally',
  'throw',
  'switch',
  'case',
  'break',
  'continue',
  'def',
  'fn',
  'pub',
  'struct',
  'enum',
  'impl',
  'use',
  'match',
  'true',
  'false',
  'null',
  'undefined',
  'None',
  'True',
  'False',
]);

function highlightLine(line: string, lineIdx: number): ReactNode {
  const tokenRx =
    /(\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Z][A-Za-z0-9_]*\b|\b[a-z_][A-Za-z0-9_]*(?=\s*\()|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let seq = 0;

  for (const match of line.matchAll(tokenRx)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      nodes.push(line.slice(lastIndex, idx));
    }
    const tok = match[0];
    let cls: string | null = null;
    if (tok.startsWith('//') || tok.startsWith('#')) {
      cls = 'tok-com';
    } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) {
      cls = 'tok-str';
    } else if (/^\d/.test(tok)) {
      cls = 'tok-num';
    } else if (KEYWORDS.has(tok)) {
      cls = 'tok-kw';
    } else if (/^[A-Z]/.test(tok)) {
      cls = 'tok-type';
    } else if (line.slice(idx + tok.length).match(/^\s*\(/)) {
      cls = 'tok-fn';
    }

    if (cls) {
      nodes.push(
        <span key={`${lineIdx}-${seq++}`} className={cls}>
          {tok}
        </span>,
      );
    } else {
      nodes.push(tok);
    }
    lastIndex = idx + tok.length;
  }

  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : '\u00A0';
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const lines = code.replace(/\n$/, '').split('\n');

  return (
    <div
      style={{
        margin: '10px 0',
        borderRadius: 11,
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-sidebar)',
        boxShadow: 'inset 0 1px 0 var(--surface-sheen)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 11px',
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
          fontSize: 11,
          color: 'var(--text-muted)',
        }}
      >
        <span className="mono" style={{ fontWeight: 500 }}>{language || 'text'}</span>
        <button
          type="button"
          className="pressable hover-surface blur-swap"
          onClick={handleCopy}
          aria-label="Copy code block"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 7px',
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            color: copied ? 'var(--accent-green)' : 'var(--text-secondary)',
            fontSize: 11,
          }}
        >
          {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: '10px 12px',
          overflowX: 'auto',
          fontSize: 12.5,
          lineHeight: 1.52,
        }}
      >
        <code>
          {lines.map((ln, idx) => (
            <div key={idx}>{highlightLine(ln, idx)}</div>
          ))}
        </code>
      </pre>
    </div>
  );
}
