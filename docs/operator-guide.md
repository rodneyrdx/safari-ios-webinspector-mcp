# Operator Guide

## Typical workflow

1. Run `check_environment`
2. Decide the session type:
   - existing tab: if `remoteDebugger` readiness is false on iOS 18+, start the Appium tunnel registry first, then run `start_bridge`, `list_devices`, `list_pages`, `attach_page`
   - fresh managed Safari window via Apple WebDriver: `launch_managed_page`
   - fresh managed Safari window via raw WebKit Automation: `launch_automation_page`
3. Use capability flags before attempting runtime, console, network, or DOM tools
4. Use `get_dom_snapshot`, `click_element`, `fill_element`, `press_key`, `navigate`, `go_back`, `go_forward`, `reload`, and `wait_for_text` as supported
5. If the page crashes, run `get_crash_state`, then `recover_session`
6. Run `export_debug_bundle` before ending the session

## Session guidance

- `attach_page` returns `sessionId`, page metadata, and capability flags.
- `launch_managed_page` starts a fresh Safari automation window on the iPhone using Apple `safaridriver`.
- `launch_automation_page` starts a fresh isolated Safari automation window on the iPhone using the raw WebInspector `Automation` domain.
- `launch_managed_page` accepts either the bridge `deviceId` from `list_devices` or the direct trusted UDID from `idevice_id -l`.
- `launch_automation_page` accepts the same device identifiers as `launch_managed_page`.
- `sessionKind` distinguishes `attached_page` from `managed_page`.
- `capabilities.backend` distinguishes `iwdp_websocket`, `webdriver_managed`, and `automation_shim_managed`.
- existing-tab attach now prefers `remote_debugger_attached` when the Appium transport is ready and falls back to `iwdp_websocket` otherwise.
- if `attach_page` fails quickly with an Appium shim `unsupported` limitation, the transport connected but the live Safari tab exposed an isolated Automation-only shim surface rather than a selectable DevTools page target.
- raw validation is available with `npm run probe:automation -- --udid <DEVICE_UDID>`. This creates a fresh Automation browsing context and confirms whether the shim is adopting existing tabs on the current device/OS combination.
- Treat DOM refs from `get_dom_snapshot` as temporary. They expire after navigation or reload.
- iPhone Chrome still appears through the WebKit/Safari inspection path because iOS browsers use WebKit.
- Managed Safari sessions are isolated from the user’s normal tabs by Safari/WebDriver and intentionally start from a clean slate.

## Recovery guidance

If a page crashes:

1. Call `get_crash_state`
2. If the websocket is closed or Safari shows `Web Page Crashed`, call `recover_session`
3. On success, continue using the same `sessionId`; the tool now rebinds it to the recovered page websocket
4. If recovery fails, reload the page on the device and re-run discovery

Managed-session note:

- `recover_session` does not try to rebind a crashed managed Safari automation window.
- Relaunch the managed session instead.

## Evidence capture

- `take_screenshot` captures a page screenshot for managed WebDriver sessions, raw Automation managed sessions, and host-side evidence for websocket sessions.
- `export_debug_bundle` writes JSON evidence and any screenshot to the local cache bundle directory.
