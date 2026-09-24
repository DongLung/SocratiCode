# Cline: first index and search

Have Cline in your editor, Node.js 18.17+ with `npx`, and running Docker available.

1. In Cline, open **MCP Servers → Configure → Configure MCP Servers**. Add the `socraticode` entry under `mcpServers` in the settings JSON that opens, preserving any existing servers:

   ```json
   {
     "mcpServers": {
       "socraticode": {
         "command": "npx",
         "args": ["-y", "--prefer-online", "socraticode@latest"],
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

2. Start a new Cline task. Confirm `socraticode` and its tools appear in the MCP Servers view, then request `codebase_status` in the task.
3. Ask Cline to run `codebase_index` for this project. Check `codebase_status` until complete, then use `codebase_search` for a known function or feature.

The default watcher handles subsequent file changes. After a SocratiCode release, reconnect the MCP server and start a new task.

For user-level configuration and other providers, use the [Cline section of the README](../../README.md#cline).
