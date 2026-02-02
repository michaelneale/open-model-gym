export interface AgentConfig {
  model: string;
  provider: string;
  extensions?: string[];
  /** Stdio extension commands (for custom MCP servers) */
  stdioExtensions?: string[];
  temperature?: number;
  maxTokens?: number;
}

export interface Scenario {
  name: string;
  description: string;
  prompt: string;
  /** Files to create before running (relative paths) */
  setup?: Record<string, string>;
  /** Validation rules to check after agent completes */
  validate: ValidationRule[];
  /** Tags for filtering scenarios */
  tags?: string[];
}

export type ValidationRule =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; pattern: string }
  | { type: "file_matches"; path: string; regex: string }
  | { type: "file_not_empty"; path: string }
  | { type: "command_succeeds"; command: string }
  | { type: "custom"; fn: string };

export interface TestRun {
  scenario: Scenario;
  config: AgentConfig;
  workdir: string;
  startTime: Date;
  endTime?: Date;
  status: "pending" | "running" | "passed" | "failed";
  errors?: string[];
}

export interface TestResult {
  run: TestRun;
  validations: Array<{
    rule: ValidationRule;
    passed: boolean;
    message?: string;
  }>;
}

export interface SuiteConfig {
  /** Agent configurations to permute */
  agents: AgentConfig[];
  /** Scenarios to run */
  scenarios: string[];
  /** Base directory for test workspaces */
  workdir: string;
  /** Parallel execution count */
  parallel?: number;
}
