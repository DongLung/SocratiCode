# Claude Code: first index and search

Have Claude Code, Node.js 18.17+ with `npx`, and running Docker available. The default stack uses local Qdrant and Ollama.

1. Install the SocratiCode plugin for your user:

   ```bash
   claude plugin marketplace add giancarloerra/socraticode
   claude plugin install --scope user socraticode@socraticode
   ```

2. Open the project in a **new** Claude Code session. Use `/mcp` to confirm SocratiCode is connected, then ask for its `codebase_status`. The plugin supplies the MCP server; a separate SocratiCode MCP registration is unnecessary.
3. Ask Claude Code to index the current project with `codebase_index`. Check `codebase_status` until indexing completes, then ask it to use `codebase_search` for a function or feature you know is present.

Later file changes are indexed by the default watcher. To update the plugin, run `claude plugin marketplace update socraticode` and `claude plugin update --scope user socraticode@socraticode`, then start a new session.

For other providers and installation paths, use the [Claude Code section of the README](../../README.md#claude-code-plugin-recommended-for-claude-code-users).
