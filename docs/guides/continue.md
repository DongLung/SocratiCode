# Continue: first index and search

Have Continue in your editor, Node.js 18.17+ with `npx`, and running Docker available. MCP tools are used in Continue Agent mode.

1. In the project, create `.continue/mcpServers/socraticode.yaml`:

   ```yaml
   name: SocratiCode MCP
   version: 1.0.0
   schema: v1
   mcpServers:
     - name: SocratiCode
       type: stdio
       command: npx
       args:
         - "-y"
         - "--prefer-online"
         - socraticode@latest
   ```

2. Start a new Continue Agent session. Confirm SocratiCode's tools are listed and request `codebase_status` to check that the server responds.
3. Ask Agent to run `codebase_index` for this project. Check `codebase_status` until complete, then use `codebase_search` for a known function or feature.

The default watcher handles subsequent file changes. After a SocratiCode release, restart or reconnect the MCP server so `npx` checks the current package.

For user-level configuration and other providers, use the [Continue section of the README](../../README.md#continue).
