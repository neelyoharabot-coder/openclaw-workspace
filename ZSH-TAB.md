# OpenClaw + zsh Tab completion

## Why you see `parse error near '\n'`

If you type **`openclaw <TAB>`** (with a **less-than sign** `<`), zsh thinks you are doing **input redirection**, not “press Tab”. That causes a parse error.

## Correct way

1. Type: **`openclaw`** then **`Space`**
2. Press the physical **Tab** key (usually above Caps Lock)

You should **never** type the characters `<`, `T`, `A`, `B`, `>` when the docs say “Tab”.

## Reload completion after changes

```zsh
source ~/.zshrc
```

## If Tab still fails

Run `openclaw` with no arguments — it prints the full command list. Nested options: `openclaw cron --help`, etc.
