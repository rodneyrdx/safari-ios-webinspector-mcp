# Research: iPhone `ios_webkit_debug_proxy` Target Broker Behavior

Date: 2026-03-25

## Why this exists

The first end-to-end device shakeout showed that live iPhone page sockets exposed by `ios_webkit_debug_proxy` did not behave like a direct page-domain websocket. This note captures the protocol findings, source-level research, and the resulting implementation direction.

## Live observations

Environment:

- macOS host with `libimobiledevice`
- `ios_webkit_debug_proxy`
- connected device: `00000000-0000000000000000`
- visible device name: `Test iPhone`

Discovery worked:

- `idevice_id -l` returned the connected phone
- `curl http://127.0.0.1:9221/` listed the device
- `curl http://127.0.0.1:9222/json/list` listed inspectable pages
- websocket endpoints at `ws://127.0.0.1:9222/devtools/page/<n>` accepted connections

Unexpected protocol behavior:

- immediately after connect, the socket emitted `Target.targetCreated`
- direct calls to these domains returned `-32601`:
  - `Runtime`
  - `Page`
  - `Console`
  - `Network`
  - `DOM`
  - `Debugger`
  - `Schema`
- direct `Target` commands behaved differently:
  - `Target.setPauseOnStart` returned `{ result: {} }`
  - `Target.resume` returned `Target for given targetId is not paused`
  - `Target.sendMessageToTarget` returned top-level `{ result: {} }`

Implication:

- the socket is not exposing a direct page-domain transport
- it is exposing a brokered `Target.*` transport
- nested page-domain messages may need to be wrapped inside `Target.sendMessageToTarget`

## Source research

### `ios-webkit-debug-proxy`

The upstream project was inspected to confirm whether the Target events were being synthesized locally.

Key conclusions from the source:

- `/devtools/page/<page_num>` is handled by `iwdp_on_devtools_request(...)`
- that starts a forwarded socket through `iwdp_start_devtools(...)`
- iwdp sends `_rpc_forwardSocketSetup`
- subsequent browser websocket frames are forwarded via `_rpc_forwardSocketData`
- device responses are forwarded back to the websocket through `_rpc_applicationSentData`

Conclusion:

- the `Target.targetCreated` frames are coming from the device-side inspector protocol, not fabricated by iwdp

### Appium remote debugger

`appium-remote-debugger` was inspected locally as a known consumer of modern WebKit inspector transports.

Relevant findings:

- it handles `Target.targetCreated`
- it handles `Target.dispatchMessageFromTarget`
- it wraps ordinary page-domain commands using `Target.sendMessageToTarget`
- it expects nested results to arrive later via `Target.dispatchMessageFromTarget`
- it treats some `Target.*` commands as direct broker commands
- it often uses `Runtime.evaluate` for navigation-like tasks on newer transports

Conclusion:

- the bridge needs to support both direct page-domain mode and brokered Target mode

## Current implementation direction

`ProtocolSession` now probes in this order:

1. direct page-domain mode
2. brokered Target mode when `Target.targetCreated` has been observed
3. broker-only downgrade when wrapped requests are acknowledged but nested page-domain responses never arrive

The capability contract now includes:

- `transportMode`: `direct | brokered | broker_only`
- `notes`: operator-facing protocol hints

Expected outcomes:

- `brokered`: page-domain requests are wrapped in `Target.sendMessageToTarget`
- `broker_only`: the bridge must stop pretending runtime/page automation exists and guide the operator toward evidence capture and UI recovery only

## Open questions

- whether the live device expects `pageProxyId` inside `Target.sendMessageToTarget`
- whether a different target id should be selected when both page and frame targets are present
- whether nested results are gated behind a pause/resume or attach flow not yet implemented
- whether the current page state (`Web Page Crashed`) suppresses nested dispatches that would otherwise appear on a healthy page

## Validation status

Confirmed on March 25, 2026 with `npm run shakeout` against healthy pages:

- non-crashed Safari pages now report `transportMode: broker_only`
- operator notes identify the page target and the failed broker probes
- the `Web Page Crashed` page still reports no usable runtime/page capabilities

That means the current bridge now meets the minimum acceptance bar for this protocol family:

- it no longer mislabels the page as fully automatable
- it degrades to recovery/evidence mode with explicit guidance

Additional trace validation on March 25, 2026 with `npm run trace:broker`:

- direct `Target.setPauseOnStart` succeeds with a top-level `{ result: {} }`
- wrapped `Target.sendMessageToTarget` calls also receive top-level `{ result: {} }`
- this remains true for:
  - page target
  - page target plus `pageProxyId`
  - frame target
  - frame target plus `pageProxyId`
  - Appium-style init sequence starting with `Inspector.enable`
- no `Target.dispatchMessageFromTarget` events were emitted for any wrapped request

Conclusion from the trace:

- the current iwdp websocket page endpoint is acting like an acknowledgement-only Target broker on this device/session
- the missing piece is not the order of wrapped page-domain commands
- full remote page driving will require either:
  - a different transport path than the iwdp page websocket, or
  - an additional device-side attach/setup sequence that is not exposed through the current socket behavior

## Next validation steps

1. Evaluate replacing the iwdp page-websocket transport with a direct Web Inspector plist transport, likely via `appium-remote-debugger` or equivalent libimobiledevice-level plumbing.
2. If staying on the current transport, investigate whether any non-page websocket or hidden setup channel emits the missing nested dispatches.
3. Keep the current `broker_only` downgrade path as the safe default until one of those transport changes proves otherwise.
