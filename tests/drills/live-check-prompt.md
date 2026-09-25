Live check of the Codex plugin loaded from --plugin-dir. Keep every reply to a sentence or two, and follow these steps in order.

1. Without running any command, name the open Codex tickets you were told about at session start (or say you were told about none).
2. Run exactly: node "$CODEX_COMPANION" delegate --ticket nudge "Nudge check."
   Then run: sleep 5
   Then end your turn with one sentence. Do not run wait, show, or tickets, and do not use the codex-delegation skill yet.
3. If the stop hook then reminds you about a finished ticket, say "stop reminder received", then run: node "$CODEX_COMPANION" close nudge --accepted --reason "live check"
4. Next, use the codex-delegation skill, then run exactly: node "$CODEX_COMPANION" delegate --ticket monitor $'Monitor check.\nFAKE_SLOW'
   End your turn without waiting. The plugin monitor should notify you in about 10 seconds. When the notification arrives, reply "monitor notification received" and quote it.
