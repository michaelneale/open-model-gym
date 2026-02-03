# Agent Runner - Test Suite (supports goose and opencode)

# Default recipe
default: run

# Full test run - all scenarios, all agents, 3 repetitions (worst kept)
run: _install
    cd suite && npm run test

# Quick test - file-editing + everyday-app-automation, single run each (no repetition)
test: _install
    cd suite && npx tsx src/runner.ts --scenario=file-editing,everyday-app-automation --run-count=1

# Run a specific scenario (all agents, 3 reps)
scenario name: _install
    cd suite && npx tsx src/runner.ts --scenario={{name}}

# Run against a specific agent (all scenarios, 3 reps)
agent name: _install
    cd suite && npx tsx src/runner.ts --agent={{name}}

# Open report in browser
report:
    open report.html

# Install all dependencies
install:
    cd suite && npm install
    cd mcp-harness && npm install && npm run build

# Build TypeScript
build: _install
    cd suite && npm run build

# Internal: install if node_modules missing, always rebuild mcp-harness
_install:
    @[ -d suite/node_modules ] || (cd suite && npm install)
    @[ -d mcp-harness/node_modules ] || (cd mcp-harness && npm install)
    @cd mcp-harness && npm run build
