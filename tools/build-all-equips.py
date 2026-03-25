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
INDEX_FILE = ROOT / "resources" / "equip" / "装备图鉴_装备基础属性.json"
STATE_FILE = ROOT / "resources" / "equip" / "build-state.json"
NODE_SCRIPT = ROOT / "tools" / "build-equip-cache.js"


def load_json(path: Path, default):
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def archive_and_reset_state_file():
    if STATE_FILE.exists():
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = STATE_FILE.with_name(f"old_build-state_{timestamp}.json")
        STATE_FILE.replace(backup)
        print(f"[build-all-equip] 已归档旧状态文件到: {backup}")

    payload = {
        "version": 1,
        "completed": [],
        "failed": {},
        "updated_at": ""
    }
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def get_pending_items():
    equip_index = load_json(INDEX_FILE, [])
    state = load_json(STATE_FILE, {"completed": [], "failed": {}})
    completed = set(state.get("completed", []))
    failed = state.get("failed", {})
    failed_names = {
        name for name, reason in failed.items()
        if reason and name not in completed
    }

    retry_items = []
    fresh_items = []

    for item in equip_index:
        full_name = item.get("full_name")
        if full_name in completed:
            continue
        if full_name in failed_names:
            retry_items.append(item)
        else:
            fresh_items.append(item)

    return {
        "retry": retry_items,
        "fresh": fresh_items,
        "all": retry_items + fresh_items
    }


def run_batch(batch, delay_ms: int, force: bool):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as tmp:
        json.dump([item["full_name"] for item in batch], tmp, ensure_ascii=False, indent=2)
        tmp_path = Path(tmp.name)

    try:
        cmd = [
            "node",
            str(NODE_SCRIPT),
            f"--only-file={tmp_path}",
            f"--delay-ms={delay_ms}"
        ]
        if force:
            cmd.append("--force")

        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"

        print(f"[build-all-equip] 启动批次: {len(batch)} 条")
        result = subprocess.run(cmd, cwd=ROOT, check=False, env=env)
        return result.returncode
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="批量构建装备缓存，分批调用 Node 构建器并利用 build-state.json 续跑。")
    parser.add_argument("--batch-size", type=int, default=20, help="每批处理多少件装备，默认 20")
    parser.add_argument("--delay-ms", type=int, default=5000, help="每个装备页面抓取后的等待毫秒数，默认 5000")
    parser.add_argument("--max-batches", type=int, default=0, help="最多跑多少个批次，0 表示跑到结束")
    parser.add_argument("--force", action="store_true", help="忽略 build-state.json，强制重抓")
    args = parser.parse_args()

    if args.force:
        archive_and_reset_state_file()
        print("[build-all-equip] 已创建全新装备抓取状态，将从头覆盖旧数据。")

    batch_count = 0

    while True:
        pending_info = get_pending_items()
        pending = pending_info["all"]
        if not pending:
            print("[build-all-equip] 没有待处理装备，任务完成。")
            return 0

        batch = pending[:args.batch_size]
        batch_count += 1
        print(
            f"[build-all-equip] 第 {batch_count} 批，待处理总数 {len(pending)}，"
            f"失败待重试 {len(pending_info['retry'])}，"
            f"全新待处理 {len(pending_info['fresh'])}，"
            f"本批 {len(batch)}"
        )

        code = run_batch(batch, delay_ms=args.delay_ms, force=args.force)
        if code != 0:
            print(f"[build-all-equip] 批次执行失败，退出码 {code}")
            return code

        if args.max_batches > 0 and batch_count >= args.max_batches:
            print("[build-all-equip] 已达到 max-batches，停止。")
            return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
