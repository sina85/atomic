#!/bin/sh
# Literal executed tmux commands, recorded before execution.
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'seed' -l -- '/workflow workflow-resume-e2e-fixture mode=double-prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/sigkill-after-next-prompt-render/markers" label=final-sigkill --no-picker'
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'seed' Enter
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'seed' -l -- '/workflow connect 3f1af1f9-4330-4705-b7e2-a5c1a3eb0ce7'
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'seed' Enter
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'seed' Enter
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'seed' -l -- 'final-sigkill-first'
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'seed' Enter
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'seed' Enter
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'recovered' -l -- '/workflow resume 3f1af1f9-4330-4705-b7e2-a5c1a3eb0ce7'
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'recovered' Enter
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'recovered' Enter
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'recovered' -l -- 'final-sigkill-second'
tmux -S '/tmp/atomic-b452fin-sigkill-after-next-prompt-render.sock' send-keys -t 'recovered' Enter
