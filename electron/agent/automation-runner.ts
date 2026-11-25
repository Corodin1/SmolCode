import type { AutomationRule } from '../../src/shared/types';
import type { SmolCodeStore } from '../store/database';
import type { AgentOrchestrator } from './orchestrator';

function parseIntervalMinutes(cronExpr: string): number {
  const trimmed = cronExpr.trim();
  const everyMin = trimmed.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyMin) return Math.max(1, Number(everyMin[1]));
  if (trimmed === '0 * * * *') return 60;
  return 60;
}

export class AutomationRunner {
  private timer: NodeJS.Timeout | null = null;
  private runningIds = new Set<string>();

  constructor(
    private readonly store: SmolCodeStore,
    private readonly orchestrator: AgentOrchestrator,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 60_000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const rules = this.store.listAutomations().filter((r) => r.enabled);
    for (const rule of rules) {
      if (this.runningIds.has(rule.id)) continue;
      const intervalMs = parseIntervalMinutes(rule.cronExpr) * 60_000;
      if (rule.lastRunAt && now - rule.lastRunAt < intervalMs) continue;
      void this.runNow(rule);
    }
  }

  async runNow(rule: AutomationRule): Promise<void> {
    if (this.runningIds.has(rule.id)) return;
    this.runningIds.add(rule.id);

    try {
      const project = this.store.getProject(rule.projectId);
      if (!project) return;

      const settings = this.store.getSettings();
      const tempThreadId = crypto.randomUUID();

      const thread = this.store.createThread({
        id: tempThreadId,
        projectId: project.id,
        title: `[Auto] ${rule.name}`,
        mainModel: settings.defaultMainModel,
        fastModel: settings.defaultFastModel,
        effort: settings.defaultEffort,
        approvalPolicy: settings.defaultApprovalPolicy,
        draftText: '',
        draftChips: [],
        status: 'queued',
        unread: true,
        pinned: false,
      });

      this.store.saveAutomation({
        ...rule,
        lastRunAt: Date.now(),
        lastStatus: 'running',
        lastThreadId: thread.id,
      });

      await this.orchestrator.runUserTurn({
        threadId: thread.id,
        content: rule.prompt,
        priority: 2, // Background automation lowest priority on shared 8GB GPU
      });

      this.store.saveAutomation({
        ...rule,
        lastRunAt: Date.now(),
        lastStatus: 'ok',
        lastThreadId: thread.id,
      });
    } catch {
      this.store.saveAutomation({
        ...rule,
        lastRunAt: Date.now(),
        lastStatus: 'error',
      });
    } finally {
      this.runningIds.delete(rule.id);
    }
  }
}
