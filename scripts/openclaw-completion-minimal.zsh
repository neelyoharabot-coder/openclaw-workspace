# Minimal OpenClaw completion (first word only).
# HOW TO USE: type  openclaw␠  (openclaw + SPACE), then press the Tab KEY.
# Do NOT type the < character — in zsh, < means "redirect input" and breaks completion.

(( ${+functions[compdef]} )) || return 0

compdef -d openclaw 2>/dev/null

_openclaw_minimal() {
  _values 'command' \
    acp agent agents approvals backup browser channels completion config configure cron \
    daemon dashboard devices directory dns docs doctor gateway health help hooks logs \
    memory message models node nodes onboard pairing plugins qr reset sandbox secrets \
    security sessions setup skills status system tui uninstall update webhooks clawbot
}

compdef _openclaw_minimal openclaw
