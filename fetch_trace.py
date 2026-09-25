import argparse
import json
import re
import shutil
import subprocess
import sys


def fetch_trace(chat_id: str) -> dict:
    """Fetch a Glean conversation trace and return it as a dict.

    Authentication is handled by the `glean` CLI. Raises ValueError for a
    malformed ID and RuntimeError if the CLI is missing, the call fails, or
    the response is unexpected.
    """
    if not re.fullmatch(r"[a-fA-F0-9]{32}", chat_id):
        raise ValueError("Expected a 32-character hexadecimal conversation ID.")

    if shutil.which("glean") is None:
        raise RuntimeError(
            "The 'glean' CLI was not found on your PATH. Install it and run "
            "'glean auth login' first."
        )

    # Let the Glean CLI carry authentication. No token is ever handled,
    # stored, or printed by this script.
    result = subprocess.run(
        [
            "glean", "api", "getchat",
            "--method", "POST",
            "--raw-field", json.dumps({"id": chat_id}),
            "--raw", "--no-color",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        stderr = result.stderr.strip() or "unknown error"
        raise RuntimeError(
            f"'glean api getchat' failed: {stderr}\n"
            "If this is an auth problem, run 'glean auth login' and retry."
        )

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(
            "Could not parse the CLI response as JSON. Run the same command "
            "with 'glean api getchat ...' to inspect the raw output."
        ) from None

    chat = data.get("chatResult", {}).get("chat", {})

    if chat.get("id") != chat_id:
        raise RuntimeError(
            "The response did not contain the requested conversation."
        )

    return data


def main():
    parser = argparse.ArgumentParser(
        description="Fetch the full trace of an authorized Glean conversation "
        "(messages plus workflow/step trace metadata) as JSON on stdout, using "
        "the glean CLI for authentication.",
    )

    parser.add_argument(
        "chat_id",
        help="Conversation ID from the Glean chat URL",
    )

    args = parser.parse_args()

    try:
        data = fetch_trace(args.chat_id)
    except (ValueError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    # The CLI entry point prints to stdout so it can be redirected to a file.
    json.dump(data, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
