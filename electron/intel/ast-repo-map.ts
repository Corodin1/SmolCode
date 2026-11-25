import type { RepoIndex } from './repo-indexer';

export interface RankedFile {
  relPath: string;
  score: number;
}

export function rankFilesWithPageRank(
  index: RepoIndex,
  seedFiles: string[],
  iterations = 12,
  damping = 0.85,
): RankedFile[] {
  const nodes = [...index.files.keys()];
  const n = nodes.length;
  if (n === 0) return [];

  const seedSet = new Set(seedFiles.filter((f) => index.files.has(f)));
  const personal = new Map<string, number>();

  for (const node of nodes) {
    if (seedSet.size > 0) {
      personal.set(node, seedSet.has(node) ? 1 / seedSet.size : 0);
    } else {
      const symBonus = 1 + (index.files.get(node)?.symbols.length ?? 0) * 0.2;
      personal.set(node, symBonus);
    }
  }

  // Normalize personalization vector
  const pSum = [...personal.values()].reduce((a, b) => a + b, 0) || 1;
  for (const node of nodes) {
    personal.set(node, (personal.get(node) ?? 0) / pSum);
  }

  let ranks = new Map<string, number>(personal);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>();
    for (const node of nodes) {
      next.set(node, (1 - damping) * (personal.get(node) ?? 0));
    }

    let danglingMass = 0;
    for (const node of nodes) {
      const r = ranks.get(node) ?? 0;
      const outNeighbors = index.adjacency.get(node);
      const inNeighbors = index.reverseAdj.get(node);
      // Treat dependency graph bidirectionally with slight bias toward imported targets
      const neighbors = new Set<string>([
        ...(outNeighbors ?? []),
        ...(inNeighbors ?? []),
      ]);
      if (neighbors.size === 0) {
        danglingMass += r;
        continue;
      }
      const share = (damping * r) / neighbors.size;
      for (const nb of neighbors) {
        next.set(nb, (next.get(nb) ?? 0) + share);
      }
    }

    if (danglingMass > 0) {
      for (const node of nodes) {
        next.set(node, (next.get(node) ?? 0) + damping * danglingMass * (personal.get(node) ?? 0));
      }
    }

    ranks = next;
  }

  return [...ranks.entries()]
    .map(([relPath, score]) => ({ relPath, score }))
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
}

export function buildAstRepoSkeleton(
  index: RepoIndex,
  seedFiles: string[],
  maxChars = 4800,
): { skeleton: string; estimatedTokensSaved: number; topFiles: string[] } {
  const ranked = rankFilesWithPageRank(index, seedFiles);
  const lines: string[] = [];
  const topFiles: string[] = [];
  let currentChars = 0;
  let totalIndexFiles = 0;

  for (const { relPath } of ranked) {
    totalIndexFiles += 1;
    const info = index.files.get(relPath);
    if (!info) continue;

    const header = `${relPath}${info.lineCount ? ` [${info.lineCount}L]` : ''}`;
    const symbolLines = info.symbols
      .slice(0, 14)
      .map((s) => `  ${s.kind} ${s.name} [L${s.startLine}-${s.endLine}]`);

    const block = [header, ...symbolLines].join('\n');
    if (currentChars + block.length + 1 > maxChars && topFiles.length >= 6) {
      break;
    }

    lines.push(block);
    topFiles.push(relPath);
    currentChars += block.length + 1;
  }

  const omitted = Math.max(0, totalIndexFiles - topFiles.length);
  if (omitted > 0) {
    lines.push(`... (+${omitted} more files searchable via repo_search)`);
  }

  // Approximate tokens saved vs reading top 6 files in full (~280 lines avg * 35 chars / 4)
  const avgFullChars = topFiles.slice(0, 6).reduce((acc, f) => {
    const info = index.files.get(f);
    return acc + Math.max(80, info?.lineCount ?? 120) * 34;
  }, 0);
  const estimatedTokensSaved = Math.max(0, Math.round((avgFullChars - currentChars) / 4));

  return {
    skeleton: lines.join('\n'),
    estimatedTokensSaved,
    topFiles,
  };
}

export interface RetrievedTarget {
  filePath: string;
  symbolName?: string;
  startLine?: number;
  endLine?: number;
  score: number;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'where',
  'what', 'which', 'should', 'would', 'could', 'please', 'make', 'update', 'fix',
  'change', 'check', 'verify', 'code', 'file', 'function', 'class', 'method',
  'error', 'issue', 'bug', 'test', 'tests', 'run', 'using', 'before', 'after',
]);

function extractPromptTokens(prompt: string): string[] {
  const rawTokens = prompt.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const tok of rawTokens) {
    const lower = tok.toLowerCase();
    if (!STOP_WORDS.has(lower)) {
      out.add(lower);
    }
    // Split camelCase and snake_case parts
    const parts = tok
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 3 && !STOP_WORDS.has(p));
    for (const p of parts) {
      out.add(p);
    }
  }
  return [...out].slice(0, 24);
}

/**
 * Deterministic Stage 1.5 pre-retrieval (0 LLM tokens, <5ms).
 * Matches AST symbol names, file stems, and PageRank graph centrality against the prompt.
 */
export function retrieveRelevantTargets(
  index: RepoIndex,
  prompt: string,
  seedFiles: string[] = [],
  limit = 4,
): RetrievedTarget[] {
  const tokens = extractPromptTokens(prompt);
  if (tokens.length === 0 || index.files.size === 0) return [];

  const ranked = rankFilesWithPageRank(index, seedFiles);
  const rankBonus = new Map<string, number>();
  for (let i = 0; i < ranked.length; i++) {
    rankBonus.set(ranked[i].relPath, ((ranked.length - i) / ranked.length) * 2.5);
  }

  const candidates: RetrievedTarget[] = [];

  for (const [relPath, info] of index.files) {
    const lowerPath = relPath.toLowerCase();
    const stem = lowerPath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
    let fileScore = rankBonus.get(relPath) ?? 0;

    for (const tok of tokens) {
      if (stem === tok) fileScore += 8;
      else if (lowerPath.includes(tok)) fileScore += 3.5;
    }

    let bestSym: { name: string; startLine: number; endLine: number; score: number } | null = null;
    for (const sym of info.symbols) {
      const lowerSym = sym.name.toLowerCase();
      const shortSym = lowerSym.split('.').pop() ?? lowerSym;
      let symScore = 0;
      for (const tok of tokens) {
        if (shortSym === tok) symScore += 12;
        else if (lowerSym.includes(tok)) symScore += 5;
      }
      if (symScore > 0 && (!bestSym || symScore > bestSym.score)) {
        bestSym = {
          name: sym.name,
          startLine: sym.startLine,
          endLine: sym.endLine,
          score: symScore,
        };
      }
    }

    const totalScore = fileScore + (bestSym?.score ?? 0);
    if (totalScore >= 6) {
      candidates.push({
        filePath: relPath,
        ...(bestSym
          ? { symbolName: bestSym.name, startLine: bestSym.startLine, endLine: bestSym.endLine }
          : { startLine: 1, endLine: Math.min(80, Math.max(1, info.lineCount)) }),
        score: totalScore,
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, limit);
}
