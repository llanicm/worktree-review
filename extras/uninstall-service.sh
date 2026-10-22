#!/bin/sh
# Stops the optional login service. Review state in ~/.claude/worktree-review is kept.
LABEL=local.worktree-review
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Stopped the Worktree Review login service."
