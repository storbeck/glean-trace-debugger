# Glean Trace Lens

An unpacked Chrome/Edge Manifest V3 extension for inspecting a saved Glean chat with `debugMode=1`.

## Install locally

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the `extension` folder in this repository.
4. Open a saved chat at `app.glean.com`, then click the Trace Lens toolbar button.

The extension opens a debugger window and a temporary inactive collector tab. It attaches to the collector before navigating to the chat's debug URL, captures supported network response bodies, and closes the collector when the capture finishes. It keeps recognized trace data in `chrome.storage.session` and does not send it to an external service.

## What is included

- Nested execution waterfall with server timings and parent/child structure.
- Search, trace/type filters, errors-only filter, expand/collapse, and zoom.
- Span inspector with Input, Output, Attributes, and Raw tabs.
- Local JSON import/export and a synthetic sample trace for UI exploration.
- Capture diagnostics showing response paths and recognized span counts.
- Redaction of common credential fields during capture/export.

## Current limits

This is an initial adapter for the payloads observed in the user's Glean tenant. The public Glean docs do not specify the debug trace endpoint or response contract, so the adapter is deliberately schema-tolerant and marks coverage as unverified. If a trace response is lazy-loaded only after selecting a Glean span, use **Open collector** while capturing and repeat the selection in Glean. A browser enterprise policy may block the `debugger` permission.

Run `npm test` and `npm run check` from the repository root before loading changes. The test suite covers capture ordering/cleanup, policy failures, worker recovery, URL handling, span normalization, timestamps, nesting, redaction, and import parsing.
