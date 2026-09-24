# Share one SocratiCode index with a team

Use this when teammates have their own checkouts of the **same repository** but should search one index. Set up a shared Qdrant endpoint first; unlike the default local stack, source chunks and index metadata will be sent to that endpoint.

1. Before the first shared index, commit a stable identity in `.socraticode.json` at the repository root:

   ```json
   {
     "projectId": "team-service"
   }
   ```

   Use your repository's own identifier containing only letters, numbers, `_`, or `-`. Preserve any existing settings in this file. Leave `SOCRATICODE_PROJECT_ID` unset, because it overrides `projectId`. An existing index under a different ID stays separate; this setting does not migrate it.

2. Configure every teammate's SocratiCode MCP process with `QDRANT_MODE=external` and the **same** `QDRANT_URL`. Supply `QDRANT_API_KEY` through private host settings if required, never in the committed project file. Use the same embedding provider, model, dimensions, and indexed-representation settings on every process. The [README lists host-specific environment formats](../../README.md#passing-env-vars-by-host).
3. Designate one checkout as the writer. From that checkout, run `codebase_index` once and wait for `codebase_status` to say complete. Keep its default watcher running, or run `codebase_update` from that same checkout after source changes. Other teammates should set `SOCRATICODE_WATCHER=off` and `SOCRATICODE_AUTO_RESUME=off` on their MCP processes and search the shared collection without running update or index operations.
4. From a reader checkout at the same source revision, run `codebase_status` and search for a known feature with `codebase_search`. Confirm that the result points to the expected repository file. Coordinate source revisions before treating a result as current code.

This shares one index, not a live workspace or a cross-machine file watcher. For configuration alternatives and identity rules, see the [team-shared index section of the README](../../README.md#team-shared-index-committed-projectid).
