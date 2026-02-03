# Open Model Gym

Run agent tests across a matrix of **models × runners × scenarios**. 

It isn't hard for anhy agent to do ok with opus, but lets scale things in the other direction. What do we have to break things down to.

## Latest Results

📊 **[View Latest Report](agent-gym-report-2026-02-03.html)** — Download and open locally to see full results with embedded logs.

> The report is a self-contained HTML file with all test results, validation details, and complete agent logs embedded.

## Quick Start

```bash
just install   # one-time setup
just run       # run full matrix (3 reps each)
just report    # view results
```

## How It Works

The test harness runs every combination of models, runners, and scenarios defined in your matrix. Each test runs multiple times (default 3) and keeps the **worst result** — if a test fails even once, it's marked failed. This catches flaky passes.

## Configuration

Edit `config.yaml` to define your test matrix:

### Models

LLMs to test against. Supports any provider (Anthropic, OpenAI, Ollama, etc.):

```yaml
models:
  - name: opus
    provider: anthropic
    model: claude-opus-4-5-20251101

  - name: qwen3-coder
    provider: ollama
    model: qwen3-coder:64k

  - name: gpt4
    provider: openai
    model: gpt-4-turbo
```

### Runners

Agent frameworks that execute the tests. Each runner has its own binary, type, and configuration:

```yaml
runners:
  # Goose agent with extensions
  - name: goose-full
    type: goose
    bin: goose                    # path to binary (can be absolute)
    extensions: [developer, todo, skills]
    stdio:
      - node mcp-harness/dist/index.js

  # OpenCode agent
  - name: opencode
    type: opencode
    bin: opencode                 # path to binary
    stdio:
      - node mcp-harness/dist/index.js

  # Custom goose binary path
  - name: goose-dev
    type: goose
    bin: /path/to/my/goose-dev
    extensions: [developer]
```

**Supported runner types:**
- `goose` — [Goose](https://github.com/block/goose) agent framework
- `opencode` — [OpenCode](https://opencode.ai) agent framework

### Matrix

Define which scenarios run against which models/runners:

```yaml
matrix:
  - scenario: file-editing
    models: [opus, qwen3-coder]      # omit to run all models
    runners: [goose-full, opencode]  # omit to run all runners

  - scenario: everyday-app-automation
    # runs against ALL models and ALL runners
```

## Scenarios

Scenarios live in `suite/scenarios/` as YAML files:

```yaml
name: file-editing
description: Create and edit files
prompt: |
  1. Create joke.md containing a short joke
  2. Edit hello.rs to add a debug function

setup:
  hello.rs: |
    fn main() { println!("Hello!"); }

validate:
  - type: file_exists
    path: joke.md
  - type: file_matches
    path: hello.rs
    regex: "fn\\s+debug"
```

### Validation Rules

| Rule | Description |
|------|-------------|
| `file_exists` | File exists at path |
| `file_not_empty` | File exists and has content |
| `file_contains` | File contains literal string |
| `file_matches` | File matches regex pattern |
| `command_succeeds` | Shell command exits 0 |
| `tool_called` | MCP tool was called with matching args (regex supported) |

**Tool call validation example:**
```yaml
validate:
  - type: tool_called
    tool: slack_search_messages
    args:
      query: /quarterly.?review/    # regex pattern
  - type: tool_called
    tool: jira_create_issue
    args:
      summary: /Q1.*Review/
      description: /David Brown/
```

## MCP Harness

Mock MCP server providing simulated tools for testing agent tool-use without hitting real APIs.

```bash
cd mcp-harness && npm install && npm run build
```

**Available tools:** gdrive, sheets, salesforce, slack, calendar, gmail, jira, github

Each tool returns realistic mock data. Tool calls are logged to `tool-calls.log` in the workdir for validation.

## Commands

| Command | Description |
|---------|-------------|
| `just run` | Full test run (3 reps each, worst kept) |
| `just test` | Quick run (1 rep each) |
| `just scenario <name>` | Run specific scenario |
| `just agent <name>` | Run specific agent |
| `just report` | Open HTML results |

### CLI Flags

```bash
# Filter by scenario, model, or runner
npx tsx src/runner.ts --scenario=file-editing --model=opus --runner=goose

# Control repetition count
npx tsx src/runner.ts --run-count=5

# Don't auto-open browser
npx tsx src/runner.ts --no-open
```

## Output

- `report.html` — Live-updating HTML matrix showing pass/fail status, duration, and validation details
- `logs/` — Full agent output logs for each run
