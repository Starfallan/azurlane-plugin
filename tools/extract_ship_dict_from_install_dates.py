#!/usr/bin/env python3
"""
从实装日期 HTML 中提取舰船字典，匹配立绘目录，并将立绘复制到 resources/character。
- 已有数据（resources/ship_dict_from_install_dates.json）会被保留，只追加新条目。
- META 舰船（如 易北·META）会转换为内部代号 alter 进行拼音匹配（yibei_alter）。
"""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from pathlib import Path

# ── 路径常量 ──────────────────────────────────────────────

TOOLS_DIR = Path(__file__).resolve().parent
ROOT_DIR = TOOLS_DIR.parent
BUILD_DATA_DIR = TOOLS_DIR / "build_ship_data"

DEFAULT_HTML = TOOLS_DIR / "实装日期.html"
DEFAULT_FINAL_DIR = Path(r"E:\GameTool\AzurlanePaintingTool-v1.0.0\paint\final")
DEFAULT_JSON = ROOT_DIR / "resources" / "ship_dict_from_install_dates.json"
CHARACTER_DIR = ROOT_DIR / "resources" / "character"

DEFAULT_EXTRACT_FAILURES = BUILD_DATA_DIR / "ship_extract_failures.txt"
DEFAULT_MATCHED = BUILD_DATA_DIR / "ship_match_success.txt"
DEFAULT_UNMATCHED = BUILD_DATA_DIR / "ship_unmatched_from_html.txt"

# ── 正则 ──────────────────────────────────────────────────

TR_PATTERN = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
TD_PATTERN = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
TAG_PATTERN = re.compile(r"<[^>]+>")
PAREN_PATTERN = re.compile(r"\([^)]*\)|（[^）]*）")
META_SUFFIX_RE = re.compile(r"\s*[·・.]\s*META\s*$", re.IGNORECASE)

# ── 拼音 ──────────────────────────────────────────────────

try:
    from pypinyin import lazy_pinyin as _lazy_pinyin  # type: ignore
except ImportError:  # pragma: no cover
    _lazy_pinyin = None


@dataclass
class ShipEntry:
    ship_id: str
    original_name: str
    alias_name: str
    release_date: str
    pinyin_name: str
    matched_internal_name: str
    match_method: str
    match_score: float


@dataclass
class ExtractFailure:
    row_index: int
    ship_id_raw: str
    detail: str


# ── 工具函数 ──────────────────────────────────────────────


def strip_tags(text: str) -> str:
    cleaned = TAG_PATTERN.sub("", text)
    return html.unescape(cleaned).replace("\xa0", " ").strip()


def normalize_key(text: str) -> str:
    return re.sub(r"[^0-9a-z]+", "", text.lower())


def clean_name_for_pinyin(text: str) -> str:
    """清理舰船名称用于拼音转换，去除 META 后缀和括号内容。"""
    text = META_SUFFIX_RE.sub("", text)
    text = PAREN_PATTERN.sub("", text)
    text = text.replace("·", "").replace("・", "")
    return text.strip()


def is_meta_ship(name: str) -> bool:
    return bool(META_SUFFIX_RE.search(name))


# ── HTML 解析 ─────────────────────────────────────────────


def parse_ship_rows(path: Path) -> tuple[list[dict[str, str]], list[ExtractFailure], int]:
    content = path.read_text(encoding="utf-8", errors="ignore")
    rows: list[dict[str, str]] = []
    failures: list[ExtractFailure] = []
    valid_tr_count = 0

    for row_index, tr_html in enumerate(TR_PATTERN.findall(content), start=1):
        tds = TD_PATTERN.findall(tr_html)
        if len(tds) != 3:
            continue
        valid_tr_count += 1

        ship_id = strip_tags(tds[0])
        name_td = tds[1]
        release_date = strip_tags(tds[2])

        title_matches = re.findall(r'<a [^>]*title="([^"]+)"', name_td)
        alias_match = re.search(r'<span class="AF">(.*?)</span>', name_td, re.S)

        if not title_matches:
            failures.append(ExtractFailure(row_index, ship_id, "缺少 title 原名"))
            continue
        if not release_date:
            failures.append(ExtractFailure(row_index, ship_id, "缺少实装日期"))
            continue

        original_name = html.unescape(title_matches[0]).strip()
        alias_name = strip_tags(alias_match.group(1)) if alias_match else original_name

        rows.append({
            "ship_id": ship_id,
            "original_name": original_name,
            "alias_name": "" if alias_name == original_name else alias_name,
            "release_date": release_date,
        })

    return rows, failures, valid_tr_count


# ── 拼音匹配 ──────────────────────────────────────────────


def batch_to_pinyin(names: list[str]) -> dict[str, str]:
    unique_names = list(dict.fromkeys(
        clean_name_for_pinyin(name) for name in names if clean_name_for_pinyin(name)
    ))
    if not unique_names:
        return {}

    if _lazy_pinyin is not None:
        return {name: normalize_key("".join(_lazy_pinyin(name))) for name in unique_names}

    helper = (
        "import json,sys;"
        "from pypinyin import lazy_pinyin;"
        "names=json.load(sys.stdin);"
        "result={name: ''.join(lazy_pinyin(name)) for name in names};"
        "json.dump(result, sys.stdout, ensure_ascii=True)"
    )
    try:
        completed = subprocess.run(
            ["pixi", "exec", "--spec", "pypinyin", "python", "-X", "utf8", "-c", helper],
            input=json.dumps(unique_names, ensure_ascii=True),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if completed.returncode == 0 and completed.stdout.strip():
            raw = json.loads(completed.stdout)
            return {name: normalize_key(raw.get(name, "")) for name in unique_names}
    except Exception:
        pass

    return {name: normalize_key(name) for name in unique_names}


# ── 立绘目录匹配 ──────────────────────────────────────────


def load_final_dirs(path: Path) -> list[str]:
    return sorted([item.name for item in path.iterdir() if item.is_dir()], key=str.lower)


def build_final_norm_map(dirs: list[str]) -> dict[str, str]:
    return {normalize_key(name): name for name in dirs}


def score_match(candidate: str, target: str) -> float:
    if not candidate or not target:
        return 0.0
    if candidate == target:
        return 1.0

    shorter, longer = (candidate, target) if len(candidate) <= len(target) else (target, candidate)
    if longer.startswith(shorter):
        return round(0.92 + len(shorter) / max(len(longer), 1) * 0.06, 4)
    if shorter in longer:
        return round(0.82 + len(shorter) / max(len(longer), 1) * 0.08, 4)
    return round(SequenceMatcher(None, candidate, target).ratio(), 4)


def match_internal_name(
    original_name: str,
    alias_name: str,
    original_pinyin: str,
    final_norm_map: dict[str, str],
) -> tuple[str, str, float]:
    if original_pinyin and original_pinyin in final_norm_map:
        return final_norm_map[original_pinyin], "pinyin_exact", 1.0

    best_name = ""
    best_score = -1.0
    for merge_key, merge_name in final_norm_map.items():
        score = score_match(original_pinyin, merge_key)
        if score > best_score:
            best_name = merge_name
            best_score = score

    if best_name and best_score >= 0.78:
        return best_name, "pinyin_fuzzy", best_score

    return "", "unmatched", 0.0


# ── 已有数据加载 ──────────────────────────────────────────


def load_existing_ship_dict(path: Path) -> tuple[set[str], list[dict], dict]:
    """加载已有舰船字典。返回 (已有 ship_id 集合, entries 列表, 完整数据)。"""
    if not path.exists():
        return set(), [], {}

    data = json.loads(path.read_text(encoding="utf-8"))
    entries = data.get("entries", [])
    existing_ids = {entry["ship_id"] for entry in entries}
    return existing_ids, entries, data


# ── 立绘复制 ──────────────────────────────────────────────


def copy_paintings(internal_name: str, ship_name: str, final_dir: Path) -> tuple[bool, str]:
    """将立绘从 final_dir/internal_name/ 复制到 resources/character/ship_name/img/。"""
    src = final_dir / internal_name
    if not src.exists() or not src.is_dir():
        return False, f"立绘源目录不存在: {src}"

    dst = CHARACTER_DIR / ship_name / "img"
    dst.mkdir(parents=True, exist_ok=True)

    copied = 0
    for item in src.iterdir():
        if item.is_file():
            shutil.copy2(item, dst / item.name)
            copied += 1

    if copied == 0:
        return False, f"立绘源目录为空: {src}"

    return True, f"复制 {copied} 个文件到 {dst}"


# ── 输出 ──────────────────────────────────────────────────


def write_outputs(
    all_entries: list[dict],
    new_entries: list[dict],
    failures: list[ExtractFailure],
    html_row_count: int,
    existing_count: int,
    json_path: Path,
) -> None:
    """写入合并后的 JSON 和日志文件。"""
    json_payload = {
        "generated_from": str(json_path),
        "html_valid_rows": html_row_count,
        "extracted_entries": len(all_entries),
        "existing_entries": existing_count,
        "new_entries": len(new_entries),
        "extract_failures": [asdict(item) for item in failures],
        "pypinyin_available_locally": _lazy_pinyin is not None,
        "entries": all_entries,
        "name_to_internal": {
            entry["original_name"]: entry["matched_internal_name"]
            for entry in all_entries
            if entry.get("matched_internal_name")
        },
        "alias_to_internal": {
            entry["alias_name"]: entry["matched_internal_name"]
            for entry in all_entries
            if entry.get("alias_name") and entry.get("matched_internal_name")
        },
    }
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(json_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    BUILD_DATA_DIR.mkdir(parents=True, exist_ok=True)

    # 提取失败日志
    extract_lines = [
        f"html_valid_rows: {html_row_count}",
        f"existing_entries: {existing_count}",
        f"new_entries: {len(new_entries)}",
        f"extract_failures: {len(failures)}",
        "",
    ]
    extract_lines.extend(
        f"[FAIL] row={item.row_index} id={item.ship_id_raw} detail={item.detail}"
        for item in failures
    )
    DEFAULT_EXTRACT_FAILURES.write_text("\n".join(extract_lines) + "\n", encoding="utf-8")

    # 匹配成功日志（仅新增）
    matched_entries = [e for e in new_entries if e.get("matched_internal_name")]
    matched_lines = [f"matched_count: {len(matched_entries)}", ""]
    matched_lines.extend(
        f"{e['ship_id']}\t{e['original_name']}\t{e.get('alias_name', '')}\t"
        f"{e['matched_internal_name']}\t{e['match_method']}\t{e['match_score']}"
        for e in matched_entries
    )
    DEFAULT_MATCHED.write_text("\n".join(matched_lines) + "\n", encoding="utf-8")

    # 未匹配日志（仅新增）
    unmatched_entries = [e for e in new_entries if not e.get("matched_internal_name")]
    unmatched_lines = [f"unmatched_count: {len(unmatched_entries)}", ""]
    unmatched_lines.extend(
        f"{e['ship_id']}\t{e['original_name']}\t{e.get('alias_name', '')}\t"
        f"{e['release_date']}\t{e['pinyin_name']}"
        for e in unmatched_entries
    )
    DEFAULT_UNMATCHED.write_text("\n".join(unmatched_lines) + "\n", encoding="utf-8")


# ── 主函数 ────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(
        description="从实装日期 HTML 提取舰船字典，匹配立绘并复制到 resources/character。"
    )
    parser.add_argument("--html", type=Path, default=DEFAULT_HTML, help="HTML 源文件路径")
    parser.add_argument("--final-dir", type=Path, default=DEFAULT_FINAL_DIR,
                        help="立绘最终目录（按内部名称命名的文件夹）")
    parser.add_argument("--json-out", type=Path, default=DEFAULT_JSON,
                        help="输出 JSON 路径（已有数据会被保留，只追加新条目）")
    args = parser.parse_args()

    html_path = args.html.resolve()
    final_dir = args.final_dir.resolve()
    json_path = args.json_out.resolve()

    if not html_path.exists():
        print(f"HTML 文件不存在: {html_path}", file=sys.stderr)
        return 1
    if not final_dir.exists():
        print(f"立绘目录不存在: {final_dir}", file=sys.stderr)
        return 1

    # 1. 加载已有数据
    existing_ids, existing_entries, _existing_data = load_existing_ship_dict(json_path)
    print(f"已有舰船记录: {len(existing_ids)}")

    # 2. 解析 HTML
    rows, failures, html_row_count = parse_ship_rows(html_path)
    print(f"HTML 有效行: {html_row_count}, 提取成功: {len(rows)}, 提取失败: {len(failures)}")

    # 3. 过滤已有条目
    new_rows = [row for row in rows if row["ship_id"] not in existing_ids]
    print(f"新增舰船: {len(new_rows)} (跳过已有: {len(rows) - len(new_rows)})")

    if not new_rows:
        print("没有新增舰船，无需更新。")
        return 0

    # 4. 拼音转换
    pinyin_map = batch_to_pinyin([row["original_name"] for row in new_rows])
    final_dirs = load_final_dirs(final_dir)
    final_norm_map = build_final_norm_map(final_dirs)
    print(f"立绘目录数量: {len(final_dirs)}")

    # 5. 匹配（META 舰船追加 alter 后缀）
    new_entries: list[dict] = []
    for row in new_rows:
        original_clean = clean_name_for_pinyin(row["original_name"])
        pinyin_name = pinyin_map.get(original_clean, "")
        if is_meta_ship(row["original_name"]) and pinyin_name:
            pinyin_name = pinyin_name + "alter"

        matched_name, method, score = match_internal_name(
            row["original_name"],
            row["alias_name"],
            pinyin_name,
            final_norm_map,
        )

        new_entries.append({
            "ship_id": row["ship_id"],
            "original_name": row["original_name"],
            "alias_name": row["alias_name"],
            "release_date": row["release_date"],
            "pinyin_name": pinyin_name,
            "matched_internal_name": matched_name,
            "match_method": method,
            "match_score": score,
        })

    # 6. 复制立绘
    copied_count = 0
    copy_failures: list[tuple[str, str]] = []
    for entry in new_entries:
        if not entry["matched_internal_name"]:
            continue
        ok, msg = copy_paintings(
            entry["matched_internal_name"],
            entry["original_name"],
            final_dir,
        )
        if ok:
            copied_count += 1
            print(f"  [OK] {entry['original_name']} -> {entry['matched_internal_name']}: {msg}")
        else:
            copy_failures.append((entry["original_name"], msg))
            print(f"  [FAIL] {entry['original_name']}: {msg}")

    # 7. 合并并写入
    all_entries = existing_entries + new_entries
    write_outputs(
        all_entries,
        new_entries,
        failures,
        html_row_count,
        len(existing_entries),
        json_path,
    )

    # 8. 统计
    matched_count = sum(1 for e in new_entries if e.get("matched_internal_name"))
    exact_count = sum(1 for e in new_entries if e.get("match_method") == "pinyin_exact")
    fuzzy_count = sum(1 for e in new_entries if e.get("match_method") == "pinyin_fuzzy")
    unmatched_count = sum(1 for e in new_entries if not e.get("matched_internal_name"))

    print(f"\n=== 汇总 ===")
    print(f"已有记录: {len(existing_entries)}")
    print(f"新增条目: {len(new_entries)}")
    print(f"  匹配成功: {matched_count} (精确: {exact_count}, 模糊: {fuzzy_count})")
    print(f"  未匹配: {unmatched_count}")
    print(f"  立绘复制成功: {copied_count}")
    print(f"  立绘复制失败: {len(copy_failures)}")
    print(f"提取失败: {len(failures)}")
    print(f"总记录数: {len(all_entries)}")
    print(f"JSON 输出: {json_path}")
    print(f"日志目录: {BUILD_DATA_DIR}")

    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
