#!/usr/bin/env node
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { readFileSync } from "node:fs";
import type { AgentConfig, Scenario, TestResult, TestRun } from "./types.js";
import { validateAll } from "./validator.js";

// Platform extensions (not builtin)
const PLATFORM_EXTENSIONS = new Set([
  "todo", "skills", "code_execution", "extensionmanager", 
  "chatrecall", "apps", "imagegenerator"
]);

function generateGooseConfig(agentConfig: AgentConfig): object {
  const extensions: Record<string, object> = {};

  // Add extensions (detect platform vs builtin)
  for (const ext of agentConfig.extensions ?? []) {
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

  // Add stdio extensions
  for (const extCmd of agentConfig.stdio ?? []) {
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
    GOOSE_PROVIDER: agentConfig.provider,
    GOOSE_MODEL: agentConfig.model,
    GOOSE_TELEMETRY_ENABLED: false,
  };
}

function loadScenario(path: string): Scenario {
  const content = readFileSync(path, "utf-8");
  return parse(content) as Scenario;
}

function loadAllScenarios(dir: string): Scenario[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  return files.map((f) => loadScenario(join(dir, f)));
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

// Shared goose root - config swapped before each run
const GOOSE_ROOT = join(import.meta.dirname, "../.goose-root");
const GOOSE_CONFIG_DIR = join(GOOSE_ROOT, "config");

async function runAgent(
  config: AgentConfig,
  prompt: string,
  workdir: string,
  defaultGooseBin?: string
): Promise<string> {
  // Write prompt to a temp file for -i flag
  const promptFile = join(workdir, ".goose-prompt.txt");
  writeFileSync(promptFile, prompt);

  // Swap in config for this run
  mkdirSync(GOOSE_CONFIG_DIR, { recursive: true });
  const gooseConfig = generateGooseConfig(config);
  writeFileSync(join(GOOSE_CONFIG_DIR, "config.yaml"), stringify(gooseConfig));

  const args = ["run", "-i", promptFile, "--no-session"];

  const gooseBin = config["goose-bin"] || defaultGooseBin || "goose";
  const cmd = `${gooseBin} ${args.join(" ")}`;
  console.log(`  Running: ${cmd}`);

  const output = execSync(cmd, {
    cwd: workdir,
    env: {
      ...process.env,
      GOOSE_PATH_ROOT: GOOSE_ROOT,
      MCP_HARNESS_LOG: join(workdir, "tool-calls.log"),
    },
    timeout: 5 * 60 * 1000, // 5 minute timeout
    encoding: "utf-8",
  });

  return output;
}

interface TestResultWithLog extends TestResult {
  logFile: string;
}

type NamedAgentConfig = AgentConfig & { name: string };

// Score a result: higher is better (more validations passed, passed status)
function scoreResult(result: TestResultWithLog): number {
  if (result.run.status === "failed" && result.run.errors?.length) {
    return -1; // Crash/error is worst
  }
  const passedCount = result.validations.filter((v) => v.passed).length;
  const statusBonus = result.run.status === "passed" ? 1000 : 0;
  return statusBonus + passedCount;
}

async function runScenario(
  scenario: Scenario,
  config: AgentConfig,
  baseWorkdir: string,
  logsDir: string,
  attempt: number = 1,
  defaultGooseBin?: string
): Promise<TestResultWithLog> {
  const testId = `${scenario.name}_${config.provider}_${config.model}`.replace(/[\/\\:]/g, "_");
  const workdir = join(baseWorkdir, testId);
  const logFile = join(logsDir, `${testId}_attempt${attempt}.log`);

  console.log(`\n▶ ${scenario.name} [${config.provider}/${config.model}]`);

  setupWorkdir(scenario, workdir);
  mkdirSync(logsDir, { recursive: true });

  const run: TestRun = {
    scenario,
    config,
    workdir,
    startTime: new Date(),
    status: "running",
  };

  let output = "";
  try {
    output = await runAgent(config, scenario.prompt, workdir, defaultGooseBin);
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
    };
  }
}

function printResults(results: TestResult[]): void {
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS");
  console.log("=".repeat(60));

  for (const result of results) {
    const icon = result.run.status === "passed" ? "✓" : "✗";
    const { scenario, config } = result.run;
    console.log(
      `${icon} ${scenario.name} [${config.provider}/${config.model}] - ${result.run.status.toUpperCase()}`
    );

    for (const v of result.validations) {
      if (!v.passed) {
        console.log(`    ✗ ${v.message}`);
      }
    }
  }

  const passed = results.filter((r) => r.run.status === "passed").length;
  console.log(`\n${passed}/${results.length} scenarios passed`);
}

function formatAgentConfig(config: AgentConfig): string {
  const parts = [`${config.provider}/${config.model}`];
  const allExts = [
    ...(config.extensions ?? []),
    ...(config.stdio ?? []).map((e) => basename(e.split(" ").pop() || e).replace(/\.[^.]+$/, "")),
  ];
  if (allExts.length) parts.push(`[${allExts.join(", ")}]`);
  return parts.join(" ");
}

function agentConfigKey(config: AgentConfig): string {
  return JSON.stringify({
    provider: config.provider,
    model: config.model,
    extensions: config.extensions ?? [],
    stdio: config.stdio ?? [],
  });
}

interface ReportOptions {
  isRunning?: boolean;
  allPairs?: Array<{ scenario: Scenario; agent: NamedAgentConfig }>;
  runner?: string;
  defaultGooseBin?: string;  // config-level default (agents may override)
}

function generateHtmlReport(
  results: TestResultWithLog[],
  outputPath: string,
  options: ReportOptions = {}
): void {
  const { isRunning = false, allPairs = [], runner = "goose", defaultGooseBin = "goose" } = options;

  // Get all scenarios and configs from pairs (if provided) or results
  const scenarios = allPairs.length
    ? [...new Set(allPairs.map((p) => p.scenario.name))]
    : [...new Set(results.map((r) => r.run.scenario.name))];

  const configKeys = allPairs.length
    ? [...new Set(allPairs.map((p) => agentConfigKey(p.agent)))]
    : [...new Set(results.map((r) => agentConfigKey(r.run.config)))];

  const configsByKey = allPairs.length
    ? new Map(allPairs.map((p) => [agentConfigKey(p.agent), p.agent]))
    : new Map(results.map((r) => [agentConfigKey(r.run.config), r.run.config]));

  const getResult = (scenario: string, configKey: string) =>
    results.find(
      (r) =>
        r.run.scenario.name === scenario &&
        agentConfigKey(r.run.config) === configKey
    );

  const passed = results.filter((r) => r.run.status === "passed").length;
  const failed = results.filter((r) => r.run.status === "failed").length;
  const total = allPairs.length || results.length;
  const pending = total - results.length;

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
    .status { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; text-decoration: none; }
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
    .config-header { font-size: 0.75rem; }
    .config-header .model { display: block; color: #c9d1d9; font-weight: 600; }
    .config-header .provider { color: #8b949e; }
    .config-header .extensions { display: block; color: #7ee787; font-size: 0.7rem; }
    .runner-info { color: #6e7681; font-size: 0.85rem; margin-bottom: 1.5rem; }
    .runner-info code { background: #21262d; padding: 0.2rem 0.4rem; border-radius: 4px; font-family: monospace; }
    .timestamp { color: #6e7681; font-size: 0.9rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>🦆 Agent Scenario Test Results${isRunning ? " (Running...)" : ""}</h1>
  <p class="summary">
    <span class="passed">${passed} passed</span> / 
    <span class="failed">${failed} failed</span>${pending > 0 ? ` / <span style="color:#9e6a03">${pending} pending</span>` : ""} / 
    ${total} total
  </p>
  <p class="runner-info">Runner: ${runner} | Default binary: <code>${defaultGooseBin}</code></p>
  
  <table>
    <thead>
      <tr>
        <th>Agent</th>
        ${scenarios.map((scenario) => `<th>${scenario}</th>`).join("")}
      </tr>
    </thead>
    <tbody>
      ${configKeys.map((key) => {
        const cfg = configsByKey.get(key)!;
        const allExts = [
          ...(cfg.extensions ?? []),
          ...(cfg.stdio ?? []).map((e) => basename(e.split(" ").pop() || e).replace(/\.[^.]+$/, "")),
        ];
        return `
        <tr>
          <td><div class="config-header">
            <span class="model">${cfg.model}</span>
            <span class="provider">${cfg.provider}</span>
            ${allExts.length ? `<span class="extensions">[${allExts.join(", ")}]</span>` : ""}
          </div></td>
          ${scenarios.map((scenario) => {
            const r = getResult(scenario, key) as TestResultWithLog | undefined;
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
              const ruleLabel = v.rule.type === "tool_called" 
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

interface MatrixEntry {
  scenario: string;
  agents?: string[];  // omit = all agents
}

interface SuiteConfig {
  "agent-config": NamedAgentConfig[];
  matrix?: MatrixEntry[];
  /** Runner type (currently only "goose" supported) */
  runner?: "goose";
  /** Default goose binary path (agents can override) */
  "goose-bin"?: string;
}

function loadConfig(configPath: string): SuiteConfig {
  const content = readFileSync(configPath, "utf-8");
  const config = parse(content) as SuiteConfig;
  const configDir = join(configPath, "..");

  // Resolve relative paths in stdio extensions
  for (const agent of config["agent-config"]) {
    if (agent.stdio) {
      agent.stdio = agent.stdio.map((ext) => {
        const parts = ext.split(" ");
        const cmd = parts[0];
        const args = parts.slice(1).map((arg) => {
          // Resolve any path that's not absolute
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

function buildTestPairs(
  config: SuiteConfig,
  scenarios: Scenario[]
): Array<{ scenario: Scenario; agent: NamedAgentConfig }> {
  const agentsByName = new Map(config["agent-config"].map((a) => [a.name, a]));

  if (config.matrix?.length) {
    // Use explicit matrix
    const pairs: Array<{ scenario: Scenario; agent: NamedAgentConfig }> = [];
    for (const entry of config.matrix) {
      const scenario = scenarios.find((s) => s.name === entry.scenario);
      if (!scenario) continue;
      const agents = entry.agents
        ? entry.agents.map((n) => agentsByName.get(n)).filter(Boolean) as NamedAgentConfig[]
        : config["agent-config"];  // omit agents = all
      for (const agent of agents) {
        pairs.push({ scenario, agent });
      }
    }
    return pairs;
  }

  // No matrix: all scenarios x all agents
  const pairs: Array<{ scenario: Scenario; agent: NamedAgentConfig }> = [];
  for (const scenario of scenarios) {
    for (const agent of config["agent-config"]) {
      pairs.push({ scenario, agent });
    }
  }
  return pairs;
}

async function main() {
  const rootDir = join(import.meta.dirname, "../..");
  const configPath = join(rootDir, "config.yaml");
  const scenariosDir = join(import.meta.dirname, "../scenarios");
  const workdir = join(import.meta.dirname, "../.workdir");
  const logsDir = join(rootDir, "logs");
  const reportPath = join(rootDir, "report.html");

  const config = loadConfig(configPath);
  let scenarios = loadAllScenarios(scenariosDir);

  // CLI --scenario= filter (comma-separated for multiple)
  const scenarioFilter = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1];
  if (scenarioFilter) {
    const filters = scenarioFilter.split(",");
    scenarios = scenarios.filter((s) => filters.some((f) => s.name.includes(f)));
  }

  // CLI --agent= filter (comma-separated for multiple)
  const agentFilter = process.argv.find((a) => a.startsWith("--agent="))?.split("=")[1];
  if (agentFilter) {
    const filters = agentFilter.split(",");
    config["agent-config"] = config["agent-config"].filter((a) => filters.some((f) => a.name.includes(f)));
  }

  const pairs = buildTestPairs(config, scenarios);
  
  // CLI --run-count=N (default 3)
  const runCountArg = process.argv.find((a) => a.startsWith("--run-count="))?.split("=")[1];
  const RUN_COUNT = runCountArg ? parseInt(runCountArg, 10) : 3;

  const runner = config.runner || "goose";
  const defaultBin = config["goose-bin"] || runner;
  console.log(`Runner: ${runner} (bin: ${defaultBin})`);
  console.log(`Running ${pairs.length} test pairs (${RUN_COUNT}x each, worst result kept)`);

  // Generate initial report with all pending and open browser
  const results: TestResultWithLog[] = [];
  generateHtmlReport(results, reportPath, { isRunning: true, allPairs: pairs, runner, defaultGooseBin: defaultBin });
  
  // CLI --no-open to skip opening browser (useful for chained runs)
  const noOpen = process.argv.includes("--no-open");
  if (!noOpen) {
    execSync(`open "${reportPath}"`);
  }

  for (const { scenario, agent } of pairs) {
    let worstResult: TestResultWithLog | null = null;

    for (let attempt = 1; attempt <= RUN_COUNT; attempt++) {
      console.log(`  Attempt ${attempt}/${RUN_COUNT}`);
      const result = await runScenario(scenario, agent, workdir, logsDir, attempt, config["goose-bin"]);

      // Keep the worst result (failed > passed, or fewer validations passed)
      if (!worstResult) {
        worstResult = result;
      } else {
        const prevScore = scoreResult(worstResult);
        const currScore = scoreResult(result);
        if (currScore < prevScore) {
          worstResult = result;
        }
      }

      // If we got a failure, that's the worst - no need to continue
      if (result.run.status === "failed") {
        break;
      }
    }

    results.push(worstResult!);
    // Update report after each test pair completes
    generateHtmlReport(results, reportPath, { isRunning: true, allPairs: pairs, runner, defaultGooseBin: defaultBin });
  }

  // Final report without auto-refresh
  generateHtmlReport(results, reportPath, { isRunning: false, allPairs: pairs, runner, defaultGooseBin: defaultBin });
  printResults(results);
}

main().catch(console.error);
