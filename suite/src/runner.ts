import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import type { AgentConfig, Scenario, TestResult, TestRun } from "./types.js";
import { validateAll } from "./validator.js";

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

async function runAgent(
  config: AgentConfig,
  prompt: string,
  workdir: string
): Promise<void> {
  // Write prompt to a temp file for -i flag
  const promptFile = join(workdir, ".goose-prompt.txt");
  writeFileSync(promptFile, prompt);

  // Build extension flags
  const extensionFlags: string[] = [];
  for (const ext of config.extensions ?? []) {
    extensionFlags.push("--with-builtin", ext);
  }
  for (const ext of config.stdioExtensions ?? []) {
    extensionFlags.push("--with-extension", ext);
  }

  const args = [
    "run",
    "-i", promptFile,
    "--provider", config.provider,
    "--model", config.model,
    "--no-session",
    ...extensionFlags,
  ];

  console.log(`  Running: goose ${args.join(" ")}`);

  execSync(`goose ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`, {
    cwd: workdir,
    stdio: "inherit",
    timeout: 5 * 60 * 1000, // 5 minute timeout
  });
}

async function runScenario(
  scenario: Scenario,
  config: AgentConfig,
  baseWorkdir: string
): Promise<TestResult> {
  const workdir = join(
    baseWorkdir,
    `${scenario.name}_${config.provider}_${config.model}`.replace(/[\/\\:]/g, "_")
  );

  console.log(`\n▶ ${scenario.name} [${config.provider}/${config.model}]`);

  setupWorkdir(scenario, workdir);

  const run: TestRun = {
    scenario,
    config,
    workdir,
    startTime: new Date(),
    status: "running",
  };

  try {
    await runAgent(config, scenario.prompt, workdir);
    run.endTime = new Date();

    const validations = validateAll(scenario.validate, workdir);
    const allPassed = validations.every((v) => v.result.passed);

    return {
      run: { ...run, status: allPassed ? "passed" : "failed" },
      validations: validations.map((v) => ({
        rule: v.rule,
        passed: v.result.passed,
        message: v.result.message,
      })),
    };
  } catch (err) {
    return {
      run: {
        ...run,
        status: "failed",
        endTime: new Date(),
        errors: [String(err)],
      },
      validations: [],
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

function generateHtmlReport(results: TestResult[], outputPath: string): void {
  const scenarios = [...new Set(results.map((r) => r.run.scenario.name))];
  const configs = [...new Set(results.map((r) => `${r.run.config.provider}/${r.run.config.model}`))];

  const getResult = (scenario: string, configKey: string) =>
    results.find(
      (r) =>
        r.run.scenario.name === scenario &&
        `${r.run.config.provider}/${r.run.config.model}` === configKey
    );

  const passed = results.filter((r) => r.run.status === "passed").length;
  const total = results.length;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Scenario Test Results</title>
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
    .duration { color: #8b949e; font-size: 0.85rem; }
    .details { font-size: 0.8rem; color: #f85149; max-width: 300px; }
    .config-header { font-size: 0.75rem; }
    .config-header .model { display: block; color: #c9d1d9; font-weight: 600; }
    .config-header .provider { color: #8b949e; }
    .legend { margin-top: 2rem; display: flex; gap: 2rem; }
    .legend-item { display: flex; align-items: center; gap: 0.5rem; color: #8b949e; }
    .timestamp { color: #6e7681; font-size: 0.9rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>🦆 Agent Scenario Test Results</h1>
  <p class="summary">
    <span class="passed">${passed} passed</span> / 
    <span class="failed">${total - passed} failed</span> / 
    ${total} total
  </p>
  
  <table>
    <thead>
      <tr>
        <th>Scenario</th>
        ${configs.map((c) => {
          const [provider, ...model] = c.split("/");
          return `<th><div class="config-header"><span class="model">${model.join("/")}</span><span class="provider">${provider}</span></div></th>`;
        }).join("")}
      </tr>
    </thead>
    <tbody>
      ${scenarios.map((scenario) => `
        <tr>
          <td>${scenario}</td>
          ${configs.map((config) => {
            const r = getResult(scenario, config);
            if (!r) return `<td><div class="cell"><span class="status pending">-</span></div></td>`;
            const duration = r.run.endTime
              ? ((r.run.endTime.getTime() - r.run.startTime.getTime()) / 1000).toFixed(1)
              : "-";
            const errors = r.validations.filter((v) => !v.passed).map((v) => v.message).join("; ");
            return `<td>
              <div class="cell">
                <span class="status ${r.run.status}">${r.run.status === "passed" ? "✓" : "✗"}</span>
                <span class="duration">${duration}s</span>
              </div>
              ${errors ? `<div class="details">${errors}</div>` : ""}
            </td>`;
          }).join("")}
        </tr>
      `).join("")}
    </tbody>
  </table>
  
  <div class="legend">
    <div class="legend-item"><span class="status passed">✓</span> Passed</div>
    <div class="legend-item"><span class="status failed">✗</span> Failed</div>
  </div>
  
  <p class="timestamp">Generated: ${new Date().toISOString()}</p>
</body>
</html>`;

  writeFileSync(outputPath, html);
  console.log(`\n📊 Report saved to: ${outputPath}`);
}

interface SuiteConfig {
  agents: Array<AgentConfig & { name: string }>;
  scenarios?: string[];
}

function loadConfig(configPath: string): SuiteConfig {
  const content = readFileSync(configPath, "utf-8");
  const config = parse(content) as SuiteConfig;
  const configDir = join(configPath, "..");

  // Resolve relative paths in stdioExtensions
  for (const agent of config.agents) {
    if (agent.stdioExtensions) {
      agent.stdioExtensions = agent.stdioExtensions.map((ext) => {
        // "node ../path/to/server.js" -> resolve the path part
        const parts = ext.split(" ");
        const cmd = parts[0];
        const args = parts.slice(1).map((arg) =>
          arg.startsWith(".") ? join(configDir, arg) : arg
        );
        return [cmd, ...args].join(" ");
      });
    }
  }

  return config;
}

async function main() {
  const configPath = join(import.meta.dirname, "../config.yaml");
  const scenariosDir = join(import.meta.dirname, "../scenarios");
  const workdir = join(import.meta.dirname, "../.workdir");
  const reportPath = join(import.meta.dirname, "../report.html");

  const config = loadConfig(configPath);
  const configs = config.agents;

  // Load scenarios - filter by config.scenarios if specified, or CLI --scenario=
  const scenarioFilter = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1];
  let scenarios = loadAllScenarios(scenariosDir);

  if (scenarioFilter) {
    scenarios = scenarios.filter((s) => s.name.includes(scenarioFilter));
  } else if (config.scenarios?.length) {
    scenarios = scenarios.filter((s) => config.scenarios!.includes(s.name));
  }

  console.log(`Loaded ${scenarios.length} scenarios`);
  console.log(`Testing ${configs.length} agent configurations`);

  const results: TestResult[] = [];

  for (const scenario of scenarios) {
    for (const config of configs) {
      const result = await runScenario(scenario, config, workdir);
      results.push(result);
    }
  }

  printResults(results);
  generateHtmlReport(results, reportPath);
}

main().catch(console.error);
