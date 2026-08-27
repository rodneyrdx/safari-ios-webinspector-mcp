# Real-Device Acceptance Matrix

Use one USB-connected iPhone with Safari Web Inspector enabled.

## Preconditions

- `check_environment` reports macOS and Safari availability
- `idevice_id`, `ideviceinfo`, `ios_webkit_debug_proxy`, and `safaridriver` are installed
- the iPhone is trusted by the Mac
- at least one tab is open on the device

## Scenarios

1. Safari attach
   - Run `start_bridge`, `list_devices`, `list_pages`, `attach_page`
   - Expected: a `sessionId` is returned with capability flags
2. Managed Safari launch
   - Run `launch_managed_page` with a trusted device id and a benign test URL
   - Expected: a `managed_page` session is returned with `backend=webdriver_managed`, working JS eval, DOM actions, and page screenshots
3. Managed Automation launch
   - Run `launch_automation_page` with a trusted device id and a benign test URL
   - Expected: a `managed_page` session is returned with `backend=automation_shim_managed`, working JS eval, DOM actions, and page screenshots
4. Chrome on iPhone attach
   - Open Chrome on the iPhone and repeat discovery
   - Expected: the page appears through the same WebKit bridge path
5. Runtime inspection
   - Run `evaluate_script`, `get_console_messages`, and `get_network_requests`
   - Expected: runtime eval works and buffered evidence is returned where supported by the backend
6. Page automation
   - Run `get_dom_snapshot`, `click_element`, `fill_element`, `press_key`, `navigate`, `go_back`, `go_forward`, `reload`, and `wait_for_text`
   - Expected: page interactions succeed or fail with structured `unsupported` results
7. Crash handling
   - Reproduce a page crash or use the current WebGL runbook
   - Expected: `get_crash_state` reports websocket and/or visible inspector crash state
8. Recovery
   - Run `recover_session`
   - Expected: attached websocket sessions attempt rediscovery first, then UI-based reload recovery; managed sessions return a structured relaunch recommendation
9. Raw Automation probe
   - Run `npm run probe:automation -- --udid <DEVICE_UDID>`
   - Expected: the shim can create and drive an isolated Automation browsing context, and the output states whether any existing Safari tab was adopted
10. Evidence export
   - Run `export_debug_bundle`
   - Expected: bundle directory contains session, console, network, crash, and screenshot evidence files

## Latest managed-session result

Validated on March 25, 2026 on the connected unlocked iPhone:

- `launch_managed_page` equivalent flow succeeded through `safaridriver`
- JS eval worked
- DOM snapshot worked
- click and fill helpers worked
- page screenshot capture worked
- `launch_automation_page` equivalent flow succeeded through the raw WebKit Automation backend
- JS eval worked
- page screenshot capture worked
- the created managed context was isolated from the already-open normal Safari tab

The remaining acceptance gap is existing-tab attach parity. The current iPhone/OS combination appears to expose isolated Automation contexts instead of adopting an already-open normal Safari tab.
