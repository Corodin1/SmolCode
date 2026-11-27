import type { EffortLevel, InteractionMode } from '../../src/shared/types';

export type VerifyDepth = 'syntax' | 'typecheck' | 'typecheck+tests' | 'full-audit';

export interface EffortProfile {
  level: EffortLevel;
  label: string;
  mainThink: boolean;
  numCtx: number;
  numPredict: number;
  stepTimeoutMs: number;
  verifyTimeoutMs: number;
  runFastScout: boolean;
  verifyDepth: VerifyDepth;
  temperature: number;
  guidanceHint: string;
  systemDirective: string;
  planDirective: string;
}

export const EFFORT_PROFILES: Record<EffortLevel, EffortProfile> = {
  low: {
    level: 'low',
    label: 'Low',
    mainThink: false,
    numCtx: 8192,
    numPredict: 2048,
    stepTimeoutMs: 90_000,
    verifyTimeoutMs: 45_000,
    runFastScout: false,
    verifyDepth: 'syntax',
    temperature: 0.15,
    guidanceHint:
      'Move fast with short, direct pre-action notes and deliver simple, minimal code.',
    systemDirective: [
      'Reasoning Mode: LOW (Fast & Minimal)',
      '- Write simple, short, direct code that solves the exact request with minimal surface area.',
      '- Make the smallest targeted edit possible; do NOT introduce extra abstractions, wrapper layers, or speculative helper files.',
      '- Do NOT refactor unrelated code or create new test suites unless explicitly requested.',
      '- Keep pre-action reasoning ultra-brief and present a concise final answer.',
    ].join('\n'),
    planDirective: [
      'Reasoning Mode: LOW (Brief Plan)',
      '- Produce a short, minimal plan (3-5 concise steps) covering only the essential edits.',
      '- Keep scope tight; avoid speculative architecture or extra phases.',
    ].join('\n'),
  },
  medium: {
    level: 'medium',
    label: 'Medium',
    mainThink: true,
    numCtx: 12288,
    numPredict: 3072,
    stepTimeoutMs: 150_000,
    verifyTimeoutMs: 90_000,
    runFastScout: true,
    verifyDepth: 'typecheck+tests',
    temperature: 0.2,
    guidanceHint:
      'Think concisely (~100-150 words) and write clean, pragmatic, well-structured code.',
    systemDirective: [
      'Reasoning Mode: MEDIUM (Balanced & Pragmatic)',
      '- Write clean, idiomatic, well-structured code sized appropriately for the task.',
      '- Handle obvious edge cases and error states cleanly without over-engineering.',
      '- Reuse existing project helpers and conventions; decompose only where clarity genuinely benefits.',
      '- Verify modified files and keep your final summary focused and clear.',
    ].join('\n'),
    planDirective: [
      'Reasoning Mode: MEDIUM (Balanced Plan)',
      '- Produce a clear, pragmatic plan (4-7 steps) identifying target files, core changes, and verification checks.',
    ].join('\n'),
  },
  high: {
    level: 'high',
    label: 'High',
    mainThink: true,
    numCtx: 16384,
    numPredict: 4608,
    stepTimeoutMs: 180_000,
    verifyTimeoutMs: 120_000,
    runFastScout: true,
    verifyDepth: 'typecheck+tests',
    temperature: 0.2,
    guidanceHint:
      'Analyze callers, types, edge cases, and invariants carefully; deliver modular code with tests.',
    systemDirective: [
      'Reasoning Mode: HIGH (Thorough & Modular)',
      '- Inspect callers, types, contracts, and invariants across related files before editing.',
      '- Design clean, modular functions/components with strong typing, solid error handling, and boundary guards.',
      '- Add or update focused tests covering both primary paths and edge cases.',
      '- Verify typecheck, lint, and relevant tests before finishing.',
    ].join('\n'),
    planDirective: [
      'Reasoning Mode: HIGH (Detailed Technical Plan)',
      '- Trace module dependencies, types, and edge cases; produce a detailed plan with concrete file changes and test coverage.',
    ].join('\n'),
  },
  xhigh: {
    level: 'xhigh',
    label: 'Ultra',
    mainThink: true,
    numCtx: 24576,
    numPredict: 8192,
    stepTimeoutMs: 240_000,
    verifyTimeoutMs: 180_000,
    runFastScout: true,
    verifyDepth: 'full-audit',
    temperature: 0.22,
    guidanceHint:
      'Treat as a refined, full-craft project: deep architecture, edge-case hardening, polish, and full-audit verification.',
    systemDirective: [
      'Reasoning Mode: ULTRA (Maximum Rigor & Craft)',
      '- Treat the request as a refined, cohesive, production-grade project—go deep on architecture, polish, and completeness.',
      '- Analyze root causes, cross-module side effects, concurrency/state transitions, failure modes, and UI/UX ergonomics before editing.',
      '- Organize code into clean, decoupled, well-documented modules with no duplicated logic and thorough edge-case/error handling.',
      '- Write comprehensive tests (happy paths, boundary cases, and regressions), and perform a careful self-review/cleanup pass before finishing.',
    ].join('\n'),
    planDirective: [
      'Reasoning Mode: ULTRA (Architecture-Grade Plan)',
      '- Clarify open design trade-offs via request_user_input when ambiguous.',
      '- Produce an exhaustive, multi-phase architectural plan detailing system boundaries, edge cases, failure recovery, polish, and full-suite verification.',
    ].join('\n'),
  },
};

export function getEffortProfile(level: EffortLevel): EffortProfile {
  return EFFORT_PROFILES[level] ?? EFFORT_PROFILES.medium;
}

export function formatEffortSystemDirective(
  level: EffortLevel,
  interactionMode: InteractionMode = 'build',
): string {
  const profile = getEffortProfile(level);
  return interactionMode === 'plan' ? profile.planDirective : profile.systemDirective;
}
