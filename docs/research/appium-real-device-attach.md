# Appium Real-Device Attach Research

## Summary

The current path for existing-tab attach on modern iPhones is Appium’s real-device remote debugger stack, not the old `ios_webkit_debug_proxy` page websocket.

Validated locally in this repo:

- `appium-remote-debugger` installed at `15.6.0`
- `appium-ios-remotexpc` installed at `0.41.0`
- `appium-ios-device` installed at `3.1.10`

## What the upstream Appium docs say

From the official `appium-remote-debugger` repository:

- the library is a Node.js frontend for the remote debugger protocol used to connect to iOS webviews and Safari
- the usage flow is to instantiate `RemoteDebugger`, then call `connect` and `selectApp`

From the official `appium-ios-remotexpc` repository:

- it provides Remote XPC communication and IPv6 tunneling for iOS devices
- tunnel creation uses TUN/TAP
- tunnel creation requires root / `sudo`
- the provided `tunnel-creation` script starts the tunnel registry HTTP API

## Local source-code findings

From the installed `appium-remote-debugger` package in this repo:

- `RemoteDebuggerRealDevice` now prefers the `WebInspector shim` path on iOS 18+
- if the shim startup fails, it falls back to the legacy Web Inspector implementation

From the installed `appium-ios-remotexpc` package in this repo:

- `Services.startWebInspectorService(udid)` requires a tunnel registry entry
- if no registry port exists, it throws:
  `Tunnel registry port not found. Please run the tunnel creation script first`

## Device-test result

Testing `appium-remote-debugger` and the Remote XPC shim against a USB-connected
iPhone established the following:

- the tunnel registry started through:
  `sudo node node_modules/appium-ios-remotexpc/scripts/tunnel-creation.mjs --udid <DEVICE_UDID> --keep-open`
- the non-root client also needed the registry port in the current user's
  `@appium/strongbox` store
- after that value was present, `Services.getAvailableDevices()` succeeded and
  the environment check reported `remoteDebugger=true`
- the Appium shim transport then connected successfully with `useWebInspectorShim=true`
- attached-page discovery worked and returned live Safari pages

What still fails:

- `RemoteDebugger.selectPage()` never completed for the existing Safari content tab
- the shim did not expose a normal selectable DevTools page target for that tab
- direct probing of the shim service showed Safari publishing `WIRTypeAutomation` pages after an automation-session request
- that automation page accepted socket traffic, but it did not expose classic DevTools domains like `Runtime`, `Page`, `Target`, or `Schema`
- it did expose the WebKit `Automation` domain, and `Automation.getBrowsingContexts` returned an empty `contexts` array on the attached session

Implication:

- existing-tab attach is no longer blocked only on the tunnel registry prerequisite
- the tunnel/bootstrap prerequisite can be satisfied by syncing the registry
  port into the current user's strongbox
- the remaining blocker is protocol-level: the iOS 26 shim is exposing an Automation-oriented surface for attached Safari tabs instead of the classic page-target flow that `appium-remote-debugger` expects
- the server should fail fast with an explicit limitation for this case instead of hanging indefinitely

## Raw Automation-session probe

To make the limitation reproducible, this repo now includes:

```bash
npm run probe:automation -- --udid <DEVICE_UDID>
```

What the live probe validated on the connected phone:

- `Automation.getBrowsingContexts` exists on the shim automation page
- before creating a context, it returned an empty `contexts` array
- `Automation.createBrowsingContext` succeeded and returned a new handle like `page-<UUID>`
- `Automation.navigateBrowsingContext` succeeded against that new handle
- `Automation.evaluateJavaScriptFunction` returned the page title from the newly created context
- `Automation.takeScreenshot` returned image data for that newly created context
- the already-open normal Safari content tab did not appear as an Automation browsing context

The probe stores its full response under the tool's local cache directory. Those
artifacts can contain local page metadata and are intentionally excluded from
the repository.

Follow-up managed-backend validation:

- the repo now exposes `launch_automation_page` as a first-class MCP tool backed by the raw Automation domain
- a live run created a separate managed browsing context
- navigation to `https://example.com/` succeeded
- JS evaluation returned `Example Domain`
- screenshot capture returned image data

This confirms the raw Automation path is viable as a managed-session backend. It does not change the existing-tab conclusion above.

Current conclusion:

- the shim Automation domain is usable for automation-created contexts
- it is not currently adopting the already-open normal Safari tab into that Automation session on this device
- this is why `attach_page` can connect to the Appium shim yet still fail fast for existing-tab control

This matches WebKit’s documented WebDriver model: Safari automation runs in special Automation windows isolated from normal browsing windows.

## Operational requirement

Before using the Appium existing-tab attach backend on this iPhone generation, start the tunnel registry and keep it running:

```bash
sudo node node_modules/appium-ios-remotexpc/scripts/tunnel-creation.mjs --udid <DEVICE_UDID> --keep-open
```

Tunnel startup requires an operator because the upstream script uses `sudo`.

After the tunnel starts, this repo now auto-probes the registry on `127.0.0.1` and seeds the current user strongbox when needed. That is Mac-local state only; it does not modify the phone.

## WebKit Automation protocol notes

The current iOS 26 shim behavior is consistent with WebKit's `Automation` protocol surface rather than classic Web Inspector page domains.

Observed through the tested shim:

- `Automation.getBrowsingContexts` exists
- `Runtime.evaluate` returns `'Runtime' domain was not found`
- `Page.enable` returns `'Page' domain was not found`
- `Target.exists` returns `'Target' domain was not found`
- `Schema.getDomains` returns `'Schema' domain was not found`

Relevant upstream protocol reference:

- WebKit Automation domain definition:
  https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/Automation/Automation.json

Relevant WebKit behavior reference:

- Safari WebDriver safeguard: automation execution is confined to special Automation windows isolated from normal browsing windows:
  https://webkit.org/blog/6900/webdriver-support-in-safari-10/

## Sources

- Appium remote debugger repo: https://github.com/appium/appium-remote-debugger
- Appium remote debugger README API note: https://github.com/appium/appium-remote-debugger
- Appium remote debugger releases showing `v15.6.0`: https://github.com/appium/appium-remote-debugger
- Appium Remote XPC repo: https://github.com/appium/appium-ios-remotexpc
- Appium Remote XPC README requirements and tunnel scripts: https://github.com/appium/appium-ios-remotexpc
- WebKit Automation protocol definition: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/Automation/Automation.json
- WebKit Safari WebDriver safeguards: https://webkit.org/blog/6900/webdriver-support-in-safari-10/
