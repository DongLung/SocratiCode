# OpenCode: first index and search

Have OpenCode 1.x, Node.js 18.17+ with `npx`, and running Docker available. This page uses the 1.x configuration format.

1. In the project root, add SocratiCode to `opencode.json` (create the file if absent; preserve other settings):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "mcp": {
       "socraticode": {
         "type": "local",
         "command": ["npx", "-y", "--prefer-online", "socraticode@latest"],
         "enabled": true
       }
     }
   }
   ```

2. Restart OpenCode and run `opencode mcp list` to confirm `socraticode` is connected. In the project session, request `codebase_status`.
3. Ask OpenCode to run `codebase_index` for this project. Check `codebase_status` until complete, then use `codebase_search` for a known function or feature.

The default watcher handles subsequent file changes. After a SocratiCode release, restart OpenCode so `npx` checks the current package.

For OpenCode V2 and other providers, use the [OpenCode section of the README](../../README.md#opencode).
