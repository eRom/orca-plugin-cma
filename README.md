# Claude Managed Agents

**Drive the Claude Managed Agents of your Anthropic workspaces from Orca's sidebar: sessions, agents, environments, vaults, memory and resources, without opening the Claude Console.**

![Orca](https://img.shields.io/badge/Orca-%E2%89%A51.4.259-blue) ![macOS](https://img.shields.io/badge/platform-macOS-lightgrey) ![Linux](https://img.shields.io/badge/platform-Linux-lightgrey) ![Windows](https://img.shields.io/badge/platform-Windows-lightgrey) ![License: MIT](https://img.shields.io/badge/license-MIT-green)

[Install](#install) · [Usage](#usage) · [Drafts](#drafts-edit-as-files) · [Files](#what-it-writes) · [Access](#what-it-can-access) · [Limits](#requirements-and-limits) · [Development](#development)

Claude Managed Agents run on Anthropic's infrastructure: you configure an agent, an environment and its tools, then start sessions that work on their own. This plugin puts that console inside Orca. A **Claude Managed Agents** panel lists your sessions and follows them live, lets you answer their approval requests, and edits every configuration the API exposes. A status bar item tells you how many sessions are running and when one waits for you.

## Install

From the command line:

```sh
orca plugin install eRom/orca-plugin-cma
```

Orca shows the access the plugin asks for (see [What it can access](#what-it-can-access)) and enables it once you approve. The **Claude Managed Agents** panel then appears in the sidebar.

Open it and add an Anthropic API key under **Organisation**. You can add several Anthropic workspaces, each with its own key, and switch between them: the whole panel follows the active one.

## Usage

The home of the panel has three parts.

- **Drafts**: the Orca project where agent and memory files are edited (see [Drafts](#drafts-edit-as-files)).
- **Organisation**: your Anthropic workspaces and their keys.
- **Tabs**: Sessions, Agents, Envs, Memory, Vaults and Resources, each with a filter and a **+** to create.

What you can do:

- **Sessions**: start a session (agent, environment, budget), read its thread live, send a message, approve or deny a tool call, interrupt it, raise its budget, archive or delete it.
- **Agents**: create and edit agents with a form (model, system prompt, tools, MCP servers, skills, multi-agent members), or as YAML in Orca's editor.
- **Environments**, **vaults** and **credentials**: create, edit, archive.
- **Memory**: memory stores and their memories. Edit a memory in Orca's editor, or upload local files as new memories in one batch.
- **Resources**: the workspace's skills and files. Upload a skill folder (with its `SKILL.md`), upload a new version of a skill (it keeps its id, so agents following the latest version get it), upload or delete files.

Every write shows a review of what changes before it is sent. An edit made elsewhere since you opened the object is detected, and you choose to reload or apply anyway.

## Drafts: edit as files

Agents (as YAML) and memories open as files in Orca's editor. These files live in a `managed-agents/` folder inside one of your Orca projects, which you pick once in the **Drafts** section of the home and can change at any time.

- Edit the file, save it, then press **Apply** in the panel: the review shows what will change before it is sent.
- In a Git repository, the folder ignores itself (`managed-agents/.gitignore` holds `*`), so nothing appears in `git status`.
- Changing project moves your drafts, unapplied edits included. The change is refused if the new project already holds drafts, or if a file there would be overwritten.

## What it writes

- **`<your project>/managed-agents/`**: the draft files, their registry (`.orca-drafts.json`) and the `.gitignore` above. Nothing else is written in your projects.
- **The plugin's own storage** (Orca's `storage:own`): the chosen project, panel preferences, unsent form input and the memory upload rows. **Memory upload rows keep the local path of each file until you apply them**, so they survive a restart; the content of a file is never stored.
- **The plugin's encrypted secrets** (`secrets:own`): your Anthropic API keys, one per workspace. They are never logged, written to a file or shown back.

## Uninstall

1. Apply or discard the drafts you want to keep.
2. Uninstall the plugin with `orca plugin uninstall <key>` (the key shown by `orca plugin list`). This deletes its storage and secrets.
3. Delete the `managed-agents/` folder of your drafts project by hand if you no longer need it.

## What it can access

Orca labels this plugin **Full access** (`trusted-worker`): it runs its own worker process on your machine with your user's rights. Here is exactly what it does with that.

| Capability | Why |
| --- | --- |
| `secrets:own` | Keep your Anthropic API keys encrypted. |
| `storage:own` | Keep the chosen drafts project, panel preferences and memory upload rows. |
| `workspace:read` | List your Orca projects to choose the drafts project, and find the workspace to open a draft in. |
| `workspace:write` | Show that workspace and open a draft file in Orca's editor. |

Beyond Orca's API, the worker:

- **talks only to the Anthropic API** (`api.anthropic.com`), with the key of the active workspace, through the official `@anthropic-ai/sdk`. It collects no data and sends nothing elsewhere.
- **opens the system's own file dialog** when you choose a file or a folder: `osascript` on macOS, Windows PowerShell 5.1 (`System.Windows.Forms`, started from `%SystemRoot%\System32`) on Windows, `zenity` or `kdialog` on Linux. No other program is started. Orca does not pass the desktop display to plugin workers, so on Linux the plugin checks for the session's display socket (`$XDG_RUNTIME_DIR/wayland-N`, else `/tmp/.X11-unix/XN`) and passes it to the dialog tool only. Without a dialog tool, you paste the path instead.
- **reads only the files you choose or paste**, to upload them to your Anthropic workspace.
- **reads and writes only its drafts folder** in the project you chose. It never reads Orca's own files.

## Requirements and limits

- **Orca 1.4.259 or later**, on macOS, Linux or Windows.
- **An Anthropic API key** with access to Claude Managed Agents (beta). Sessions are billed to that key's workspace: each session has a budget you set when you start it.
- **Deployments are not supported**, and resources attached to a session (files or a GitHub repository at creation) are not yet available.
- **MCP servers that need OAuth** cannot be connected from the panel yet.
- **On Linux**, file dialogs need `zenity` or `kdialog`; otherwise paste the path.

## Development

```sh
bun install
bun run typecheck          # type check
bun test src/worker        # worker tests
orca plugin test .         # panel tests
bun run build              # bundle the worker to dist/worker.mjs
orca plugin check . --json
```

Claude Managed Agents is a community plugin, not made or endorsed by Stably or by Anthropic.

## License

[MIT](LICENSE)
