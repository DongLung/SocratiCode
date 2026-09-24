# Cursor: first index and search

Have Cursor, Node.js 18.17+ with `npx`, and running Docker available. The direct MCP setup uses the default local Qdrant and Ollama stack.

1. Use the [SocratiCode Cursor install link](cursor://anysphere.cursor-deeplink/mcp/install?name=socraticode&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcHJlZmVyLW9ubGluZSIsInNvY3JhdGljb2RlQGxhdGVzdCJdfQ==) and choose user scope.
2. Start a new Agent chat in your project. Under **Customize → MCPs**, confirm `socraticode` is connected, then request `codebase_status` in the chat.
3. Ask Agent to run `codebase_index` for the project. Check `codebase_status` until complete, then use `codebase_search` for a known function or feature.

The default watcher handles subsequent file changes. After a SocratiCode engine release, reconnect the MCP server and start a new Agent chat so `npx` can resolve the current package.

For plugin installation and other providers, use the [Cursor section of the README](../../README.md#cursor).
