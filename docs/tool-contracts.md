# Tool Contracts

All tools return JSON text payloads.

## Common error shape

```json
{
  "ok": false,
  "code": "dependency_missing",
  "message": "Human-readable explanation",
  "details": {}
}
```

## Tool summary

- `check_environment`: returns local dependency and device readiness
- `start_bridge`: starts or reuses `ios_webkit_debug_proxy`
- `stop_bridge`: stops the bridge process
- `list_devices`: returns bridge-visible iPhone devices
- `list_pages`: returns inspectable tabs for one device
- `attach_page`: creates a live session and returns capabilities
- `launch_managed_page`: launches a fresh iPhone Safari automation window through `safaridriver`; accepts either a bridge `deviceId` or a direct trusted UDID
- `launch_automation_page`: launches a fresh iPhone Safari automation window through the raw WebInspector `Automation` domain; accepts either a bridge `deviceId` or a direct trusted UDID
- `detach_page`: closes a session
- `get_session_state`: lists active session summaries
- `evaluate_script`: executes JS in page context
- `get_console_messages`: returns buffered console entries
- `get_network_requests`: returns buffered network events
- `get_dom_snapshot`: returns snapshot nodes with `ref`
- `click_element`, `fill_element`, `press_key`: page-level automation
- `navigate`, `go_back`, `go_forward`, `reload`, `wait_for_text`: navigation and wait helpers
- `take_screenshot`: session screenshot when the backend supports it, otherwise host-side evidence
- `get_crash_state`: combined websocket + visible Safari crash state
- `recover_session`: protocol reconnect and UI fallback reload attempt; on success, the existing `sessionId` is rebound to a fresh websocket
- `export_debug_bundle`: writes evidence files under the cache bundle root

## Capability flags

- `backend`: `iwdp_websocket`, `webdriver_managed`, `automation_shim_managed`, `remote_debugger_attached`, or `ui_fallback`
- `runtimeEval`
- `console`
- `network`
- `domSnapshot`
- `domActions`
- `screenshot`
- `uiRecovery`
- `transportMode`: `direct`, `brokered`, or `broker_only`
- `notes`: operator-facing protocol hints and downgrade reasons

Use capability flags to decide whether a tool should be attempted or treated as unavailable.

`sessionKind` is returned with each session and is one of:

- `attached_page`
- `managed_page`

`broker_only` means the page websocket exposed `Target` broker events but did not yield nested page-domain responses during probing. In that state, runtime/page automation tools should be treated as unavailable and the operator should rely on crash capture, recovery, and UI fallback tools.

`webdriver_managed` means the session was created through Apple `safaridriver`. In that state:

- runtime evaluation and DOM actions are expected to work
- console and network streaming are intentionally unavailable in the current implementation
- the session is isolated from the user’s normal Safari tabs

`automation_shim_managed` means the session was created through the raw WebKit `Automation` domain over the Appium/WebInspector shim. In that state:

- runtime evaluation and DOM actions are expected to work
- screenshots are expected to work
- console and network streaming are intentionally unavailable in the current implementation
- the session is isolated from the user’s normal Safari tabs, matching WebKit’s documented automation-window model

`remote_debugger_attached` means the session was attached to an existing Safari tab through Appium’s real-device remote debugger stack. On iOS 18+ devices this backend requires the Appium Remote XPC tunnel registry to be reachable from the current user context; this repo now auto-probes the local registry API and syncs the discovered port into the current user strongbox when needed.

Observed limitation on the tested device:

- the shim can enumerate attached Safari tabs
- some tabs currently expose an Automation-oriented shim surface instead of a normal selectable DevTools page target
- the raw shim Automation domain can create and drive a new Automation browsing context
- that Automation browsing context does not currently adopt the already-open normal Safari tab on this device
- in that case `attach_page` fails with an explicit `unsupported` limitation rather than hanging forever
