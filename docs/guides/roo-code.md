# Roo Code: first index and search

Have Roo Code in your editor, Node.js 18.17+ with `npx`, and running Docker available.

1. In the project, add SocratiCode to `.roo/mcp.json` (create the file if absent; preserve other server entries):

   ```json
   {
     "mcpServers": {
       "socraticode": {
         "command": "npx",
         "args": ["-y", "--prefer-online", "socraticode@latest"],
         "disabled": false
       }
     }
   }
   ```

2. Start a new Roo Code task. Confirm `socraticode` is connected in the MCP Servers view, then request `codebase_status` in the task.
3. Ask Roo Code to run `codebase_index` for this project. Check `codebase_status` until complete, then use `codebase_search` for a known function or feature.

The default watcher handles subsequent file changes. After a SocratiCode release, restart the MCP server and start a new task.

For user-level configuration and other providers, use the [Roo Code section of the README](../../README.md#roo-code).
