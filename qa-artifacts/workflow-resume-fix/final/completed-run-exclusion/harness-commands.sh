#!/bin/sh
# Literal tmux invocations executed against isolated full-screen TUI.
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t owner -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/completed-run-exclusion/markers" label=final-completed --no-picker'
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t owner -l -- '/workflow connect 87b3bc1c-0529-4c39-b469-550f921c4b98'
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t owner -l -- 'final-completed-answer'
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t verifier -l -- '/workflow resume'
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t verifier Enter
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t verifier Escape
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t verifier -l -- '/workflow resume 87b3bc1c-0529-4c39-b469-550f921c4b98'
tmux -S '/tmp/atomic-b452-batcha-completed.sock' send-keys -t verifier Enter
