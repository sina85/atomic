#!/bin/sh
# Literal tmux invocations executed against the isolated full-screen TUI; each line was tee-recorded before execution.
tmux -S '/tmp/atomic-final-b452-resume-picker-then-workflow-resume.sock' send-keys -t 'seed' -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/resume-picker-then-workflow-resume/markers" label=final-picker --no-picker'
tmux -S '/tmp/atomic-final-b452-resume-picker-then-workflow-resume.sock' send-keys -t 'seed' Enter
tmux -S '/tmp/atomic-final-b452-resume-picker-then-workflow-resume.sock' send-keys -t 'chooser' -l -- '/workflow resume'
tmux -S '/tmp/atomic-final-b452-resume-picker-then-workflow-resume.sock' send-keys -t 'chooser' Enter
tmux -S '/tmp/atomic-final-b452-resume-picker-then-workflow-resume.sock' send-keys -t 'chooser' Enter
tmux -S '/tmp/atomic-final-b452-resume-picker-then-workflow-resume.sock' send-keys -t 'chooser' Enter
tmux -S '/tmp/atomic-final-b452-resume-picker-then-workflow-resume.sock' send-keys -t 'chooser' -l -- 'final-picker-answer'
tmux -S '/tmp/atomic-final-b452-resume-picker-then-workflow-resume.sock' send-keys -t 'chooser' Enter
