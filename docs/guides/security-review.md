# Use source context in an authorised security review

Use SocratiCode to map a **source-available project you are authorised to review**. It helps locate code and trace relationships; it does not prove that a vulnerability exists or that one is absent.

1. Index the project and wait for `codebase_status` to report completion. Before indexing sensitive code, check the [SocratiCode configuration](../../README.md#configuration) and the coding assistant's data-handling settings. Default Ollama and Qdrant are local for indexing; a cloud embedding provider, remote Qdrant, or the assistant itself can expose source or tool results to another service.
2. Search for an externally reachable operation you need to assess, such as an account export endpoint. Use `codebase_search` to locate its handler, authorization checks, and downstream sensitive operation. Open the returned source and confirm what each result actually does.
3. Use `codebase_flow` or `codebase_symbol` to trace callers and callees, and `codebase_graph_query` to inspect file dependencies. Check alternative entry points and paths that might bypass a guard; a graph is a navigation aid, not proof of runtime behavior.
4. Record a suspected issue only after reviewing the relevant source, configuration, and tests, then validate it through the project's normal authorised test and disclosure process. Do not treat a search hit, missing graph edge, or assistant summary as a vulnerability verdict.

For tool parameters and the full search workflow, use the [example workflow in the README](../../README.md#example-workflow). If the finding is in SocratiCode itself, follow its [private security reporting policy](../../SECURITY.md).
