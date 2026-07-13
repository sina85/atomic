#!/bin/sh
# Literal executed tmux commands, recorded before execution.
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'seed' -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/stale-picker-row-revalidation/markers" label=final-stale --no-picker'
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'seed' Enter
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'stale' -l -- '/workflow resume'
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'stale' Enter
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'helper' -l -- '/workflow resume cddb94fd-7aa5-4c8b-95e3-b3ca52d1b3a7'
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'helper' Enter
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'helper' Enter
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'helper' -l -- 'final-stale-helper'
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'helper' Enter
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'helper' C-c
tmux -S '/tmp/atomic-b452fin-stale-picker-row-revalidation.sock' send-keys -t 'stale' Enter
