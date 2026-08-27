# iPhone Mirroring Research

Date: 2026-03-25

## Question

Could Apple’s iPhone Mirroring feature help this project fully remote-drive iPhone Safari from Codex?

## Short answer

Not as the primary transport.

Apple documents iPhone Mirroring as a user-facing Continuity feature for controlling a nearby iPhone from a Mac. The published docs describe click, swipe, scroll, keyboard input, Home, and App Switcher behavior, but they do not describe a developer automation API, remote debugging protocol, or programmatic control surface comparable to WebDriver or Web Inspector.

Conclusion:

- iPhone Mirroring is useful as a manual or UI-fallback aid.
- It is not a documented replacement for Safari WebDriver or Web Inspector transport.
- This repo should keep it as optional recovery/fallback only.

## What Apple documents

Apple’s iPhone user guide says iPhone Mirroring lets you control the iPhone from a nearby Mac and explicitly describes:

- click to tap
- swipe and scroll
- keyboard typing
- opening the App Switcher
- going to the Home Screen

Apple also documents the operating requirements:

- same Apple Account on both devices
- Wi-Fi and Bluetooth enabled
- within 30 feet / 10 meters
- iPhone with iOS 18 or later
- Mac with macOS Sequoia or later

Apple’s support page also notes:

- the iPhone must be nearby and turned on
- the iPhone screen must be locked when using iPhone Mirroring
- some features like camera and microphone are not compatible with Mirroring
- iPhone Mirroring is not currently available in the European Union

## What Apple does not document

The public Apple support material reviewed for this project does not document:

- a command-line interface for iPhone Mirroring
- an automation API for iPhone Mirroring
- an MCP- or DevTools-style protocol
- a browser inspection or JavaScript execution surface
- a way to attach to an existing Safari tab as a debuggable page target

Because of that, iPhone Mirroring does not solve the core transport gap found in the current `ios_webkit_debug_proxy` websocket path.

## Impact on this repo

Keep iPhone Mirroring out of the core transport plan.

Allowed use:

- environment detection
- operator guidance
- optional manual recovery fallback if Safari/Web Inspector is visibly stuck

Disallowed use as a design assumption:

- primary session control transport
- existing-tab JavaScript execution backend
- console/network inspection backend

## Sources

- Apple Support, “Control your iPhone from your Mac”: https://support.apple.com/en-gb/guide/iphone/iph505911a40/ios
- Apple Support, “iPhone Mirroring”: https://support.apple.com/en-my/120421
