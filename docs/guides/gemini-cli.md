# Gemini CLI: first index and search

Have Gemini CLI, Node.js 20+ with `npx`, and running Docker available. The server uses the default local Qdrant and Ollama stack.

1. Add the SocratiCode MCP server for your Gemini CLI user:

   ```bash
   gemini mcp add --scope user socraticode npx -y --prefer-online socraticode@latest
   ```

2. Start a new Gemini CLI session in your project. Run `gemini mcp list` in the terminal to confirm the SocratiCode server is connected, then request `codebase_status` in the session.
3. Ask Gemini to run `codebase_index` for this project. Check `codebase_status` until complete, then use `codebase_search` for a known function or feature.

The default watcher handles subsequent file changes. Restart Gemini after a SocratiCode release to reconnect the server and resolve the current npm package.

For other providers and overrides, use the [Gemini CLI section of the README](../../README.md#gemini-cli).
