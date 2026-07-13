#!/bin/sh
# Literal executed tmux commands, recorded before execution.
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'seed' -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/selector-cancel-reopen/markers" label=final-cancel --no-picker'
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'seed' Enter
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'chooser' -l -- '/workflow resume'
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'chooser' Enter
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'chooser' Escape
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'chooser' -l -- '/workflow resume'
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'chooser' Enter
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'chooser' Enter
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'chooser' Enter
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'chooser' -l -- 'final-cancel-answer'
tmux -S '/tmp/atomic-b452fin-selector-cancel-reopen.sock' send-keys -t 'chooser' Enter
