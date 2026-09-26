#!/usr/bin/env python3
"""Inspect and release locally quarantined attendance after operator repair."""

import argparse
import json

import database


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("list", help="Show active rejections and original evidence")
    retry = subcommands.add_parser("retry", help="Release a repaired event for sync")
    retry.add_argument("rejection_id", type=int)
    retry.add_argument("--note", required=True, help="Why this event is safe to retry")
    args = parser.parse_args()
    database.init_db()
    if args.command == "list":
        print(json.dumps(database.list_attendance_rejections(), indent=2))
    else:
        database.retry_attendance_rejection(args.rejection_id, args.note)
        print(f"Released rejection {args.rejection_id} for retry")


if __name__ == "__main__":
    main()
