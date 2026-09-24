# Zed: first index and search

Have Zed, Node.js 18.17+ with `npx`, and running Docker available. Zed's Agent Panel uses the MCP tools.

1. In your project, add SocratiCode to `.zed/settings.json` (create the file if absent; preserve other settings):

   ```json
   {
     "context_servers": {
       "socraticode": {
         "command": "npx",
         "args": ["-y", "--prefer-online", "socraticode@latest"],
         "env": {}
       }
     }
   }
   ```

2. In **Settings → AI → MCP Servers**, confirm SocratiCode's indicator says the server is active. Start a new Agent conversation and request `codebase_status`.
3. Ask Agent to run `codebase_index` for this project. Check `codebase_status` until complete, then use `codebase_search` for a known function or feature.

The default watcher handles subsequent file changes. After a SocratiCode release, restart the server from Zed's MCP Servers page and start a new conversation.

For user-level configuration and other providers, use the [Zed section of the README](../../README.md#zed).
