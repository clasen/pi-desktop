# Pi Desktop

A desktop app for the [Pi](https://pi.dev) and [oh-my-pi](https://github.com/can1357/oh-my-pi) coding agents. Your projects, their sessions, and what each one changed, all in one window. No tab archaeology required.

![Pi Desktop: chat, session diff, and terminal](docs/screenshots/pi-desktop-chat-diff-terminal.png)

It's alpha. It works, I use it every day, and it will still surprise you now and then.

## Install

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/clasen/pi-desktop/master/install.sh | bash
```

**Windows** (PowerShell, not Command Prompt)

```powershell
iex (irm https://raw.githubusercontent.com/clasen/pi-desktop/master/install.ps1)
```

That's it for the app. One command, every platform. The script grabs the latest release, checks its SHA-256, and installs it. No Node, no compiler. To update, close Pi Desktop and run the same command again.

- **macOS** (Apple Silicon and Intel): `~/Applications/Pi Desktop.app`
- **Linux** (x86_64): `~/.local/share/pi-desktop`, with a `pi-desktop` launcher in `~/.local/bin`
- **Windows** (x64): runs the normal setup wizard

**You also need the agent itself.** Pi Desktop is the window; [Pi](https://pi.dev) (or [OMP](https://github.com/can1357/oh-my-pi)) does the work. If neither is installed, the script asks whether to install Pi for you. Say yes and you're done. Said no, or skipped it? Install Pi yourself:

```bash
curl -fsSL https://pi.dev/install.sh | sh                 # macOS / Linux
```

```powershell
powershell -c "irm https://pi.dev/install.ps1 | iex"      # Windows
```

Open a new terminal afterwards so your PATH picks it up. Already have Pi or OMP somewhere unusual? Point to it in **Settings → Agent Configuration**.

Builds aren't signed yet. If Windows SmartScreen gets nervous, click **More info → Run anyway**. If an older Windows PowerShell fails with *"The underlying connection was closed"*, use this instead:

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/clasen/pi-desktop/master/install.ps1 | Out-String | Invoke-Expression
```

Piping a script into your shell is a matter of trust. If you'd rather read it first, [it's right here](install.sh) ([Windows version](install.ps1)).

## Or make it yours

Pi Desktop is a plain Electron + React + TypeScript app. If something bugs you, change it:

```bash
git clone https://github.com/clasen/pi-desktop.git
cd pi-desktop
npm install --ignore-scripts=false
npm run dev
```

Point Pi at its own source code and ask it to fix the thing you don't like. It's oddly satisfying.

Want your own builds? Bump the version in `package.json` and `package-lock.json`, push a matching `v<version>` tag, and GitHub Actions builds and publishes installers for every platform on your fork. Change the repo name in `install.sh` and `install.ps1` and the one-liners above install your version instead.

Building on Windows takes a few extra steps (a C++ toolchain for the terminal). See [Building on Windows](#building-on-windows) below. [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) explain how the code is laid out.

## Why bother

**Projects and sessions you can actually read.** Projects sit as tabs across the top, their sessions down the side. Each one tells you whether it's working, waiting for your approval, done, or broken. If you've used the Codex or Claude Code apps, it'll feel familiar, just with less squinting to figure out which project still has something running.

**See what this session changed. Not the whole repo. This session.** The diff viewer can show only the files the current session touched, including changes made through shell commands. Review them, revert a file, then **Commit** or **Commit + Push** right there. Leave the message empty and the session's model writes one for you.

**Things keep running when you look away.** Every live session gets its own agent process. Switch projects mid-turn and the turn keeps going. **Mission Control** shows everything in flight, and you can get a desktop notification when something finishes, fails, or needs you.

**Pi or OMP, your pick.** It runs the standard `pi` CLI or `omp` from oh-my-pi. Each keeps its own session history, and the app reads both. Open an old session and it starts the engine that wrote it.

## Everything else

- Streaming chat with thinking blocks, collapsible tool calls, inline diffs for edits, and file names that open a preview when you click them
- `@` to mention files, drop a folder in to open it as a project, paste images straight into the composer
- **New Task** starts a fresh background session, optionally in its own Git worktree
- Branch switcher, file tree, code editor, image/PDF/HTML preview, and a real terminal
- `Ctrl/Cmd+K` finds commands, skills, projects, sessions, and files. Every shortcut can be changed in **Settings → Keyboard shortcuts**
- Fork and branch sessions, one-click context compaction, session tags, inline rename
- Package and skill browser connected to [pi.dev/packages](https://pi.dev/packages), with update checks
- Custom models and providers editor
- Home dashboard with usage stats, for those who like to know how many tokens went into that one-line fix
- Diagnostics view for when the agent won't start and you'd like to know why

Opt-in extras, off until you turn them on:

- **Voice dictation.** Click the mic and talk. Speech-to-text runs on your machine with a model you choose (Moonshine is small and fast for English, Whisper and Parakeet V3 cover many languages). Nothing goes to a server, and nothing downloads until you pick a model in **Settings → Voice dictation**.
- **Multi-Agent Council.** Pi, Claude, and Codex each draft a plan, read each other's, and Pi merges them into one. All of them plan read-only; only Pi builds. Yes, it burns more tokens. Enable it in **Settings → Multi-Agent Council Planning**.
- **[TypeSafe Jev](https://docs.typesafe.ai/introduction).** Save your TypeSafe API key once and install the Jev skill, so Pi and OMP can use it without asking for the key each time. Set it up in **Settings → TypeSafe Jev**.

## Permissions

Pick how much rope Pi gets, from the composer or **Settings → Behavior**:

| Mode | Pi can… |
|------|---------|
| Plan / Read-only | read and search. That's it |
| Ask before edits | do anything, but asks before editing files or running commands |
| Ask before commands | edit freely, but asks before running commands |
| Trusted | do whatever it wants. You did say "trusted" |

On top of that you can add allow/deny rules per tool, like:

```json
{ "action": "allow", "tool": "bash", "match": "npm test*" }
{ "action": "deny",  "tool": "bash", "match": "rm -rf *" }
{ "action": "deny",  "tool": "*",    "match": "*.env*" }
```

Deny always wins, even in Trusted. Rules can live globally or in a project's `.pi-desktop/permission-rules.json`. A project's own *allow* rules are ignored until you trust that project, so a repo you just cloned can tighten your rules but never loosen them.

Fair warning: rules match raw text. There's no command parsing behind them. Think of them as a guardrail against accidents, not a sandbox.

## Themes and languages

Seven built-in themes plus System. Want your own? **Settings → Appearance → Create theme**: pick seven colors and the app derives the rest. Themes are small JSON files you can import, export, or install from a URL. There's a [community gallery](https://github.com/FaqFirebase/pi-desktop-themes) if you'd rather borrow someone else's taste.

The interface speaks English and Simplified Chinese. Adding a language is one JSON file; see [Translations](CONTRIBUTING.md#translations).

## Building on Windows

Windows needs a C++ toolchain because the terminal (`node-pty`) compiles a native module.

<details>
<summary>Step by step</summary>
1. Install these **before** cloning:
   - [Git for Windows](https://git-scm.com/download/win)
   - [Node.js LTS](https://nodejs.org)
   - [Visual Studio Build Tools **2022**](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with the **Desktop development with C++** workload, plus **Spectre-mitigated libs for v143 toolset** (under *Individual components*). Not 2026: its toolset lacks the Spectre libs and `npm install` fails with `MSB8040`.
2. Keep the repo, and your projects, out of `Documents` and `Desktop`. Windows **Controlled Folder Access** silently blocks writes there, which shows up as random `EPERM`/`EACCES` errors. Something like `C:\dev` is fine. Adding that folder to the Defender exclusions also makes `npm install` much faster.
3. Clone and run:

   ```powershell
   git clone https://github.com/clasen/pi-desktop.git C:\dev\pi-desktop
   cd C:\dev\pi-desktop
   npm install --ignore-scripts=false
   powershell -c "irm https://pi.dev/install.ps1 | iex"   # if you don't have Pi yet; then open a new terminal
   npm run dev
   ```

| Error | Fix |
|-------|-----|
| `MSB8040`: Spectre libs missing | Uninstall VS Build Tools 2026, install 2022 with the v143 Spectre libs |
| `electron-vite is not recognized` | `npm install` didn't finish. Run it again |
| `EPERM` / `EACCES` writing files | Controlled Folder Access. Move the folder (step 2), or allow `Pi Desktop.exe` (plus `node.exe`, `git.exe`, `electron.exe` for development) under **Windows Security → Ransomware protection → Allow an app through Controlled folder access**. The portable `.exe` extracts to a new temp folder each launch, so use the installer if you go the allow-list route |
| Pi shows "error" in the status popover | Pi isn't installed or the PATH hasn't refreshed. Open a new terminal |
| Electron binary missing after install | Add the folder to Defender exclusions and run `npm install` again. Still missing? Download it by hand (below) |

If `node_modules\electron\dist` ends up with no `electron.exe`, fetch it directly (use the version from `node_modules/electron/package.json`):

```powershell
$ver = "43.0.0"
$url = "https://github.com/electron/electron/releases/download/v$ver/electron-v$ver-win32-x64.zip"
$zip = "$env:TEMP\electron-v$ver-win32-x64.zip"
Invoke-WebRequest -Uri $url -OutFile $zip
if (Test-Path node_modules\electron\dist) { Remove-Item -Recurse -Force node_modules\electron\dist }
Expand-Archive -Path $zip -DestinationPath node_modules\electron\dist -Force
"electron.exe" | Out-File -Encoding ASCII -NoNewline node_modules\electron\path.txt
"v$ver" | Out-File -Encoding ASCII -NoNewline node_modules\electron\dist\version
```

Windows is community-tested. If you hit something not listed here, [open an issue](https://github.com/clasen/pi-desktop/issues).

</details>

## Standing on good shoulders

Pi Desktop started as [FaqFirebase/pi-desktop](https://github.com/FaqFirebase/pi-desktop) ([pi-desktop.com](https://pi-desktop.com)). They built something genuinely well thought out, and they were remarkably open to my pull requests, which is rarer than it should be. Thank you.

This fork is that same app, bent to my taste in how it looks and how it works. If you like where it's going, great. If you don't, the original is excellent too, and both are a `git clone` away from being whatever you want.

## Links

[Original project](https://github.com/FaqFirebase/pi-desktop) · [pi.dev](https://pi.dev) · [Packages](https://pi.dev/packages) · [Issues](https://github.com/clasen/pi-desktop/issues)

Apache 2.0
