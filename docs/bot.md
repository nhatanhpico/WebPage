# Auto-reply bot (Claude Code / Antigravity)

The bot signs in to your Shared Notes site with one account, waits for new messages, sends them (text and images) to **Claude Code** or **Antigravity CLI**, and posts the answer from that account. It runs on your Mac, in a terminal, and works only with a Shared Notes site: before doing anything it checks that the page really is Shared Notes and stops otherwise.

It uses the same CLI setup as [ScreenClaude](../../hotkey): your existing `claude` / `agy` logins, your plan and quota. No API key is needed.

## Requirements

- Google Chrome in `/Applications` (the bot drives it in the background, no window).
- At least one AI CLI, signed in:
  - Claude Code at `~/.local/bin/claude` (`claude auth login`)
  - Antigravity CLI at `~/.local/bin/agy`
- Node.js 24 or newer (tested with 25) and `npm install` in the project folder.

## Quick start

```bash
cd /Users/nhatanh245/Project/WebPage
npm install            # only the first time
npm run bot:setup      # link, AI, conversation, options
npm run bot            # start; the first time it asks for the account and password
```

Leave the terminal open while the bot should answer. Press **Ctrl+C** to stop it.

```
11:57:42 AM ✔ Signed in as Wei. Waiting for new messages… (Ctrl+C to stop)
11:57:45 AM New message from Anh: Reply with exactly one word: pong
11:57:46 AM Asking Claude Code…
11:57:49 AM ✔ Replied (4 characters)
```

**Tip:** create a separate account for the bot (`npm run account:add`, e.g. "Claude"). Its answers then show on the left with that name, clearly apart from your own messages.

## Commands

| Command | What it does |
|---|---|
| `npm run bot` | Start the bot. Add `-- --show` to watch it in a Chrome window, `-- --answer-last` to also answer the newest message from another account that is already there. |
| `npm run bot:setup` | Change every setting, step by step (Enter keeps the current value). |
| `npm run bot:url -- <link>` | Change only the site link, e.g. `npm run bot:url -- https://nhatanhpico.github.io/WebPage/`. |
| `npm run bot:new` | The next answer starts a new conversation with the current AI. |
| `npm run bot:others -- on` / `off` | **On:** answer only messages from other accounts. **Off** (default): also answer messages from the bot's own account sent from other devices. Without `on`/`off` it switches. |
| `npm run bot:login` | Sign in again (e.g. with another account, or after a password change). |
| `npm run bot:logout` | Sign out and remove the saved key. |
| `npm run bot:status` | Show the settings and whether the bot is running. |
| `npm run bot:check` | Check both CLIs (without using the model) and that the link is a Shared Notes site. |

Settings changed with `bot:setup`, `bot:others`, `bot:url` or `bot:new` apply to the next message, even while the bot is running. A new link applies the next time you start it.

## Settings (`bot:setup`)

- **Site link:** must be `https://…` (or `http://localhost…` for testing). If the page is not a Shared Notes site, the bot refuses to run.
- **AI:** Claude Code or Antigravity CLI. Each keeps its own conversation setting, so switching AI never loses the other one's conversation.
- **Conversation:**
  - *Start a new conversation*: the next answer creates a new conversation, saved in the CLI's history (Claude names it "Shared Notes bot <date>").
  - *Continue an existing conversation*: pick one from the list of recent conversations of that AI, or paste its ID. The answer is added to that conversation, with all its earlier context.
- **Keep history** (on by default): after each answer, the next one continues the same conversation, so the AI remembers the chat. Turn it off to make every answer a fresh conversation (or always the same chosen one). `npm run bot:new` starts over.
- **Only answer messages starting with:** e.g. `@ai`. Empty answers every new message. The prefix is removed before the message goes to the AI.
- **Only answer messages from other accounts** (off by default, also `npm run bot:others -- on|off`): when off, messages from the bot's own account sent from your phone or another device are answered too, as soon as they arrive. When on, only other accounts' messages are answered. Either way the bot never answers its own replies: it recognizes them by message ID.
- **Send answers as:** Markdown (code blocks with highlighting, lists, bold) or plain text.
- **Extra instructions:** added to every request, e.g. "Answer briefly" or "Always answer in Vietnamese".

## How it behaves

- **Only new messages:** messages that were already in the space when the bot started are ignored (unless `--answer-last`). The site re-sends old messages whenever a device joins; the bot recognizes and skips them.
- **Messages sent together:** after a new message the bot waits `settleSeconds` (3 s) for more, then sends them as one request. An image followed by "solve this" therefore gets one answer.
- **Images** in a message go to the AI with it. Voice messages and other files can't be read; the AI is told they were there.
- **Long answers** are split into several messages (the site's limit is 5,000 characters). A code block that is cut is closed and reopened, so every part still renders correctly.
- **One at a time:** while the AI is answering, new messages wait and are answered next. Only one bot can run at a time.
- **Errors:** if the AI fails (timeout, quota, not signed in), the bot posts a short `⚠️ … couldn't answer: …` message so you know on your phone, and keeps running.
- **At least one other device:** like every device, the bot only exchanges messages with devices that are online. It also keeps the space alive while it runs.

## Privacy and safety

- **Password:** typed once in the terminal and given to the site's own sign-in form; never saved. Like a browser, the bot's Chrome profile keeps only the site's derived key. `npm run bot:logout` removes it.
- **Where data goes:** each message (with its images) is sent through the CLI to the AI service of your account and is **saved in that CLI's history**, so conversations can be continued. That is the same as using `claude` / `agy` yourself.
- **Prompt injection:** anyone who can post in the space can make the AI read their text. Claude Code runs with every tool turned off (`--tools ""`, safe mode, no MCP), so it can only write text. Antigravity runs in `--sandbox` without skipping permissions and is told not to run commands or edit files, but it has no switch that turns every tool off.
- **Files on disk:** `~/Library/Application Support/SharedNotesBot/` (folder `0700`):

| Path | Contents |
|---|---|
| `config.json` | Settings above, plus CLI paths (`claude.path`, `antigravity.path`), `effort` (low/medium/high), `timeoutSeconds` (300), `settleSeconds` (3), `chrome` |
| `chrome-profile/` | The bot's own Chrome profile (site session = derived key, theme) |
| `Conversations/` | Working folder for new Claude conversations |
| `request-…/` | Temporary input/output of one request, deleted when it finishes |
| `bot.pid` | Present while the bot runs |

## Troubleshooting

- **"… is not a Shared Notes site"**: check the link with `npm run bot:url -- <link>`.
- **"Waiting for other devices…" in the log**: no other device has the site open, or the network blocks WebRTC (see the README's *Limits*).
- **"Claude Code returned no answer" / "exited with code …"**: run `npm run bot:check`; sign in to the CLI again if needed.
- **"The bot is already running"**: stop the other one with Ctrl+C in its terminal.
- **Incorrect account or password**: `npm run bot:login`.
