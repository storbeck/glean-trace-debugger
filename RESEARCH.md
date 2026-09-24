# Glean chat debugger extension: feasibility and design

Research date: 2026-09-23. Proposed target: Chrome/Edge Manifest V3, pending browser preference.

## Finding

Live inspection now confirms that adding `debugMode=1` to this tenant's saved chat exposes a historical span tree, tool inputs/outputs, original server timestamps, trace/span/parent identifiers, and model input/output views without rerunning the agent. Completeness across all spans, other chats, tenants, and retention windows remains unverified.

Treat the URL switch as observed application behavior, not a documented public API contract. Initial documentation research was followed by authenticated, user-guided inspection of a saved chat.

## Live inspection findings

The user changed the existing chat URL from a `qe` backend query parameter to `?debugMode=1`. The same completed answer remained and a detailed trace loaded. This establishes historical trace availability for this example; the extension should still preserve existing query parameters by default.

Observed run summary: 161.49 seconds and 1.83 credits. The span tree includes workflow wrappers, the agent loop, guardrails, tool discovery, a custom MCP action, Shell, model calls, and a learning operation.

Opening `Execute Action: search_orders` exposed Input, Output, and All Attributes. The output includes both text content and structured content. The attributes expose these useful paths beneath the literal `span.gle` key:

| Normalized field | Observed attribute path |
| --- | --- |
| Name | `span_info.span_name` |
| Start | `span_info.start_end_timestamps.start_time_millis` |
| End | `span_info.start_end_timestamps.end_time_millis` |
| Status | `span_info.execution_status.code` |
| Kind | `span_info.type` |
| Chat | `span_info.chat_session_id` |
| Trace ID | `context.agent_trace.trace_id` |
| Span ID | `context.agent_trace.span_id` |
| Parent ID | `context.agent_trace.parent_id` |
| Additional parent reference | `context.agent_trace.external_parent_id` |
| Workflow run | `context.workflow.run_id` |
| Tool name | `action.action_name` |
| Tool invocation | `action.action_run_id` |
| Tool input | `action.tool_call_arguments` |
| Tool output | `action.tool_call_result` |

The inspected tool timestamps are decimal strings; their difference is 74,606 ms, consistent with the displayed 74.61 seconds. Confirm the semantics of `parent_id` versus `external_parent_id` against the complete returned span set before choosing which edges to draw. Tool definition IDs and invocation IDs must remain separate.

The tool's `response_size_bytes` is 65,431. The JSON tree exposes truncated strings and a bounded accessibility representation, so scraping visible text alone is insufficient for reliable full-payload capture. Prefer underlying response data; per-section Copy controls are also present, but their completeness has not yet been tested.

Two existing toolbar views were verified:

- **Document → LLM call trace:** six selectable calls with Input and Output tabs. The first input is reported as 99,451 characters. Model output includes serialized event records; parse the observed encoding rather than assuming every nested string is one JSON object. Some reasoning content is encrypted; preserve it as opaque data, not readable reasoning.
- **Timeline icon → Execution timeline:** Dapper and Flame graph views, a time overview, nested span bars, and zoom/pan controls. Glean already draws the desired core waterfall for this chat.

The trace reports the custom tool execution at 74.61 seconds and the final main model call at 65.85 seconds. Model rows also expose input/output tokens, cache usage, reasoning token counts, model names, and credits. Avoid summing nested wrapper durations or nested credit totals, which would double-count work.

Still unverified: the network endpoint and response envelope, whether opening detail panels issues additional requests, full payload/export completeness, and background-tab behavior. UI inspection alone does not establish any of these.

## Verified sources

- [Glean: Debug your agent](https://docs.glean.com/agents/create-agents/debug-agent): Agent Builder Preview supports nested spans, execution times, model metadata, and step inputs/outputs. Some tools/steps omit details; Azure-hosted deployments are unsupported for this feature. This does not establish the behavior of the ordinary chat URL switch.
- [Glean: Retrieve a chat](https://developers.glean.com/api/client-api/chat/getchat): `POST /rest/api/v1/getchat` retrieves chat history.
- [Official Glean Client OpenAPI YAML](https://gleanwork.github.io/open-api/specs/final/client_rest.yaml), linked from the developer site's OpenAPI entry: `GetChatRequest` requires an `id`; `ChatMessageFragment` includes search suggestions and server tool request/response fields. `ChatMessage.messageType` includes `DEBUG` (internal use) and `DEBUG_EXTERNAL` (Action creation debugging). These are not a promise of historical trace export. The inspected specification contains no `debugMode`, `spanId`, or `parentSpan` field and no matching trace text. `ChatResponse.backendTimeMillis` is aggregate backend response time, not individual span timing. The documented `/chat` streaming format is newline-separated JSON; do not assume every Glean stream is SSE.
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger): extensions can attach to a tab and use the CDP Network domain, with the `debugger` permission. Enterprise policy may block attachment.
- [CDP Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/): response bodies and network events are available through protocol commands/events.
- [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs): a tab can be created inactive. Inactive means a background tab, not an invisible tab.
- [Chrome webRequest API](https://developer.chrome.com/docs/extensions/reference/api/webRequest): request/response metadata is available, but its response events do not provide response bodies. It is insufficient on its own for this capture.
- [CloudWatch observability viewer](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/view-observability-data-cloudwatch.html): sessions, traces, span timelines, and execution graphs provide the requested viewer reference.

## Proposed click flow

1. Capture the active Glean chat URL and source tab ID when the toolbar button is clicked. Validate the configured tenant origin and a saved chat identifier.
2. Open an extension-owned debugger window with a loading state.
3. Create an inactive `about:blank` collector tab in the same browser profile.
4. Register collection listeners, attach `chrome.debugger` to the collector, then enable `Network` before navigation. This order prevents missing startup trace requests.
5. Build the target with `new URL(sourceUrl)` and `url.searchParams.set('debugMode', '1')`, preserving existing query parameters and the fragment. Verify flag placement if Glean uses a hash router.
6. Navigate the collector to that URL. Let Glean's application use its existing authenticated browser session. Verify whether tab-local authentication state or a visibility requirement prevents background loading.
7. Capture relevant response bodies. If the application fetches trace details only when a message/debug panel/span is selected, reproduce those specific read-only UI interactions or observed read endpoints after inspecting their behavior.
8. Correlate payloads to the selected chat and each turn/run. Normalize the observed schema, retain relevant raw payloads locally, and render results progressively.
9. Finish only after the adapter establishes completion or reports partial capture. Detach and close the extension-created collector on success, cancellation, timeout, or failure.

The initial collector should observe responses; it should never regenerate the answer or rerun an agent just to populate an existing chat's trace.

## Capture implementation

Use a service worker for orchestration, an extension page for the viewer, and a Glean-specific adapter for decoding data. Keep adapter logic separate because undocumented application payloads may change.

For completed JSON/NDJSON requests, correlate `Network.responseReceived` and `Network.loadingFinished`, then call `Network.getResponseBody`; decode base64 when indicated. Handle bounded body buffers, retrieval errors, and oversized/truncated payloads explicitly. For long-lived SSE/WebSocket responses, use the corresponding message/frame events; for fetch-based streaming, verify the actual transport and supported incremental capture method before implementing it. Do not wait forever for a stream to finish.

Filter by the collector tab and observed tenant endpoints. Avoid collecting unrelated browsing traffic or persisting cookies/authorization headers. Store trace content in extension-local session storage or a bounded local database, never sync storage. Explicit exports should omit credentials and identify redactions/truncation. Render payloads as text/JSON rather than executable markup.

The first version can use `activeTab`, `debugger`, and `storage`; introduce narrowly scoped host/scripting permissions only if the selected capture approach needs them. `activeTab` access is tied to the clicked tab and must not be assumed to grant content-script injection into the new collector. Chrome may display its debugging indicator; this design is not fully invisible. Support detachment and enterprise-policy failures as explicit states.

After discovering the trace endpoint, assess whether a narrower authenticated read through the existing page can replace the temporary collector and debugger permission. Do not assume extension-origin requests inherit all application authentication behavior.

## Viewer data model

This is our proposed normalized schema, not Glean's verified wire format:

```ts
type CapturedSpan = {
  chatId: string;
  turnId?: string;
  traceId?: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'agent' | 'model' | 'tool' | 'retrieval' | 'other';
  startTimeMs?: number;
  endTimeMs?: number;
  status: 'ok' | 'error' | 'running' | 'unknown';
  input?: unknown;
  output?: unknown;
  attributes: Record<string, unknown>;
  timingSource: 'server' | 'unavailable';
  rawPayloadRef: string;
};
```

Keep browser capture timestamps separately. Fetching yesterday's trace today does not make today's HTTP request duration the duration of yesterday's model/tool execution. Missing timings remain unknown; do not fabricate a waterfall from message order. Missing input/output must be distinguished from an explicitly empty value. Keep opaque tracking tokens opaque unless an observed payload establishes their relationship to trace IDs.

Proposed UI: chat/turn selector, nested span tree aligned to a shared time axis, duration/status, and a selected-span panel with Input, Output, Attributes, and Raw JSON. Include search, errors-only filtering, expand/collapse, and local JSON import/export. Display model/token metadata only when exposed. Preserve parallel operations and group separate turns into separate runs.

## First live validation

Use one saved chat where the user can already open the debugger. Compare its ordinary and debug loads, then inspect one span's detail panel. Establish:

1. Which request returns the trace, its method, and the chat/turn/run identifiers it accepts.
2. Whether old chat turns have retained traces or debugging must have been enabled at execution time.
3. Whether responses contain IDs, parent relationships, server timestamps, status, input, and output.
4. Whether span details are lazy-loaded, paginated, redacted, or unavailable by permission.
5. Whether the feature works in a background tab using the existing session.
6. Whether the captured count and details match Glean's viewer for that run.

If all required data is returned, implement the adapter and waterfall. If Glean returns only chat messages or progress updates, provide a clearly labeled event/transcript view and report the trace limitation. A complete server waterfall cannot be reconstructed from browser HTTP timings alone.
