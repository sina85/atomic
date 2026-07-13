#!/bin/sh
# Literal tmux invocations executed against isolated full-screen TUI.
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t owner -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/active-duplicate-resume-refused/markers" label=final-active --no-picker'
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t owner -l -- '/workflow connect dd4609fb-5b26-400e-b844-00c7d45f90bb'
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t contender -l -- '/workflow resume'
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t contender Enter
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t contender Escape
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t contender -l -- '/workflow resume dd4609fb-5b26-400e-b844-00c7d45f90bb'
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t contender Enter
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t owner -l -- 'final-active-answer'
tmux -S '/tmp/atomic-b452-batcha-active.sock' send-keys -t owner Enter
