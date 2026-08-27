---
name: "safari-ios-webinspector"
description: "Use this skill when debugging iPhone Safari or iPhone Chrome sessions from a Mac through Safari Web Inspector. Prefer the safari-ios-webinspector MCP server for live-device inspection, runtime logs, crash detection, recovery, and evidence export."
---

# Safari iOS Web Inspector

Use this skill when the user asks to debug:

- iPhone Safari
- iPhone Chrome
- Safari Web Inspector
- iOS browser crashes
- mobile WebGL behavior on iPhone

## Workflow

1. Start with `check_environment`.
2. If dependencies are present, call `start_bridge`.
3. Use `list_devices` and `list_pages` to identify the correct page.
4. Call `attach_page`.
5. Prefer:
   - `get_console_messages`
   - `get_network_requests`
   - `evaluate_script`
   - `get_dom_snapshot`
   - `get_crash_state`
6. If the page dies or detaches, call `recover_session`.
7. Before concluding, call `export_debug_bundle`.

## Notes

- iPhone Chrome is still a WebKit target and should be debugged through this same bridge path.
- Use Chrome DevTools MCP only for desktop Chrome reproduction on the Mac.
