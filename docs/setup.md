# Setup

## Scope

This tool is macOS-only. It lets an MCP client inspect or automate iPhone Safari and iPhone Chrome sessions through Safari Web Inspector.

Safety boundary:

- browser automation only
- no Settings automation beyond Apple-documented Safari prerequisites
- no reset, restore, erase, pairing mutation, or firmware actions

## Prerequisites

- macOS with Safari installed
- Xcode installed
- Node.js 20+
- Homebrew-installed iOS inspection tooling:
  - `libimobiledevice`
  - `ios-webkit-debug-proxy`
- Apple `safaridriver` available on the Mac
- for Appium existing-tab attach on iOS 18+ devices:
  - `appium-remote-debugger`
  - `appium-ios-remotexpc`

Suggested install:

```bash
brew install libimobiledevice ios-webkit-debug-proxy
```

## Device setup

1. Connect the iPhone to the Mac over USB.
2. Trust the Mac on the phone.
3. Enable `Settings > Safari > Advanced > Web Inspector`.
4. Enable `Settings > Safari > Advanced > Remote Automation` if you want managed Safari sessions.
5. Open at least one browser tab on the phone.

On the Mac, enable Safari Remote Automation once:

```bash
safaridriver --enable
```

## Local project setup

```bash
npm install
npm run build
```

## MCP registration for Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.safari-ios-webinspector]
command = "node"
args = ["/absolute/path/to/dist/src/index.js"]
```

## Validation

Run the MCP server and verify prerequisites:

```bash
npm run dev
```

Then call `check_environment` from the MCP client.

If `check_environment.transportReadiness.remoteDebugger` is `false` on an iOS 18+ device, start the Appium tunnel registry first:

```bash
sudo node node_modules/appium-ios-remotexpc/scripts/tunnel-creation.mjs --udid <DEVICE_UDID> --keep-open
```

The tunnel script writes its registry port into `@appium/strongbox`. When it is started with `sudo`, that port may only be visible to root. This repo now auto-probes the live registry API on localhost and syncs the discovered port into the current user strongbox when possible, so `check_environment` can turn `remoteDebugger` ready without touching the phone.

If you need to validate the iOS shim behavior directly, run:

```bash
npm run probe:automation -- --udid <DEVICE_UDID>
```

This is browser-only. It requests a Safari automation session and creates an isolated Automation browsing context for transport validation.

To launch a full managed Automation session through MCP after the server is running, use:

- `launch_automation_page` for the raw WebKit Automation backend
- `launch_managed_page` for Apple `safaridriver`

`check_environment` now reports:

- `transportReadiness.iwdpEvidence`
- `transportReadiness.webdriver`
- `transportReadiness.remoteDebugger`
- `transportReadiness.iphoneMirroring`
- `safeMode.browserOnly`

## References

- Safari/WebKit inspection enablement: https://webkit.org/web-inspector/enabling-web-inspector/
- Safari WebDriver on iOS: https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/
- iOS bridge tooling: https://github.com/google/ios-webkit-debug-proxy
- iPhone Mirroring support: https://support.apple.com/en-gb/guide/iphone/iph505911a40/ios
