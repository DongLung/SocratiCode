# OpenAI Codex: first index and search

Have Codex, Node.js 18.17+ with `npx`, and running Docker available. The default stack uses local Qdrant and Ollama.

1. Add the SocratiCode marketplace and install its plugin:

   ```bash
   codex plugin marketplace add giancarloerra/socraticode --ref main
   codex plugin add socraticode@socraticode
   ```

2. Start a **new** Codex task or CLI session in the project. Confirm that the SocratiCode tools are available and call `codebase_status` to confirm the server responds. The plugin already bundles the MCP server.
3. Ask Codex to run `codebase_index` for this project. Check `codebase_status` until complete, then use `codebase_search` for a known function or feature.

The default watcher handles subsequent file changes. After a plugin release, run `codex plugin marketplace upgrade socraticode` and `codex plugin add socraticode@socraticode`, then start a new task.

For other providers and installation paths, use the [Codex section of the README](../../README.md#openai-codex-plugin).
