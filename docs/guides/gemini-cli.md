# Gemini CLI: first index and search

Have Gemini CLI, Node.js 18.17+ with `npx`, and running Docker available. The extension uses the default local Qdrant and Ollama stack.

1. Install the SocratiCode extension from the repository:

   ```bash
   gemini extensions install https://github.com/giancarloerra/socraticode --auto-update
   ```

2. Start a new Gemini CLI session in your project. Run `gemini mcp list` in the terminal to confirm the SocratiCode server is connected, then request `codebase_status` in the session.
3. Ask Gemini to run `codebase_index` for this project. Check `codebase_status` until complete, then use `codebase_search` for a known function or feature.

The default watcher handles subsequent file changes. The `--auto-update` installation updates the extension; restart Gemini to load an update.

For other providers and overrides, use the [Gemini CLI section of the README](../../README.md#gemini-cli-extension).
