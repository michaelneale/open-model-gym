# Agent Ablation Testing

Test agent capabilities across model/provider permutations.

## Structure

```
suite/
  config.yaml    # Define agents and scenarios to test
  scenarios/     # YAML scenario definitions
  report.html    # Generated results matrix

mcp-harness/     # Mock MCP server (Slack, Jira, etc.)
```

## Run

```bash
just test                    # run all per config.yaml
just test-scenario simple    # filter by name
just report                  # open results
```

## Configuration

Edit `suite/config.yaml`:

```yaml
agents:
  - name: opus-baseline
    provider: anthropic
    model: claude-opus-4-5-20251101
    extensions: [developer]

  - name: qwen3-coder
    provider: ollama
    model: qwen3-coder:64k
    extensions: [developer]

  - name: opus-with-harness
    provider: anthropic
    model: claude-opus-4-5-20251101
    extensions: [developer]
    stdioExtensions:
      - node ../mcp-harness/dist/index.js

# Optional: limit which scenarios run (omit = all)
scenarios:
  - simple-file-create
  - edit-existing-file
```

## Scenarios

YAML files in `suite/scenarios/`:

```yaml
name: simple-file-create
prompt: Create a file called joke.md containing a short joke
setup:
  existing.txt: "optional pre-existing files"
validate:
  - type: file_exists
    path: joke.md
  - type: file_contains
    path: joke.md
    pattern: "joke"
```

**Validation rules:** `file_exists`, `file_not_empty`, `file_contains`, `file_matches`, `command_succeeds`

## MCP Harness

Mock MCP server for testing tool use without real APIs.

```bash
cd mcp-harness && npm install && npm run build
```

Tools: gdrive, sheets, salesforce, slack, calendar, gmail, jira, github.
