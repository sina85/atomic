#!/bin/sh
# Literal executed tmux commands, recorded before execution.
tmux -S '/tmp/atomic-b452-recoverable-failure-resume.sock' send-keys -t 'tui' -l -- '/workflow workflow-resume-e2e-fixture mode=fail-once marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/recoverable-failure-resume/markers" label=final-recoverable --no-picker'
tmux -S '/tmp/atomic-b452-recoverable-failure-resume.sock' send-keys -t 'tui' Enter
tmux -S '/tmp/atomic-b452-recoverable-failure-resume.sock' send-keys -t 'resumed' -l -- '/workflow resume 376f5097-82c2-48f6-a6a0-e250e7539018'
tmux -S '/tmp/atomic-b452-recoverable-failure-resume.sock' send-keys -t 'resumed' Enter
tmux -S '/tmp/atomic-b452-recoverable-failure-resume.sock' send-keys -t 'resumed' Enter
