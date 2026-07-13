#!/bin/sh
# Literal tmux invocations executed against the isolated full-screen TUI; each line was tee-recorded before execution.
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'seed' -l -- '/workflow workflow-resume-e2e-fixture mode=double-prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/repeated-resume-across-two-prompts/markers" label=final-repeated --no-picker'
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'seed' Enter
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r1' -l -- '/workflow resume'
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r1' Enter
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r1' Enter
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r1' Enter
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r1' -l -- 'final-repeated-first'
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r1' Enter
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r1' Enter
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r2' -l -- '/workflow resume d5d2c7b3-d948-4978-99d2-337260a68448'
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r2' Enter
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r2' Enter
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r2' -l -- 'final-repeated-second'
tmux -S '/tmp/atomic-final-b452-repeated-resume-across-two-prompts.sock' send-keys -t 'r2' Enter
