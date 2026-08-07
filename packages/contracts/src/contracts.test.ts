import { describe, expect, it } from 'vitest';

import coreErrorFixture from '../../../tests/contract-fixtures/core-error.json'
  with { type: 'json' };
import riskDecisionNoConfirmationFixture from '../../../tests/contract-fixtures/risk-decision-no-confirmation.json'
  with { type: 'json' };
import riskDecisionFixture from '../../../tests/contract-fixtures/risk-decision.json'
  with { type: 'json' };
import taskStatusFixture from '../../../tests/contract-fixtures/task-status.json'
  with { type: 'json' };
import toolCallFixture from '../../../tests/contract-fixtures/tool-call.json'
  with { type: 'json' };
import toolScopeViolationFixture from '../../../tests/contract-fixtures/tool-scope-violation.json'
  with { type: 'json' };
import {
  CORE_EVENTS,
  CoreErrorSchema,
  IdSchema,
  RiskDecisionSchema,
  TaskStatusSchema,
  ToolCallSchema,
} from './index.js';

describe('cross-runtime contracts', () => {
  it('rejects an approval decision without a reason', () => {
    const parsed = RiskDecisionSchema.safeParse({
      level: 'L2',
      approvalRequired: true,
      snapshotRequired: false,
    });

    expect(parsed.success).toBe(false);
  });

  it('parses the stable connection error fixture', () => {
    expect(CoreErrorSchema.parse(coreErrorFixture)).toEqual({
      code: 'SSH_HOST_KEY_CHANGED',
      message: 'blocked',
      retryable: false,
    });
  });

  it('keeps scope violations distinct from approval mismatches', () => {
    expect(CoreErrorSchema.parse(toolScopeViolationFixture).code)
      .toBe('TOOL_SCOPE_VIOLATION');
  });

  it('validates UUID identifiers and the shared tool call fixture', () => {
    expect(IdSchema.safeParse('server-1').success).toBe(false);
    expect(ToolCallSchema.parse(toolCallFixture)).toEqual(toolCallFixture);
  });

  it('parses all nine task states from the shared fixture', () => {
    expect(taskStatusFixture.map((status) => TaskStatusSchema.parse(status))).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'interrupted',
      'rolling_back',
      'rolled_back',
      'rollback_failed',
    ]);
  });

  it('parses the shared risk decision fixture', () => {
    expect(RiskDecisionSchema.parse(riskDecisionFixture)).toEqual(riskDecisionFixture);
  });

  it('parses a risk decision with no confirmation text', () => {
    expect(RiskDecisionSchema.parse(riskDecisionNoConfirmationFixture))
      .toEqual(riskDecisionNoConfirmationFixture);
  });

  it('exports the complete stable event name set without duplicates', () => {
    const eventNames = Object.values(CORE_EVENTS);

    expect(eventNames).toEqual([
      'connection:state',
      'terminal:data',
      'task:progress',
      'task:log',
      'metrics:update',
      'docker:stats',
      'agent:token',
      'agent:plan',
      'agent:tool_request',
      'agent:approval_required',
      'agent:run_state',
    ]);
    expect(new Set(eventNames).size).toBe(eventNames.length);
  });
});
