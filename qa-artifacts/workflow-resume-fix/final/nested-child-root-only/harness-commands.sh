#!/bin/sh
# Literal tmux commands executed against isolated full-screen Atomic TUI.
tmux -S '/tmp/atomic-final-b452-nested.sock' send-keys -t seed -l -- '/workflow workflow-resume-e2e-fixture mode=nested marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/nested-child-root-only/markers" label=final-nested --no-picker'
tmux -S '/tmp/atomic-final-b452-nested.sock' send-keys -t seed Enter
tmux -S '/tmp/atomic-final-b452-nested.sock' send-keys -t chooser -l -- '/workflow resume'
tmux -S '/tmp/atomic-final-b452-nested.sock' send-keys -t chooser Enter
tmux -S '/tmp/atomic-final-b452-nested.sock' send-keys -t chooser Enter
tmux -S '/tmp/atomic-final-b452-nested.sock' send-keys -t chooser Enter
tmux -S '/tmp/atomic-final-b452-nested.sock' send-keys -t chooser -l -- 'final-nested-answer'
tmux -S '/tmp/atomic-final-b452-nested.sock' send-keys -t chooser Enter
