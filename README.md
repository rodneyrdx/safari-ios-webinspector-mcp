# Safari iOS Web Inspector MCP

A TypeScript MCP server for inspecting iPhone Safari and Chrome WebKit sessions
from macOS.

## Implemented

- environment checks for macOS, Xcode, `libimobiledevice`,
  `ios_webkit_debug_proxy` and `safaridriver`
- device and page discovery
- iOS WebKit bridge lifecycle management
- managed Safari sessions through Apple `safaridriver`
- managed sessions through the raw WebKit `Automation` domain
- runtime evaluation, DOM snapshots and page actions where the selected backend
  exposes them
- console and network event buffering on compatible inspector sessions
- crash-state checks, reload attempts, screenshots and debug-bundle export

## Limits

- Existing Safari tabs can be discovered, but the tested iOS WebKit transport
  does not expose page-domain control for them. Those sessions report
  `transportMode: broker_only` instead of accepting automation commands.
- `safaridriver` and the raw `Automation` backend create separate automation
  contexts; they do not adopt an already-open normal Safari tab.
- Console and network streaming are not available on either managed backend.
- The server does not reset, restore, pair, update or otherwise control the
  iPhone outside the browser session.

The test suite contains 29 tests covering the protocol modes, managed sessions,
DOM tools, UI fallback, recovery and debug bundles.

## Install

```bash
npm install
npm run build
```

Run locally:

```bash
npm run dev
```

Use as an MCP server after building:

```toml
[mcp_servers.safari-ios-webinspector]
command = "node"
args = ["/absolute/path/to/dist/src/index.js"]
```

## Docs

- [docs/setup.md](docs/setup.md)
- [docs/operator-guide.md](docs/operator-guide.md)
- [docs/device-acceptance.md](docs/device-acceptance.md)
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [docs/tool-contracts.md](docs/tool-contracts.md)
- [docs/research/iwdp-target-broker.md](docs/research/iwdp-target-broker.md)
- [docs/research/iphone-mirroring.md](docs/research/iphone-mirroring.md)
- [docs/research/appium-real-device-attach.md](docs/research/appium-real-device-attach.md)

## Shakeout

Run a live-device shakeout against the connected iPhone:

```bash
npm run shakeout
```

Capture a raw broker trace against a healthy page:

```bash
npm run trace:broker
```

Probe the raw iPhone Automation shim directly:

```bash
npm run probe:automation -- --udid <DEVICE_UDID>
```

## Provenance and privacy

Device identifiers, local paths, captured pages, debug bundles, and customer or
application-specific material are not included. Research notes link to the
upstream code and documentation used during protocol investigation. Tests use
synthetic device data and `example.com` URLs.

## License

MIT. See [LICENSE](LICENSE). Third-party packages remain under their respective
licenses as declared in `package-lock.json` and their distributions.
