# Safari iOS Web Inspector MCP

A macOS-only MCP server for inspecting and automating iPhone Safari and iPhone Chrome sessions through Safari Web Inspector.

## Status

This repo contains a working first implementation of:

- environment checks for macOS, Xcode, `idevice_id`, and `ios_webkit_debug_proxy`
- trusted-device enrichment with physical UDIDs and iOS versions from `libimobiledevice`
- iOS WebKit bridge lifecycle management
- device and page discovery through `ios_webkit_debug_proxy`
- managed iPhone Safari sessions through Apple `safaridriver`
- managed iPhone Safari sessions through the raw WebKit `Automation` domain
- protocol-backed runtime evaluation, console capture, and network event buffering
- DOM snapshotting and page-level automation through runtime-injected JavaScript
- Safari/Web Inspector UI fallback for crash detection, reload attempts, and screenshots
- debug bundle export

Current limitation:

- The bridge is protocol-first and pragmatic. It normalizes several WebKit event shapes, but iOS/WebKit protocol differences can still reduce available capabilities per page.
- On the currently attached real iPhone, healthy Safari pages downgrade to `transportMode: broker_only`, so runtime/page automation is intentionally disabled and the server falls back to evidence/recovery workflows.
- The new managed `safaridriver` path gives safe browser-only automation in a fresh Safari automation window, but it does not yet attach to an existing live Safari tab.
- The new `launch_automation_page` path also gives safe browser-only automation in a fresh isolated Automation context, but like Safari WebDriver it does not adopt an existing normal Safari tab.
- Console and network streaming are still unavailable on the `safaridriver` managed backend.
- Console and network streaming are also unavailable on the raw Automation managed backend.

Safety boundary:

- this project is browser-only by design
- no reset, restore, pairing mutation, firmware, or general iPhone system automation is in scope

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

This public repository contains an independently authored implementation built
against documented WebKit behavior and the public interfaces of its declared
dependencies. Research notes link to the upstream projects and documentation
that informed protocol investigation.

Device identifiers, local paths, captured pages, debug bundles, and customer or
application-specific material are not included. Tests use synthetic device data
and `example.com` URLs.

## License

MIT. See [LICENSE](LICENSE). Third-party packages remain under their respective
licenses as declared in `package-lock.json` and their distributions.
