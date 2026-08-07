export const CORE_EVENTS = {
  CONNECTION_STATE: 'connection:state',
  TERMINAL_DATA: 'terminal:data',
  TASK_PROGRESS: 'task:progress',
  TASK_LOG: 'task:log',
  METRICS_UPDATE: 'metrics:update',
  DOCKER_STATS: 'docker:stats',
  AGENT_TOKEN: 'agent:token',
  AGENT_PLAN: 'agent:plan',
  AGENT_TOOL_REQUEST: 'agent:tool_request',
  AGENT_APPROVAL_REQUIRED: 'agent:approval_required',
  AGENT_RUN_STATE: 'agent:run_state',
} as const;

export type CoreEventName = (typeof CORE_EVENTS)[keyof typeof CORE_EVENTS];
