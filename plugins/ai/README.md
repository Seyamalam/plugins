# The AI plugin

ardia-browser/ardia#2463. AI in Ardia is a first-party plugin on Ardia's plugin host (the host's contract is
`docs/plugins.md` in ardia-browser/ardia): off until you turn it
on, and when it's off nothing of it exists anywhere in the browser. It runs a chat at `ardia://ai/<chat id>` on your
own Claude or ChatGPT plan, through the command line tools you already signed in to, and it reads and uses your tabs
only as described under Permissions. Everything it needs from the browser is a public plugin-host contribution.

```
plugins/ai/
  plugin.json          the manifest: page, process and its home grants, commands, toolbar, New Tab mode, rows
  skill/browser.md     the instructions the agent runs with (installed as CLAUDE.md, AGENTS.md and a skill)
  page/                the chat page: React, built with esbuild; src/tokens.css holds fallbacks for the --ardia-*
                       look variables the host sets on the page at runtime
  runtime/             T3 Code's server, pinned (UPSTREAM) and patched (series, patches/), plus src/: our code
  build.sh             builds the plugin folder: binary, its packages, the page, the manifest and the skill
  tests/               unit tests: permissions, tools, channel, page state, shell state, send and tags
```

## How it runs

- **The helper** is T3 Code's server (MIT, `runtime/NOTICE`), stripped to Claude Code and Codex sessions, MCP and
  the environment protocol (#2460), as one Node executable, `bin/ardia-ai ardia`. The host starts it in its sandbox
  with the grants in the manifest: read and write `~/.claude`, `~/.claude.json`, `~/.codex` and Claude's state and
  caches, read `~/.local/bin` and `~/.local/share/claude`, with `HOME` set to your home, so `claude` and `codex` run
  with the login they already have. Nothing is copied: refresh tokens rotate, and a copy would sign you out.
- **Launch** (`runtime/src/main.ts`): it says `hello` on the channel (descriptor 3), makes a 32-byte secret, picks a
  free port on 127.0.0.1, and starts the server in T3's desktop mode with the secret as its rotating bootstrap secret
  (`desktopBootstrapSecret`, given through `--bootstrap-fd` from a file it opens and unlinks at once). Its data is
  `PluginData/ai/t3`; the agents' working folder is `PluginData/ai/workspace`, which holds the skill. When the
  server answers it starts the page bridge. It exits when the channel closes, and T3's launcher watch stops it if Ardia
  dies.
- **The page** is static files in the plugin's `page/` (`page.file`), shown offline: it has no port, token or network.
  It reads its route from `ardiaPath` and the tab it was handed from `window.ardia.context`, and talks to the helper
  only through `window.ardia.send` and `page.post` (`page/src/channelLink.ts`, `runtime/src/pageBridge.ts`, frames in
  `runtime/src/frames.ts`): `call` and `stream` reach the methods the chat uses of T3's RPC
  (`orchestration.launchThread`, `subscribeThread`, `getThreadProjection`, `dispatchCommand`, `subscribeShell`,
  `projects.mutate`, `server.getConfig`, `server.refreshProviders`; nothing else), `api` reaches Ardia's routes below
  in-process, and `open` sends a link to the helper's `open` (so links open as tabs, with `commands`). Every frame
  carries a random id per page load, and answers go to the view that asked; the page pings every 3 s, and when a page
  comes back on a new view (it left its window and returned) the helper stops its old streams and tells it to ask
  again. `page.post` answers `overloaded` → the helper waits (100 ms, doubling to 2 s) and sends the same frame
  again, in order; past 4 MB waiting for one page, or a view that's gone, it drops what waited and the page
  resubscribes. Frames over the host's limits go in parts. The helper speaks T3's RPC through one session of its own;
  the page never signs in. The page's setup (info, providers, the shell subscription) is one state machine
  (`page/src/sessionInit.ts`): a failure is kept until a setup succeeds, retried 1, 2, 4, 8 and 16 s later, then again
  on the next project creation or when the link is healthy again; a health probe never clears it. A chat's id is its
  T3 thread id, so `ardia://ai/<id>` is its address from the first moment.
- **Ardia's routes** (`/ardia/*`, `runtime/src/routes.ts`) give the page what T3's RPC doesn't: permission asks
  (long-poll `GET /ardia/events`, `POST /ardia/asks/answer`), the chat's tabs (`GET /ardia/tabs`), send and stop
  (`POST /ardia/send` tags tabs and makes the group, `POST /ardia/stop`), opening a chat or history
  (`POST /ardia/open` → `page.open`), the first-run mode (`POST /ardia/settings` → `values.set`) and sign-in
  (`POST /ardia/login` opens `claude auth login` or `codex login` in Terminal). The page reaches them through the bridge;
  over HTTP (the standalone dev server) each request needs a bearer checked against the server's own
  `/api/auth/session`, `Host: 127.0.0.1:<port>` and no foreign `Origin`.
- **Stop** belongs to a turn (`runtime/src/turnLedger.ts`, patch `0004-turn-ledger`): T3 tells the ledger when it
  launches a provider turn on a thread and when that turn ends; every tool call is checked against the turn T3 has
  running on the calling thread, captures that turn's token for its whole run, and is refused when the turn is
  unknown, ended or stopped. Stop aborts every turn of the chat for good and dispatches `thread.stop` in-process; a new
  message's turn gets a new token and never revives an old one. A tool waiting on a permission ask checks again when
  the ask settles, and `browse` before and after each host round trip.
- **Tools** (`runtime/src/browserToolkit.ts`) are an MCP toolkit in T3's MCP server, which T3 already gives every
  provider session with a bearer of its own, so a call always knows its chat (`McpInvocationContext`; a chat can't
  act as another). It replaces T3's own toolkits: an agent in Ardia gets `ardia_chat_context`, `ardia_list_tabs`,
  `ardia_read_tab`, `ardia_click`, `ardia_type`, `ardia_open_tab`, `ardia_close_tab`, `ardia_activate_tab`,
  `ardia_add_to_chat_group`, `ardia_split_to_group` and `send_to_user`, all loaded up front. Claude Code runs with only
  `WebSearch` and `WebFetch` of its built-in tools (`runtime/src/policy.ts`): no shell, no file reads or writes.
  Reading and acting on pages go through the host's `browse` method, which runs the `ardia browse` layer on the
  engine's token policy; tabs, groups and splits go through `workspace`, `apply`, `group.withPage` and
  `split.toGroup`.

## Permissions

`runtime/src/permissions.ts` decides; `tests/permissions.test.mjs` and `tests/browserTools.test.mjs` pin it.

| Action | Allowed at once | Asks (Allow ↩ / Always / Don't) | Never |
| --- | --- | --- | --- |
| Read a tab | in the chat's group or split, tagged, or opened by the agent; a site you chose Always for | any other tab | private windows (the host never lists them), Ardia's pages, chats |
| Click, type | a site you chose Always for (to act) | every other time, shown with the tab's banner while it acts | as above |
| Open a tab | http(s) only | | anything else |
| Close or regroup a tab | the agent's own, or the chat's | any other tab | as above |

- "Always" is kept per site (scheme, host and port) and per kind in `PluginData/ai/grants.json`; acting implies
  reading. An ask times out as no after 5 minutes. Stop in the tab's banner stops the chat: every tool refuses until
  you send a new message.
- Page text reaches the agent wrapped as data from the site, and the skill says it is never instructions.

## The skill

`skill/browser.md` holds the rules the agent follows, as instructions, not code, and the end-to-end test checks each:
every tab it opens goes into the chat's group; in a Split View, opening a tab first turns the split into a group.
Hard-coded in the browser, not in the skill: tagging a tab with @ and sending always makes a group headed by the chat,
and tabs tagged later join it (`POST /ardia/send`).

## Building

`build.sh <out dir> [<t3code tree>]` needs Node 26.13.1 (T3's engines) with pnpm on `PATH`; it installs the page's one build tool (esbuild, `package.json` here) with `npm ci` first. It clones T3
Code at the pinned commit (or uses the tree given), runs `runtime/apply.sh` (patches once, recorded in
`.ardia-patches`; copies `runtime/src` to `apps/server/src/ardia`), installs, builds the executable with
`APP_VERSION` from `runtime/UPSTREAM`, and assembles `<out>/ai`: `plugin.json`, `skill/`, `NOTICE`, `bin/ardia-ai`,
`bin/node_modules` (undici, ffi-rs, fff-node and their binaries) and `page/` (the chat page, `page/build.mjs`).

## Updating T3 Code

1. Pick the commit: the `t3codeCommitHash` of the T3 Code app you match, or upstream `main`.
2. In a checkout of T3 Code at the new commit, run `runtime/apply.sh`. A patch that doesn't apply: apply it with
   `git apply --3way`, fix the conflict, and write the patch again with `git diff <commit> -- <files>`. The strip
   (`0001`) mostly touches `server.ts`, the composition root, and every new upstream service there needs a decision:
   keep it, or replace it with a loud `removed(...)` or an explicit layer in `stripped/disabled.ts` (never a silent
   catch-all). `0002` holds the Ardia entry (`binMain.ts`), the routes, the toolkit list, the disabled services and
   the Claude tool list.
3. Typecheck (`pnpm -C apps/server typecheck`), and run the page check: copy `page/src` into
   `apps/web/ardia-page-check/src` with a tsconfig that extends `../tsconfig.json` (Effect diagnostics
   `cryptoRandomUUID`, `preferUnsafeConstructor`, `anyUnknownInErrorContext` and the `global*` ones off), then
   `../../node_modules/.bin/effect-tsgo tsrs --noEmit -p ardia-page-check/tsconfig.json` from `apps/web`.
4. Update `runtime/UPSTREAM` (commit and version), build, and run the end-to-end test.

## Tests

- `node --test tests/*.test.mjs`: permissions, tools against a fake host, the channel, page and shell state.
- In-app checks drive a real Ardia, so they live in ardia-browser/ardia: `scripts/plugins/ai-m1.mjs` (a hidden
  instance with this folder installed and turned on, the real runtime on the cheapest model, a real click on the
  toolbar button, a question, captures).

## Telemetry

Counts only, through the host's `telemetry.count`, sent only while sharing is on: `chats_started`,
`mode_browser_first`, `mode_ai_first`, `tool_read`, `tool_act`, `tool_open`, `tool_close`, `tool_group`,
`tool_split_to_group`, `permission_allowed`, `permission_always`, `permission_denied`, `permission_timed_out`,
`runtime_crashes`, `banner_stops`, `tag_groups_created`, `tag_groups_joined`, `signin_started`, `tool_refused_stopped`,
`tool_refused_ended`, `tool_refused_unknown`. Never prompts, page
content, URLs or titles. Dashboard: watch `permission_denied` against `permission_allowed` (asks that annoy),
`runtime_crashes` against `chats_started`, and `tool_split_to_group` against splits that got a tab opened. `tool_refused_stopped` should follow `banner_stops`
and Stop presses; `tool_refused_unknown` should stay near zero (a tool call T3 couldn't place in a turn).
