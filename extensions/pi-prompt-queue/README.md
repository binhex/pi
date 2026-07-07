# pi-prompt-queue

Queue up prompts that **auto-fire** after the agent finishes its current work. Manage the queue via a floating overlay
panel (Ctrl+Q) while the agent works.

## Install

```bash
pi install npm:@your-npm-username/pi-prompt-queue
```

Or try it without installing:

```bash
pi -e /path/to/package
```

## Usage

### Command: `/q` or `/queue`

| Command | Description |
|---------|-------------|
| `/q` | Toggle the queue panel |
| `/q add <prompt>` | Add a single prompt |
| `/q add <a> ;; <b> ;; <c>` | Add multiple prompts (separate with `;;`) |
| `/q list` | Show queue status |
| `/q remove <id>` | Remove by item ID |
| `/q clear` | Empty the queue |
| `/q next` | Fire the next prompt immediately |
| `/q pause` / `/q resume` | Pause/resume auto-advance |
| `/q delay <sec>` | Set idle delay (default 5s) |
| `/q insert <pos> <prompt>` | Insert at position (1-based) |

#### Queuing multiple prompts at once

Separate prompts with `;;` to queue several in a single command:

```bash
/q add Review the README for typos ;; Add tests for the new feature ;; Update the changelog
```

Each prompt fires one at a time in order — no need to wait and type each one, if you do want to change the order then
please use the the TUI floating panel `/q`.

### TUI Panel

Press **Ctrl+Q** to open/close the floating panel. Navigate with arrow keys:

- `d` / `Del` — remove selected item
- `a` — add a new prompt
- `m` / `M` — move item up/down
- `c` — clear all items
- `n` — fire next now
- `p` — pause/resume auto-advance
- `Esc` — close panel

The footer shows `Queue:N Xs` — queue count and countdown timer.

### Auto-Advance

Prompts fire sequentially after the configured delay (default 5s). If the agent asks a question, the queue **waits**
for your answer before advancing. Typing anything cancels a pending advance so you can respond.

### Template expansion

When a queued prompt starts with `/`, the extension looks for a matching **prompt template** in
`~/.pi/agent/prompts/` and expands it before sending. If the template is a **chain** (has a `chain:` directive
in its frontmatter), each step is queued separately so they auto-advance one after another.

```bash
# Queue a chain — each step becomes its own queue item
/q add /chain-fix this is broken

# Queue a single template
/q add /prompt-code-review check the new login flow
```

| Feature | Supported? | Notes |
|---|---|---|
| Chain templates (`/chain-fix`, `/chain-implement`, etc.) | ✅ | Each step expanded and queued separately |
| Prompt templates (`/prompt-code-review`, `/prompt-debugging`, etc.) | ✅ | Template body expanded with `$@` args |
| Extension commands (`/q add`, `/settings`, etc.) | ❌ | These run directly in Pi — don't queue them |
| Pi built-ins (`/login`, `/reload`, `/skill:name`, etc.) | ❌ | Won't expand, raw text sent to the LLM |
