# Run all scenarios
test: _install
    cd suite && npm test

# Run specific scenario
test-scenario scenario: _install
    cd suite && npm test -- --scenario={{scenario}}

# Open report
report:
    open suite/report.html

# Install dependencies
install:
    cd suite && npm install
    cd mcp-harness && npm install && npm run build

# Internal: install if node_modules missing
_install:
    @[ -d suite/node_modules ] || (cd suite && npm install)
    @[ -d mcp-harness/node_modules ] || (cd mcp-harness && npm install && npm run build)
