#!/bin/sh
# Literal executed tmux commands, recorded before execution.
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'owner' -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/exact-session-after-ctrl-c/markers" label=final-exact --no-picker'
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'owner' Enter
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'owner' -l -- '/workflow connect 100e7747-ea89-4a89-841c-3c486aea9c9b'
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'owner' Enter
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'owner' Enter
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'owner' C-c
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'recovered' -l -- '/workflow resume 100e7747-ea89-4a89-841c-3c486aea9c9b'
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'recovered' Enter
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'recovered' Enter
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'recovered' -l -- 'final-exact-answer'
tmux -S '/tmp/atomic-b452fin-exact-session-after-ctrl-c.sock' send-keys -t 'recovered' Enter
