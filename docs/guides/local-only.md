# Keep SocratiCode indexing local

Use this setup when source code must stay on your machine during **SocratiCode indexing and search**. It uses a native Ollama process for embeddings and Docker-managed Qdrant for the index. Node.js 18.17+ with `npx`, running Docker, and a running [native Ollama installation](https://ollama.com/download) are required.

Set these variables on your host's SocratiCode MCP server before its first index:

```text
OLLAMA_MODE=external
OLLAMA_URL=http://localhost:11434
```

Leave `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, and `QDRANT_MODE` unset. Their defaults select Ollama, `nomic-embed-text`, and managed local Qdrant. Restart the MCP server after changing its environment; the [README shows how each host passes variables](../../README.md#passing-env-vars-by-host).

Open a source project and call `codebase_health`, then `codebase_index`. The embedding model is downloaded on first use if needed. Check `codebase_status` until complete and search for a known feature with `codebase_search`. The default watcher keeps that index current as files change.

SocratiCode sends source chunks to the local Ollama endpoint and stores its index in local Qdrant, not a cloud embedding or Qdrant service. Initial package, Docker-image, and model downloads still need network access. **The coding assistant is separate:** prompts and SocratiCode tool results may be sent to that assistant's provider under its own settings and terms. Check that boundary before using sensitive source.

For other local or cloud configurations, use the [configuration section of the README](../../README.md#configuration). Changing an existing index's embedding settings does not silently convert its stored vectors; see [effective index profiles](../../README.md#effective-index-profiles).
