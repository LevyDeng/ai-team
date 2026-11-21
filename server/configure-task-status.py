#!/usr/bin/env python3
"""Register notification-only task hooks while retaining existing user hooks."""
import json
import os
from pathlib import Path
import uuid

directory = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "windows-mcp" / "claude"
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
filename = directory / "settings.json"
if filename.is_symlink():
    raise SystemExit("The Claude settings file must not be a symbolic link.")
settings = json.loads(filename.read_text()) if filename.exists() else {}
hooks = settings.setdefault("hooks", {})
changed = False
events = {"UserPromptSubmit": "running", "PreToolUse": "running", "PostToolUse": "running",
          "PostToolUseFailure": "running", "PermissionRequest": "waiting", "Stop": "completed",
          "StopFailure": "failed", "SessionEnd": "stopped"}
for event, phase in events.items():
    command = f"bash /opt/windows-mcp/record-task-state.sh {phase}"
    entries = hooks.setdefault(event, [])
    if not any(any(hook.get("command") == command for hook in entry.get("hooks", [])) for entry in entries):
        entries.append({"hooks": [{"type": "command", "command": command, "timeout": 2}]})
        changed = True
notification = {"matcher": "permission_prompt|elicitation_dialog", "hooks": [{"type": "command", "command": "bash /opt/windows-mcp/record-task-state.sh waiting", "timeout": 2}]}
if notification not in hooks.setdefault("Notification", []):
    hooks["Notification"].append(notification)
    changed = True
if changed:
    backup = directory / "settings.before-relay-task-status.json"
    if not backup.exists():
        with backup.open("x") as output:
            os.chmod(backup, 0o600)
            json.dump(json.loads(filename.read_text()) if filename.exists() else {}, output, indent=2)
    temporary = directory / (".task-settings-" + uuid.uuid4().hex)
    try:
        with temporary.open("x") as output:
            os.chmod(temporary, 0o600)
            json.dump(settings, output, indent=2)
            output.write("\n")
        os.replace(temporary, filename)
    finally:
        temporary.unlink(missing_ok=True)
print(json.dumps({"configured": True, "changed": changed}))
