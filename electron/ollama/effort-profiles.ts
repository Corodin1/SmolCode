import type { EffortLevel } from '../../src/shared/types';

export type VerifyDepth = 'syntax' | 'typecheck' | 'typecheck+tests' | 'full-audit';

export interface EffortProfile {
  level: EffortLevel;
  label: string;
  mainThink: boolean;
  numCtx: number;
  numPredict: number;
  maxMainSteps: number;
  stepTimeoutMs: number;
  verifyTimeoutMs: number;
  runFastScout: boolean;
  verifyDepth: VerifyDepth;
  temperature: number;
  guidanceHint: string;
}

export const EFFORT_SHARED_DEFAULTS = {
  numCtx: 12288,
  maxMainSteps: 14,
  stepTimeoutMs: 150_000,
  verifyTimeoutMs: 90_000,
  runFastScout: true,
  verifyDepth: 'typecheck+tests' as VerifyDepth,
  temperature: 0.2,
};

export const EFFORT_PROFILES: Record<EffortLevel, EffortProfile> = {
  low: {
    level: 'low',
    label: 'Low',
    mainThink: false,
    numPredict: 2048,
    guidanceHint:
      'Keep pre-action reasoning ultra-brief (1-2 quick observations) and invoke your next tool or answer immediately.',
    ...EFFORT_SHARED_DEFAULTS,
  },
  medium: {
    level: 'medium',
    label: 'Medium',
    mainThink: true,
    numPredict: 3072,
    guidanceHint:
      'Think concisely (~100-150 words) before acting: identify key symbols and plan your next action cleanly.',
    ...EFFORT_SHARED_DEFAULTS,
  },
  high: {
    level: 'high',
    label: 'High',
    mainThink: true,
    numPredict: 4608,
    guidanceHint:
      'Think carefully with detailed analysis before acting: trace callers, types, edge cases, and invariants prior to each action.',
    ...EFFORT_SHARED_DEFAULTS,
  },
  xhigh: {
    level: 'xhigh',
    label: 'Extra High',
    mainThink: true,
    numPredict: 6144,
    guidanceHint:
      'Perform exhaustive deep reasoning before acting: analyze root causes, cross-module side effects, failure modes, and alternatives thoroughly before making each move.',
    ...EFFORT_SHARED_DEFAULTS,
  },
};

export function getEffortProfile(level: EffortLevel): EffortProfile {
  return EFFORT_PROFILES[level] ?? EFFORT_PROFILES.medium;
}
