# VS Code: first index and search

Have Microsoft VS Code 1.99+, Node.js 18.17+ with `npx`, and running Docker available. Enable VS Code's AI features, then [sign in to GitHub Copilot](https://code.visualstudio.com/docs/setup/copilot) or [configure a BYOK model with tool calling](https://code.visualstudio.com/docs/agent-customization/language-models) for native Agent Chat.

1. Install the [SocratiCode editor extension](https://marketplace.visualstudio.com/items?itemName=giancarloerra.socraticode) from the Visual Studio Marketplace. Reload the window and start a new Chat session.
2. Run **MCP: List Servers** and confirm **SocratiCode** is running. Open the SocratiCode sidebar to confirm the editor integration loaded.
3. Open your project and select **Index this workspace** in the sidebar. Check `codebase_status` in Agent Chat until indexing completes, then ask Agent Chat to use `codebase_search` for a known function or feature.

The default watcher handles subsequent file changes. Update the extension through VS Code's Extensions view, reload the window, and start a new Chat session.

For other providers and integration types, use the [VS Code section of the README](../../README.md#vs-code-editor-extension).
