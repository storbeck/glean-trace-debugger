# glean-trace-debugger

A small script to fetch a Glean conversation, including its workflow/step trace
metadata, as JSON.

`fetch_trace.py` calls Glean's `getchat` endpoint and prints the raw JSON
response to stdout. Each message includes trace fields such as
`workflowTraceId`, `workflowId`, `stepId`/`stepRunId`, `agentTraceInfo`, and
`stepStatusEvent`.

## Requirements

- Python 3.9+ (standard library only)
- The [`glean` CLI](https://developers.glean.com), authenticated:

  ```sh
  glean auth login
  ```

The CLI handles authentication; this script never touches your token.

## Usage

Pass the 32-character conversation ID from a Glean chat URL
(`app.glean.com/chat/<id>`):

```sh
python3 fetch_trace.py <chat_id>              # print to stdout
python3 fetch_trace.py <chat_id> > trace.json # save to a file
python3 fetch_trace.py <chat_id> | jq .       # pipe elsewhere
```

Errors go to stderr with a non-zero exit code, so a redirect won't capture an
error as if it were data.

## Use as a module

`fetch_trace()` returns the parsed JSON as a dict:

```python
from fetch_trace import fetch_trace

data = fetch_trace("47ec770daf214bf6b3345b9414b98e1e")
messages = data["chatResult"]["chat"]["messages"]
```

It raises `ValueError` for a malformed ID and `RuntimeError` if the `glean`
CLI is missing, the call fails, or the response is unexpected.
