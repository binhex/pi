# pi-prompt-queue

Queue up prompts that **auto-fire** after the agent finishes its current work. Manage the queue via a floating overlay panel (Ctrl+Q) while the agent works.

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

Prompts fire sequentially after the configured delay (default 5s). If the agent asks a question, the queue **waits** for your answer before advancing. Typing anything cancels a pending advance so you can respond.
