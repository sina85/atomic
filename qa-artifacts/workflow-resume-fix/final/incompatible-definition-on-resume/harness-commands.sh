#!/bin/sh
# Literal tmux commands executed against isolated full-screen Atomic TUI.
tmux -S '/tmp/atomic-final-b452-incompat.sock' send-keys -t v1 -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/incompatible-definition-on-resume/markers" label=final-incompatible --no-picker'
tmux -S '/tmp/atomic-final-b452-incompat.sock' send-keys -t v1 Enter
tmux -S '/tmp/atomic-final-b452-incompat.sock' send-keys -t v2 -l -- '/workflow resume 204b7be5-b6d7-4317-b11c-dd4598aef41c'
tmux -S '/tmp/atomic-final-b452-incompat.sock' send-keys -t v2 Enter
tmux -S '/tmp/atomic-final-b452-incompat.sock' send-keys -t v2 -l -- '/workflow resume 204b7be5-b6d7-4317-b11c-dd4598aef41c'
tmux -S '/tmp/atomic-final-b452-incompat.sock' send-keys -t v2 Enter
