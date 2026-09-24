# Search a system spread across repositories

Use this when, for example, a frontend repository calls an API maintained in a sibling backend repository. Keep each repository's index independent, then link them for search. Have both repositories checked out locally and configured to use the same embedding provider, model, and `EMBEDDING_DIMENSIONS`.

1. From each repository, run `codebase_index` with that repository as `projectPath`. Wait for each `codebase_status` to complete before searching across them.
2. In the frontend repository, add a link to its sibling:

   ```json
   {
     "linkedProjects": ["../backend"]
   }
   ```

   Save this as `.socraticode.json` at the frontend root, preserving other settings if the file exists. Relative paths resolve from that root. The backend must have its own completed index; linking does not index it.
3. From the frontend, ask for `codebase_search` with `query` set to the behavior you are tracing and `includeLinked: true`. Check the project label and file path on each result before opening source. For a dependency graph or call flow within a result's repository, run that graph tool with the result repository's `projectPath`.

Use `codebase_status` in each repository to check its index and the default watcher to keep changed files current. A cross-repository search combines results; it does not create cross-repository graph edges. For more linkage and ranking details, use the [cross-project search section of the README](../../README.md#cross-project-search-linked-projects).
