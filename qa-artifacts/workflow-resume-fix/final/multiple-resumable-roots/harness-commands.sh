#!/bin/sh
# Literal tmux invocations executed against isolated full-screen TUI.
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t 'a' -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/multiple-resumable-roots/markers" label=final-multi-A --no-picker'
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t 'a' Enter
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t 'b' -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/multiple-resumable-roots/markers" label=final-multi-B --no-picker'
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t 'b' Enter
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser -l -- '/workflow resume'
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser Enter
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser Enter
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser Enter
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser -l -- 'final-multi-B-answer'
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser Enter
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser2 -l -- '/workflow resume'
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser2 Enter
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser2 Enter
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser2 Enter
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser2 -l -- 'final-multi-A-answer'
tmux -S '/tmp/atomic-b452-batcha-multiple.sock' send-keys -t chooser2 Enter
