import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { TreeSitterService } from '../intel/tree-sitter-service';
import type { VerifyDepth } from '../ollama/effort-profiles';
import { executeSandboxedCommand } from './shell-tools';

export interface VerifyResult {
  ok: boolean;
  label: string;
  digest: string;
  savedTokensApprox: number;
}

export async function verifySyntaxGate(
  treeSitter: TreeSitterService,
  filePath: string,
  content: string,
): Promise<{ ok: boolean; errorsText: string }> {
  const issues = await treeSitter.checkSyntaxErrors(filePath, content);
  if (issues.length === 0) {
    return { ok: true, errorsText: '' };
  }
  const formatted = issues
    .map((iss) => `L${iss.line}:${iss.column} ${iss.message} -> ${iss.snippet}`)
    .join('\n');
  return { ok: false, errorsText: formatted };
}

function findMatchingTests(workdir: string, modifiedFiles: string[]): string[] {
  const candidates = new Set<string>();
  const stems = new Set<string>();

  for (const mf of modifiedFiles) {
    const norm = mf.replace(/\\/g, '/');
    if (/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/i.test(norm) || /_test\.py$/i.test(norm)) {
      if (existsSync(join(workdir, norm))) {
        candidates.add(norm);
      }
      continue;
    }
    const base = basename(norm, extname(norm)).toLowerCase();
    if (base && base !== 'index' && base !== 'types') {
      stems.add(base);
    }
  }

  if (stems.size === 0) return [...candidates];

  const walkTests = (dir: string) => {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'out') {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkTests(full);
      } else if (entry.isFile() && /\.(test|spec)\.(ts|tsx|js|jsx)|test_.*\.py$|.*_test\.py$/i.test(entry.name)) {
        const lower = entry.name.toLowerCase();
        for (const stem of stems) {
          if (lower.includes(stem)) {
            candidates.add(relative(workdir, full).replace(/\\/g, '/'));
            break;
          }
        }
      }
    }
  };

  walkTests(workdir);
  return [...candidates].slice(0, 6);
}

export function detectChecksForWorkspace(
  workdir: string,
  depth: VerifyDepth,
  modifiedFiles: string[] = [],
): Array<{ label: string; command: string }> {
  if (depth === 'syntax') return [];
  const checks: Array<{ label: string; command: string }> = [];

  const jsTsModified = modifiedFiles.filter((f) =>
    /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(f),
  );
  const pyModified = modifiedFiles.filter((f) => f.endsWith('.py'));
  const rsModified = modifiedFiles.filter((f) => f.endsWith('.rs') || f.endsWith('Cargo.toml'));
  const hasAnyCodeEdits =
    modifiedFiles.length === 0 ||
    jsTsModified.length > 0 ||
    pyModified.length > 0 ||
    rsModified.length > 0 ||
    modifiedFiles.some((f) => /\.(json|css|html)$/i.test(f));

  if (!hasAnyCodeEdits && depth !== 'full-audit') {
    return [];
  }

  const pkgPath = join(workdir, 'package.json');
  if (existsSync(pkgPath) && (modifiedFiles.length === 0 || jsTsModified.length > 0 || depth === 'full-audit')) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      if (existsSync(join(workdir, 'tsconfig.json'))) {
        if (pkg.scripts?.typecheck) {
          checks.push({ label: 'typecheck', command: 'npm run typecheck' });
        } else {
          checks.push({ label: 'tsc', command: 'npx tsc --noEmit --pretty false' });
        }
      } else if (pkg.scripts?.typecheck) {
        checks.push({ label: 'typecheck', command: 'npm run typecheck' });
      }

      if ((depth === 'typecheck+tests' || depth === 'full-audit') && pkg.scripts?.lint) {
        if (
          depth !== 'full-audit' &&
          jsTsModified.length > 0 &&
          /\beslint\b/i.test(pkg.scripts.lint)
        ) {
          const quotedLint = jsTsModified.slice(0, 12).map((f) => `"${f}"`).join(' ');
          checks.push({ label: 'lint', command: `npx eslint ${quotedLint}` });
        } else {
          checks.push({ label: 'lint', command: 'npm run lint' });
        }
      }

      if ((depth === 'typecheck+tests' || depth === 'full-audit') && pkg.scripts?.test) {
        const testScript = pkg.scripts.test;
        const targeted = findMatchingTests(workdir, modifiedFiles).filter((f) =>
          /\.(ts|tsx|js|jsx|mts|cts)$/i.test(f),
        );
        if (targeted.length > 0 && /vitest/i.test(testScript)) {
          const quoted = targeted.map((f) => `"${f}"`).join(' ');
          checks.push({ label: 'targeted tests', command: `npx vitest run ${quoted}` });
          if (depth === 'full-audit') {
            checks.push({ label: 'full test suite', command: 'npm test' });
          }
        } else {
          checks.push({ label: 'test', command: 'npm test' });
        }
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  if (existsSync(join(workdir, 'Cargo.toml')) && (modifiedFiles.length === 0 || rsModified.length > 0 || depth === 'full-audit')) {
    checks.push({ label: 'cargo check', command: 'cargo check --message-format=short' });
    if (depth === 'full-audit') {
      checks.push({ label: 'cargo clippy', command: 'cargo clippy --message-format=short' });
    }
    if (depth === 'typecheck+tests' || depth === 'full-audit') {
      checks.push({ label: 'cargo test', command: 'cargo test' });
    }
  }

  if (
    (existsSync(join(workdir, 'pyproject.toml')) || existsSync(join(workdir, 'pytest.ini'))) &&
    (modifiedFiles.length === 0 || pyModified.length > 0 || depth === 'full-audit')
  ) {
    if (
      (depth === 'typecheck+tests' || depth === 'full-audit') &&
      pyModified.length > 0 &&
      existsSync(join(workdir, 'ruff.toml'))
    ) {
      const quoted = pyModified.map((f) => `"${f}"`).join(' ');
      checks.push({ label: 'ruff', command: `ruff check ${quoted}` });
    }
    if (depth === 'typecheck+tests' || depth === 'full-audit') {
      const pyTests = findMatchingTests(workdir, modifiedFiles).filter((f) => f.endsWith('.py'));
      if (pyTests.length > 0) {
        const quoted = pyTests.map((f) => `"${f}"`).join(' ');
        checks.push({ label: 'targeted pytest', command: `python -m pytest -q ${quoted}` });
        if (depth === 'full-audit') {
          checks.push({ label: 'pytest', command: 'python -m pytest -q' });
        }
      } else {
        checks.push({ label: 'pytest', command: 'python -m pytest -q' });
      }
    }
  }

  return checks;
}

export async function runStageBVerification(
  workdir: string,
  depth: VerifyDepth,
  modifiedFiles: string[],
  signal?: AbortSignal,
  timeoutMs = 45_000,
): Promise<VerifyResult[]> {
  if (modifiedFiles.length === 0 || depth === 'syntax') {
    return [];
  }

  const pyModified = modifiedFiles.filter((f) => f.endsWith('.py'));
  const checks = detectChecksForWorkspace(workdir, depth, modifiedFiles);

  if (pyModified.length > 0 && checks.length === 0) {
    const quoted = pyModified.map((f) => `"${f}"`).join(' ');
    checks.push({ label: 'py_compile', command: `python -m py_compile ${quoted}` });
  }

  const results: VerifyResult[] = [];
  for (const chk of checks) {
    const cmdRes = await executeSandboxedCommand({
      command: chk.command,
      cwd: workdir,
      timeoutMs,
      signal,
    });
    if (cmdRes.exitCode === 0) {
      results.push({
        ok: true,
        label: chk.label,
        digest: cmdRes.output || `${chk.label} passed`,
        savedTokensApprox: cmdRes.savedTokensApprox,
      });
    } else {
      results.push({
        ok: false,
        label: chk.label,
        digest: cmdRes.output,
        savedTokensApprox: cmdRes.savedTokensApprox,
      });
      break;
    }
  }

  return results;
}
