#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DICT_FILE = ROOT / "resources" / "ship_dict_from_install_dates.json"
STATE_FILE = ROOT / "resources" / "character" / "equip-build-state.json"
NODE_SCRIPT = ROOT / "tools" / "build-ship-equip-cache.js"


def load_json(path: Path, default):
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def archive_and_reset_state_file():
    if STATE_FILE.exists():
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = STATE_FILE.with_name(f"old_equip-build-state_{timestamp}.json")
        STATE_FILE.replace(backup)
        print(f"[build-all-ship-equip] 已归档旧状态文件到: {backup}")

    payload = {
        "version": 1,
        "completed": [],
        "failed": {},
        "updated_at": ""
    }
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def get_pending_items():
    ship_dict = load_json(DICT_FILE, {})
    entries = ship_dict.get("entries", [])
    entries = [entry for entry in entries if str(entry.get("ship_id", "")).strip()]

    state = load_json(STATE_FILE, {"completed": [], "failed": {}})
    completed = set(state.get("completed", []))
    failed = state.get("failed", {})
    failed_names = {name for name, reason in failed.items() if reason and name not in completed}

    retry_items = []
    fresh_items = []

    for entry in entries:
      name = entry.get("original_name")
      if name in completed:
        continue
      if name in failed_names:
        retry_items.append(entry)
      else:
        fresh_items.append(entry)

    return {
      "retry": retry_items,
      "fresh": fresh_items,
      "all": retry_items + fresh_items
    }


def run_batch(batch, delay_ms: int, retries: int, retry_delay_ms: int, force: bool):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as tmp:
        json.dump([item["original_name"] for item in batch], tmp, ensure_ascii=False, indent=2)
        tmp_path = Path(tmp.name)

    try:
        cmd = [
            "node",
            str(NODE_SCRIPT),
            f"--only-file={tmp_path}",
            f"--delay-ms={delay_ms}",
            f"--retries={retries}",
            f"--retry-delay-ms={retry_delay_ms}"
        ]
        if force:
            cmd.append("--force")

        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        print(f"[build-all-ship-equip] 启动批次: {len(batch)} 条")
        result = subprocess.run(cmd, cwd=ROOT, check=False, env=env)
        return result.returncode
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="批量构建舰船配装缓存，分批调用 Node 构建器并利用 equip-build-state.json 续跑。")
    parser.add_argument("--batch-size", type=int, default=20, help="每批处理多少件舰船，默认 20")
    parser.add_argument("--delay-ms", type=int, default=5000, help="每个舰船页面抓取后的等待毫秒数，默认 5000")
    parser.add_argument("--retries", type=int, default=4, help="单个舰船抓取重试次数，默认 4")
    parser.add_argument("--retry-delay-ms", type=int, default=2500, help="抓取失败后的重试基础等待时间，默认 2500")
    parser.add_argument("--max-batches", type=int, default=0, help="最多跑多少个批次，0 表示跑到结束")
    parser.add_argument("--force", action="store_true", help="重置舰船配装状态并强制重抓")
    args = parser.parse_args()

    if args.force:
        archive_and_reset_state_file()
        print("[build-all-ship-equip] 已创建全新舰船配装抓取状态，将从头覆盖旧数据。")

    batch_count = 0

    while True:
        pending_info = get_pending_items()
        pending = pending_info["all"]
        if not pending:
            print("[build-all-ship-equip] 没有待处理舰船配装，任务完成。")
            return 0

        batch = pending[:args.batch_size]
        batch_count += 1
        print(
            f"[build-all-ship-equip] 第 {batch_count} 批，待处理总数 {len(pending)}，"
            f"失败待重试 {len(pending_info['retry'])}，"
            f"全新待处理 {len(pending_info['fresh'])}，"
            f"本批 {len(batch)}"
        )

        code = run_batch(batch, args.delay_ms, args.retries, args.retry_delay_ms, args.force)
        if code != 0:
            print(f"[build-all-ship-equip] 批次执行失败，退出码 {code}")
            return code

        if args.max_batches > 0 and batch_count >= args.max_batches:
            print("[build-all-ship-equip] 已达到 max-batches，停止。")
            return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
