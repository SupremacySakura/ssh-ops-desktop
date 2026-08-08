import { AgentPlanSchema, type AgentPlan, type AgentRunStatus } from '@opspilot/contracts';

export interface PlanningModel {
  plan(runId: string, input: string, signal: AbortSignal): Promise<AgentPlan>;
  summarize(results: unknown[], signal: AbortSignal): Promise<string>;
}

export interface AgentToolClient {
  request(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}

export type AgentRuntimeEvent =
  | { type: 'state'; status: AgentRunStatus }
  | { type: 'plan'; plan: AgentPlan }
  | { type: 'tool'; name: string; result: unknown }
  | { type: 'summary'; summary: string };

export class AgentRunCoordinator {
  readonly #controller = new AbortController();
  readonly #model: PlanningModel;
  readonly #tools: AgentToolClient;
  readonly #emit: (event: AgentRuntimeEvent) => void;
  #terminal = false;

  constructor(
    model: PlanningModel,
    tools: AgentToolClient,
    emit: (event: AgentRuntimeEvent) => void,
  ) {
    this.#model = model;
    this.#tools = tools;
    this.#emit = emit;
  }

  cancel(): void {
    if (!this.#terminal) this.#controller.abort();
  }

  async run(runId: string, input: string): Promise<string> {
    try {
      this.#emit({ type: 'state', status: 'planning' });
      const plan = AgentPlanSchema.parse(await this.#model.plan(runId, input, this.#controller.signal));
      this.#throwIfCancelled();
      this.#emit({ type: 'plan', plan });
      const results: unknown[] = [];
      for (const step of plan.steps) {
        if (step.toolName === undefined) continue;
        this.#throwIfCancelled();
        this.#emit({ type: 'state', status: 'awaiting_tool' });
        const result = await this.#tools.request(step.toolName, { stepId: step.id }, this.#controller.signal);
        this.#throwIfCancelled();
        results.push(result);
        this.#emit({ type: 'tool', name: step.toolName, result });
      }
      this.#emit({ type: 'state', status: 'summarizing' });
      const summary = await this.#model.summarize(results, this.#controller.signal);
      this.#throwIfCancelled();
      this.#emit({ type: 'summary', summary });
      this.#terminal = true;
      this.#emit({ type: 'state', status: 'succeeded' });
      return summary;
    } catch (error) {
      this.#terminal = true;
      this.#emit({ type: 'state', status: this.#controller.signal.aborted ? 'cancelled' : 'failed' });
      throw error;
    }
  }

  #throwIfCancelled(): void {
    if (this.#controller.signal.aborted) throw new DOMException('Agent run cancelled', 'AbortError');
  }
}
