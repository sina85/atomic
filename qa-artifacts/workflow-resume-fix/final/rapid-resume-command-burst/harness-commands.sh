#!/bin/sh
# Literal tmux commands executed against isolated full-screen Atomic TUI.
tmux -S '/tmp/atomic-final-b452-rapid.sock' send-keys -t seed -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/rapid-resume-command-burst/markers" label=final-rapid --no-picker'
tmux -S '/tmp/atomic-final-b452-rapid.sock' send-keys -t seed Enter
tmux -S '/tmp/atomic-final-b452-rapid.sock' send-keys -t first -l -- '/workflow resume 224faebb-6d87-4e3e-a57a-80a1d92f69c8' \; send-keys -t first Enter \; send-keys -t second -l -- '/workflow resume 224faebb-6d87-4e3e-a57a-80a1d92f69c8' \; send-keys -t second Enter
tmux -S '/tmp/atomic-final-b452-rapid.sock' send-keys -t first -l -- 'final-rapid-answer'
tmux -S '/tmp/atomic-final-b452-rapid.sock' send-keys -t first Enter
