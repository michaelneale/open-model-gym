#!/usr/bin/env node
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { readFileSync } from "node:fs";
import type { Scenario, TestResult, TestRun } from "./types.js";
import { validateAll } from "./validator.js";

// =============================================================================
// Types
// =============================================================================

type RunnerType = "goose" | "opencode";

interface ModelConfig {
  name: string;
  provider: string;
  model: string;
}

interface RunnerConfig {
  name: string;
  type: RunnerType;
  bin: string;
  extensions?: string[];  // goose-specific
  stdio?: string[];       // MCP servers
}

interface MatrixEntry {
  scenario: string;
  models?: string[];   // omit = all models
  runners?: string[];  // omit = all runners
}

interface SuiteConfig {
  models: ModelConfig[];
  runners: RunnerConfig[];
  matrix?: MatrixEntry[];
}

// A test pair: scenario × model × runner
interface TestPair {
  scenario: Scenario;
  model: ModelConfig;
  runner: RunnerConfig;
}

interface TestResultWithLog extends TestResult {
  logFile: string;
  runnerName: string;
}

// =============================================================================
// Goose Runner
// =============================================================================

const PLATFORM_EXTENSIONS = new Set([
  "todo", "skills", "code_execution", "extensionmanager", 
  "chatrecall", "apps", "imagegenerator"
]);

// Isolated goose config directory
const GOOSE_ROOT = join(import.meta.dirname, "../.goose-root");
const GOOSE_CONFIG_DIR = join(GOOSE_ROOT, "config");

function generateGooseConfig(model: ModelConfig, runner: RunnerConfig): object {
  const extensions: Record<string, object> = {};

  // Add extensions (detect platform vs builtin)
  for (const ext of runner.extensions ?? []) {
    if (PLATFORM_EXTENSIONS.has(ext)) {
      extensions[ext] = {
        enabled: true,
        type: "platform",
        name: ext,
        bundled: true,
      };
    } else {
      extensions[ext] = {
        enabled: true,
        type: "builtin",
        name: ext,
        timeout: 300,
        bundled: true,
      };
    }
  }

  // Add stdio MCP servers
  for (const extCmd of runner.stdio ?? []) {
    const parts = extCmd.split(" ");
    const cmd = parts[0];
    const args = parts.slice(1);
    const name = basename(args[args.length - 1] || cmd).replace(/\.[^.]+$/, "");

    extensions[name] = {
      enabled: true,
      type: "stdio",
      name,
      cmd,
      args,
      timeout: 300,
    };
  }

  return {
    extensions,
    GOOSE_PROVIDER: model.provider,
    GOOSE_MODEL: model.model,
    GOOSE_TELEMETRY_ENABLED: false,
  };
}

async function runGooseAgent(
  model: ModelConfig,
  runner: RunnerConfig,
  prompt: string,
  workdir: string
): Promise<string> {
  const promptFile = join(workdir, ".goose-prompt.txt");
  writeFileSync(promptFile, prompt);

  // Write goose config
  mkdirSync(GOOSE_CONFIG_DIR, { recursive: true });
  const gooseConfig = generateGooseConfig(model, runner);
  writeFileSync(join(GOOSE_CONFIG_DIR, "config.yaml"), stringify(gooseConfig));

  const cmd = `${runner.bin} run -i "${promptFile}" --no-session`;
  console.log(`  Running: ${runner.bin} run -i <prompt> --no-session`);

  const output = execSync(cmd, {
    cwd: workdir,
    env: {
      ...process.env,
      GOOSE_PATH_ROOT: GOOSE_ROOT,
      MCP_HARNESS_LOG: join(workdir, "tool-calls.log"),
    },
    timeout: 5 * 60 * 1000,
    encoding: "utf-8",
  });

  return output;
}

// =============================================================================
// OpenCode Runner
// =============================================================================

// Isolated opencode config directory
const OPENCODE_ROOT = join(import.meta.dirname, "../.opencode-root");

function generateOpenCodeConfig(model: ModelConfig, runner: RunnerConfig, workdir: string): object {
  const mcp: Record<string, object> = {};

  // Add stdio MCP servers
  for (const extCmd of runner.stdio ?? []) {
    const parts = extCmd.split(" ");
    const cmd = parts[0];
    const args = parts.slice(1);
    const name = basename(args[args.length - 1] || cmd).replace(/\.[^.]+$/, "");

    mcp[name] = {
      type: "local",
      command: [cmd, ...args],
      enabled: true,
      environment: {
        MCP_HARNESS_LOG: join(workdir, "tool-calls.log"),
      },
    };
  }

  const config: Record<string, any> = {
    $schema: "https://opencode.ai/config.json",
    mcp,
  };

  // Handle ollama as a custom provider (OpenCode doesn't have built-in ollama support)
  if (model.provider === "ollama") {
    config.model = `ollama/${model.model}`;
    config.provider = {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama (local)",
        options: {
          baseURL: "http://localhost:11434/v1",
        },
        models: {
          [model.model]: {
            name: model.name,
          },
        },
      },
    };
  } else {
    // Standard providers (anthropic, openai, etc.)
    config.model = `${model.provider}/${model.model}`;
  }

  return config;
}

async function runOpenCodeAgent(
  model: ModelConfig,
  runner: RunnerConfig,
  prompt: string,
  workdir: string
): Promise<string> {
  // Write opencode.json config to workdir
  const openCodeConfig = generateOpenCodeConfig(model, runner, workdir);
  writeFileSync(join(workdir, "opencode.json"), JSON.stringify(openCodeConfig, null, 2));

  // Write prompt to file
  const promptFile = join(workdir, ".opencode-prompt.txt");
  writeFileSync(promptFile, prompt);

  // Ensure isolated config directory exists
  mkdirSync(OPENCODE_ROOT, { recursive: true });

  const cmd = `${runner.bin} run "$(cat "${promptFile}")"`;
  console.log(`  Running: ${runner.bin} run "<prompt>"`);

  const output = execSync(cmd, {
    cwd: workdir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: OPENCODE_ROOT,  // Isolate opencode config
      XDG_DATA_HOME: OPENCODE_ROOT,    // Isolate opencode data
    },
    timeout: 5 * 60 * 1000,
    encoding: "utf-8",
    shell: "/bin/bash",
  });

  return output;
}

// =============================================================================
// Unified Runner
// =============================================================================

async function runAgent(
  model: ModelConfig,
  runner: RunnerConfig,
  prompt: string,
  workdir: string
): Promise<string> {
  if (runner.type === "opencode") {
    return runOpenCodeAgent(model, runner, prompt, workdir);
  }
  return runGooseAgent(model, runner, prompt, workdir);
}

// =============================================================================
// Scenario & Config Loading
// =============================================================================

function loadScenario(path: string): Scenario {
  const content = readFileSync(path, "utf-8");
  return parse(content) as Scenario;
}

function loadAllScenarios(dir: string): Scenario[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  return files.map((f) => loadScenario(join(dir, f)));
}

function loadConfig(configPath: string): SuiteConfig {
  const content = readFileSync(configPath, "utf-8");
  const config = parse(content) as SuiteConfig;
  const configDir = join(configPath, "..");

  // Resolve relative paths in stdio for all runners
  for (const runner of config.runners) {
    if (runner.stdio) {
      runner.stdio = runner.stdio.map((ext) => {
        const parts = ext.split(" ");
        const cmd = parts[0];
        const args = parts.slice(1).map((arg) => {
          if (!arg.startsWith("/") && (arg.includes("/") || arg.startsWith("."))) {
            return join(configDir, arg);
          }
          return arg;
        });
        return [cmd, ...args].join(" ");
      });
    }
  }

  return config;
}

function setupWorkdir(scenario: Scenario, workdir: string): void {
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });

  if (scenario.setup) {
    for (const [path, content] of Object.entries(scenario.setup)) {
      const fullPath = join(workdir, path);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }
}

// =============================================================================
// Test Execution
// =============================================================================

function buildTestPairs(config: SuiteConfig, scenarios: Scenario[]): TestPair[] {
  const modelsByName = new Map(config.models.map((m) => [m.name, m]));
  const runnersByName = new Map(config.runners.map((r) => [r.name, r]));

  const pairs: TestPair[] = [];

  if (config.matrix?.length) {
    for (const entry of config.matrix) {
      const scenario = scenarios.find((s) => s.name === entry.scenario);
      if (!scenario) continue;

      const models = entry.models
        ? entry.models.map((n) => modelsByName.get(n)).filter(Boolean) as ModelConfig[]
        : config.models;

      const runners = entry.runners
        ? entry.runners.map((n) => runnersByName.get(n)).filter(Boolean) as RunnerConfig[]
        : config.runners;

      for (const model of models) {
        for (const runner of runners) {
          pairs.push({ scenario, model, runner });
        }
      }
    }
    return pairs;
  }

  // No matrix: all scenarios × all models × all runners
  for (const scenario of scenarios) {
    for (const model of config.models) {
      for (const runner of config.runners) {
        pairs.push({ scenario, model, runner });
      }
    }
  }
  return pairs;
}

function scoreResult(result: TestResultWithLog): number {
  if (result.run.status === "failed" && result.run.errors?.length) {
    return -1;
  }
  const passedCount = result.validations.filter((v) => v.passed).length;
  const statusBonus = result.run.status === "passed" ? 1000 : 0;
  return statusBonus + passedCount;
}

async function runScenario(
  pair: TestPair,
  baseWorkdir: string,
  logsDir: string,
  attempt: number = 1
): Promise<TestResultWithLog> {
  const { scenario, model, runner } = pair;
  const testId = `${scenario.name}_${model.name}_${runner.name}`.replace(/[\/\\:]/g, "_");
  const workdir = join(baseWorkdir, testId);
  const logFile = join(logsDir, `${testId}_attempt${attempt}.log`);

  console.log(`\n▶ ${scenario.name} [${model.provider}/${model.model}] (${runner.name})`);

  setupWorkdir(scenario, workdir);
  mkdirSync(logsDir, { recursive: true });

  // Create a minimal config for TestRun compatibility
  const config = {
    provider: model.provider,
    model: model.model,
    extensions: runner.extensions,
    stdio: runner.stdio,
  };

  const run: TestRun = {
    scenario,
    config,
    workdir,
    startTime: new Date(),
    status: "running",
  };

  let output = "";
  try {
    output = await runAgent(model, runner, scenario.prompt, workdir);
    run.endTime = new Date();

    const validations = validateAll(scenario.validate, workdir);
    const allPassed = validations.every((v) => v.result.passed);

    writeFileSync(logFile, output);

    return {
      run: { ...run, status: allPassed ? "passed" : "failed" },
      validations: validations.map((v) => ({
        rule: v.rule,
        passed: v.result.passed,
        message: v.result.message,
      })),
      logFile,
      runnerName: runner.name,
    };
  } catch (err) {
    const errorOutput = output + "\n\nERROR:\n" + String(err);
    writeFileSync(logFile, errorOutput);

    return {
      run: {
        ...run,
        status: "failed",
        endTime: new Date(),
        errors: [String(err)],
      },
      validations: [],
      logFile,
      runnerName: runner.name,
    };
  }
}

// =============================================================================
// Reporting
// =============================================================================

function pairKey(pair: TestPair): string {
  return `${pair.model.name}::${pair.runner.name}`;
}

function resultKey(result: TestResultWithLog): string {
  return `${result.run.config.provider}/${result.run.config.model}::${result.runnerName}`;
}

interface ReportOptions {
  isRunning?: boolean;
  allPairs?: TestPair[];
}

function generateHtmlReport(
  results: TestResultWithLog[],
  outputPath: string,
  options: ReportOptions = {}
): void {
  const { isRunning = false, allPairs = [] } = options;

  // Get all scenarios (columns)
  const scenarios = allPairs.length
    ? [...new Set(allPairs.map((p) => p.scenario.name))]
    : [...new Set(results.map((r) => r.run.scenario.name))];

  // Rows are model × runner combinations
  const rowKeys = allPairs.length
    ? [...new Set(allPairs.map(pairKey))]
    : [...new Set(results.map((r) => `${r.run.config.provider}/${r.run.config.model}::${r.runnerName}`))];

  // Map row key -> pair info
  const rowsByKey = new Map<string, { model: ModelConfig; runner: RunnerConfig }>();
  for (const pair of allPairs) {
    rowsByKey.set(pairKey(pair), { model: pair.model, runner: pair.runner });
  }

  const getResult = (scenario: string, rowKey: string) => {
    const [modelPart, runnerName] = rowKey.split("::");
    return results.find(
      (r) =>
        r.run.scenario.name === scenario &&
        `${r.run.config.provider}/${r.run.config.model}` === `${rowsByKey.get(rowKey)?.model.provider}/${rowsByKey.get(rowKey)?.model.model}` &&
        r.runnerName === runnerName
    );
  };

  const passed = results.filter((r) => r.run.status === "passed").length;
  const failed = results.filter((r) => r.run.status === "failed").length;
  const total = allPairs.length || results.length;
  const pending = total - results.length;

  const runnerNames = [...new Set(allPairs.map((p) => p.runner.name))];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${isRunning ? '<meta http-equiv="refresh" content="3">' : ""}
  <title>${isRunning ? "Running..." : "Results"} - Agent Tests</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; }
    h1 { color: #58a6ff; margin-bottom: 0.5rem; }
    .summary { color: #8b949e; margin-bottom: 2rem; font-size: 1.1rem; }
    .summary .passed { color: #3fb950; }
    .summary .failed { color: #f85149; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
    th, td { padding: 1rem; text-align: left; border-bottom: 1px solid #30363d; }
    th { background: #21262d; color: #58a6ff; font-weight: 600; }
    th:first-child { position: sticky; left: 0; background: #21262d; z-index: 1; }
    td:first-child { position: sticky; left: 0; background: #161b22; font-weight: 500; }
    .cell { display: flex; align-items: center; gap: 0.5rem; }
    .status { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; }
    .status.passed { background: #238636; }
    .status.failed { background: #da3633; }
    .status.pending { background: #6e7681; }
    .status.running { background: #9e6a03; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .duration { color: #8b949e; font-size: 0.85rem; }
    .log-link { color: #58a6ff; font-size: 0.75rem; text-decoration: none; }
    .log-link:hover { text-decoration: underline; }
    .details { font-size: 0.8rem; max-width: 300px; }
    .validation { display: flex; align-items: center; gap: 0.25rem; margin-top: 0.25rem; }
    .validation.pass { color: #3fb950; }
    .validation.fail { color: #f85149; }
    .validation-icon { font-size: 0.7rem; }
    .row-header { font-size: 0.75rem; }
    .row-header .model { display: block; color: #c9d1d9; font-weight: 600; }
    .row-header .runner { color: #58a6ff; }
    .row-header .runner-type { color: #8b949e; font-size: 0.7rem; }
    .runner-info { color: #6e7681; font-size: 0.85rem; margin-bottom: 1.5rem; }
    .runner-info code { background: #21262d; padding: 0.2rem 0.4rem; border-radius: 4px; font-family: monospace; }
    .timestamp { color: #6e7681; font-size: 0.9rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>Agent Scenario Test Results${isRunning ? " (Running...)" : ""}</h1>
  <p class="summary">
    <span class="passed">${passed} passed</span> / 
    <span class="failed">${failed} failed</span>${pending > 0 ? ` / <span style="color:#9e6a03">${pending} pending</span>` : ""} / 
    ${total} total
  </p>
  <p class="runner-info">Runners: ${runnerNames.map(n => `<code>${n}</code>`).join(", ")}</p>
  
  <table>
    <thead>
      <tr>
        <th>Model</th>
        <th>Runner</th>
        ${scenarios.map((s) => `<th>${s}</th>`).join("")}
      </tr>
    </thead>
    <tbody>
      ${rowKeys.map((key) => {
        const row = rowsByKey.get(key);
        if (!row) return "";
        const { model, runner } = row;
        return `
        <tr>
          <td><div class="row-header">
            <span class="model">${model.provider}/${model.model}</span>
          </div></td>
          <td><div class="row-header">
            <span class="runner">${runner.name}</span>
            <span class="runner-type">(${runner.type})</span>
          </div></td>
          ${scenarios.map((scenario) => {
            const r = getResult(scenario, key);
            if (!r) return `<td><div class="cell"><span class="status pending">-</span></div></td>`;
            if (r.run.status === "running") {
              return `<td><div class="cell"><span class="status running">...</span></div></td>`;
            }
            const duration = r.run.endTime
              ? ((r.run.endTime.getTime() - r.run.startTime.getTime()) / 1000).toFixed(1)
              : "-";
            const logPath = r.logFile ? `logs/${basename(r.logFile)}` : "";
            const validationHtml = r.validations.map((v) => {
              const icon = v.passed ? "✓" : "✗";
              const cls = v.passed ? "pass" : "fail";
              const ruleLabel = (v.rule as any).name 
                ? (v.rule as any).name
                : v.rule.type === "tool_called" 
                  ? `tool_called: ${(v.rule as any).tool}`
                  : v.rule.type + (("path" in v.rule) ? `: ${(v.rule as any).path}` : "");
              return `<div class="validation ${cls}"><span class="validation-icon">${icon}</span> ${ruleLabel}</div>`;
            }).join("");
            return `<td>
              <div class="cell">
                <span class="status ${r.run.status}">${r.run.status === "passed" ? "✓" : "✗"}</span>
                <span class="duration">${duration}s</span>
                ${logPath ? `<a class="log-link" href="${logPath}">log</a>` : ""}
              </div>
              <div class="details">${validationHtml}</div>
            </td>`;
          }).join("")}
        </tr>`;
      }).join("")}
    </tbody>
  </table>
  
  <p class="timestamp">Generated: ${new Date().toISOString()}</p>
</body>
</html>`;

  writeFileSync(outputPath, html);
  console.log(`\n📊 Report saved to: ${outputPath}`);
}

function printResults(results: TestResultWithLog[]): void {
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS");
  console.log("=".repeat(60));

  for (const result of results) {
    const icon = result.run.status === "passed" ? "✓" : "✗";
    const { scenario, config } = result.run;
    console.log(
      `${icon} ${scenario.name} [${config.provider}/${config.model}] (${result.runnerName}) - ${result.run.status.toUpperCase()}`
    );

    for (const v of result.validations) {
      if (!v.passed) {
        console.log(`    ✗ ${v.message}`);
      }
    }
  }

  const passed = results.filter((r) => r.run.status === "passed").length;
  console.log(`\n${passed}/${results.length} tests passed`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const rootDir = join(import.meta.dirname, "../..");
  const configPath = join(rootDir, "config.yaml");
  const scenariosDir = join(import.meta.dirname, "../scenarios");
  const workdir = join(import.meta.dirname, "../.workdir");
  const logsDir = join(rootDir, "logs");
  const reportPath = join(rootDir, "report.html");

  const config = loadConfig(configPath);
  let scenarios = loadAllScenarios(scenariosDir);

  // CLI --scenario= filter
  const scenarioFilter = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1];
  if (scenarioFilter) {
    const filters = scenarioFilter.split(",");
    scenarios = scenarios.filter((s) => filters.some((f) => s.name.includes(f)));
  }

  // CLI --model= filter
  const modelFilter = process.argv.find((a) => a.startsWith("--model="))?.split("=")[1];
  if (modelFilter) {
    const filters = modelFilter.split(",");
    config.models = config.models.filter((m) => filters.some((f) => m.name.includes(f)));
  }

  // CLI --runner= filter
  const runnerFilter = process.argv.find((a) => a.startsWith("--runner="))?.split("=")[1];
  if (runnerFilter) {
    const filters = runnerFilter.split(",");
    config.runners = config.runners.filter((r) => filters.some((f) => r.name.includes(f)));
  }

  const pairs = buildTestPairs(config, scenarios);

  // CLI --run-count=N (default 3)
  const runCountArg = process.argv.find((a) => a.startsWith("--run-count="))?.split("=")[1];
  const RUN_COUNT = runCountArg ? parseInt(runCountArg, 10) : 3;

  console.log(`Models: ${config.models.map((m) => m.name).join(", ")}`);
  console.log(`Runners: ${config.runners.map((r) => r.name).join(", ")}`);
  console.log(`Running ${pairs.length} test pairs (${RUN_COUNT}x each, worst result kept)`);

  const results: TestResultWithLog[] = [];
  generateHtmlReport(results, reportPath, { isRunning: true, allPairs: pairs });

  // CLI --no-open to skip opening browser
  const noOpen = process.argv.includes("--no-open");
  if (!noOpen) {
    execSync(`open "${reportPath}"`);
  }

  for (const pair of pairs) {
    let worstResult: TestResultWithLog | null = null;

    for (let attempt = 1; attempt <= RUN_COUNT; attempt++) {
      console.log(`  Attempt ${attempt}/${RUN_COUNT} [${pair.runner.name}]`);
      const result = await runScenario(pair, workdir, logsDir, attempt);

      if (!worstResult) {
        worstResult = result;
      } else {
        const prevScore = scoreResult(worstResult);
        const currScore = scoreResult(result);
        if (currScore < prevScore) {
          worstResult = result;
        }
      }

      if (result.run.status === "failed") {
        break;
      }
    }

    results.push(worstResult!);
    generateHtmlReport(results, reportPath, { isRunning: true, allPairs: pairs });
  }

  generateHtmlReport(results, reportPath, { isRunning: false, allPairs: pairs });
  printResults(results);
}

main().catch(console.error);
