# Troubleshooting

## `dependency_missing`

Missing `idevice_id`, `ideviceinfo`, `ios_webkit_debug_proxy`, or `safaridriver`.

Fix:

```bash
brew install libimobiledevice ios-webkit-debug-proxy
```

`safaridriver` ships with Safari on macOS. If it exists but managed sessions still fail, run:

```bash
safaridriver --enable
```

## No devices returned

- Reconnect the phone
- Trust the Mac on the device
- Ensure Web Inspector is enabled on the phone
- Ensure Remote Automation is enabled if you want managed Safari sessions
- Confirm at least one mobile browser tab is open

Quick checks:

```bash
idevice_id -l
ios_webkit_debug_proxy
```

## Managed Safari session fails to start

- Make sure the iPhone is unlocked when the session is created
- Verify `Settings > Safari > Advanced > Remote Automation` is on
- If multiple iPhones are connected, pass the exact `deviceId` from `list_devices` or the direct UDID from `idevice_id -l`
- If Safari says remote automation is disabled, run `safaridriver --enable` on the Mac

## Raw Automation managed session fails to start

- Make sure the iPhone is unlocked
- Ensure the Appium Remote XPC tunnel registry is running on iOS 18+ devices
- Verify the Mac can see the tunnel registry through `check_environment.transportReadiness.remoteDebugger`
- Retry with `npm run probe:automation -- --udid <DEVICE_UDID>` to separate transport problems from MCP wiring

## Existing-tab attach stays on `iwdp_websocket`

On iOS 18+ devices, Appium attach requires the Remote XPC tunnel registry.

If `check_environment.transportReadiness.remoteDebugger` is false, start:

```bash
sudo node node_modules/appium-ios-remotexpc/scripts/tunnel-creation.mjs --udid <DEVICE_UDID> --keep-open
```

Then retry `attach_page`.

If the tunnel is already running but `remoteDebugger` still reports `false`, the registry port may only be visible in root's `@appium/strongbox` store because the tunnel was started with `sudo`. This repo now probes the live registry HTTP API and seeds the current user strongbox automatically when possible. If that still fails, confirm:

```bash
curl http://127.0.0.1:42314/remotexpc/tunnels
```

## Existing-tab attach fails fast with an Automation-domain limitation

That means the Appium shim connected, but Safari did not expose a normal selectable DevTools page target for the existing tab. On the connected iPhone this currently manifests as:

- a new `WIRTypeAutomation` page appears after an automation-session request
- that page accepts socket traffic
- classic domains like `Runtime`, `Page`, and `Target` are not available there

Current workaround:

- use `launch_managed_page` for reliable live control
- use `launch_automation_page` for a raw shim-backed managed session if you specifically want the WebKit Automation path
- use `npm run probe:automation -- --udid <DEVICE_UDID>` to verify whether the current device/OS exposes only isolated Automation contexts
- keep `attach_page` for discovery, crash evidence, and transport validation unless a future device/OS begins adopting existing tabs into the Automation session

## Bridge never becomes healthy

- Another process may already own ports `9221+`
- `ios_webkit_debug_proxy` may not have access to the trusted device
- The iPhone may not have any inspectable tabs open

## Page websocket closes unexpectedly

- The tab may have crashed
- The inspected page may have navigated away
- USB connectivity may have dropped

Run `get_crash_state` and then `recover_session`.

## UI fallback fails

The tool uses AppleScript and Accessibility APIs.

Grant permissions under:

- `System Settings > Privacy & Security > Accessibility`
- `System Settings > Privacy & Security > Automation`

## iPhone Chrome still crashes

That is expected for engine-level WebKit issues. iPhone Chrome does not avoid iOS WebKit limitations.

## iPhone Mirroring is available but not used

That is intentional for now. Apple documents iPhone Mirroring as a user-facing continuity feature, not a developer automation API. This project only considers it as a fallback aid for manual recovery, not as the primary browser-control transport.
