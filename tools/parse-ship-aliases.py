#!/usr/bin/env python3
import argparse
import html
import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_HTML = ROOT / "temp" / "昵称.html"
DEFAULT_OUTPUT = ROOT / "resources" / "ship_aliases_from_nicknames.json"
SHIP_DICT_FILE = ROOT / "resources" / "ship_dict_from_install_dates.json"

DL_RE = re.compile(r"<dl\b[^>]*>(.*?)</dl>", re.IGNORECASE | re.DOTALL)
DT_RE = re.compile(r"<dt\b[^>]*>(.*?)</dt>", re.IGNORECASE | re.DOTALL)
DD_RE = re.compile(r"<dd\b[^>]*>(.*?)</dd>", re.IGNORECASE | re.DOTALL)
A_TITLE_RE = re.compile(r"<a\b[^>]*\btitle=(?:\"([^\"]+)\"|'([^']+)')[^>]*>", re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
ALIAS_SPLIT_RE = re.compile(r"[、/／,，;；|]+")


def load_ship_name_map():
    raw = SHIP_DICT_FILE.read_text(encoding="utf-8")
    parsed = json.loads(raw)
    entries = parsed.get("entries", [])
    result = {}
    for entry in entries:
        name = str(entry.get("original_name", "")).strip()
        if not name:
            continue
        result[name] = {
            "ship_name": name,
            "ship_id": str(entry.get("ship_id", "")).strip(),
            "matched_internal_name": str(entry.get("matched_internal_name", "")).strip(),
            "alias_name": str(entry.get("alias_name", "")).strip(),
            "release_date": str(entry.get("release_date", "")).strip(),
        }
    return result


def strip_tags(value):
    text = TAG_RE.sub("", value or "")
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def extract_aliases(dt_html):
    dt_text = strip_tags(dt_html)
    if not dt_text:
        return []

    parts = [part.strip() for part in ALIAS_SPLIT_RE.split(dt_text) if part.strip()]
    seen = set()
    aliases = []
    for alias in parts:
        if alias not in seen:
            seen.add(alias)
            aliases.append(alias)
    return aliases


def extract_titles(dd_html):
    titles = []
    for match in A_TITLE_RE.finditer(dd_html or ""):
        title = html.unescape(match.group(1) or match.group(2) or "").strip()
        if title:
            titles.append(title)
    return titles


def merge_alias(ship_to_aliases, ship_name, alias):
    alias = str(alias or "").strip()
    if not alias:
        return
    if alias == ship_name:
        return
    if alias not in ship_to_aliases[ship_name]:
        ship_to_aliases[ship_name].append(alias)


def parse_blocks(html_text, ship_name_map):
    ship_to_aliases = defaultdict(list)
    conflicts = []
    unmatched = []
    alias_owner = {}

    for block_html in DL_RE.findall(html_text):
        dt_match = DT_RE.search(block_html)
        dd_match = DD_RE.search(block_html)
        if not dt_match or not dd_match:
            continue

        dt_html = dt_match.group(1)
        dd_html = dd_match.group(1)
        alias_list = extract_aliases(dt_html)
        if not alias_list:
            continue

        titles = extract_titles(dd_html)
        matched_ship = None
        matched_title = ""
        for title in titles:
            if title in ship_name_map:
                matched_ship = ship_name_map[title]
                matched_title = title
                break

        if not matched_ship:
            unmatched.append({
                "dt": strip_tags(dt_html),
                "titles": titles[:10],
            })
            continue

        for alias in alias_list:
            current_ship = alias_owner.get(alias)
            if current_ship and current_ship != matched_ship["ship_name"]:
                conflicts.append({
                    "alias": alias,
                    "existing_ship_name": current_ship,
                    "new_ship_name": matched_ship["ship_name"],
                    "dt": strip_tags(dt_html),
                    "matched_title": matched_title,
                })
                continue

            alias_owner[alias] = matched_ship["ship_name"]
            merge_alias(ship_to_aliases, matched_ship["ship_name"], alias)

    for ship_name, meta in ship_name_map.items():
        raw_alias = meta.get("alias_name", "")
        if not raw_alias:
            continue
        for alias in extract_aliases(raw_alias):
            current_ship = alias_owner.get(alias)
            if current_ship and current_ship != ship_name:
                conflicts.append({
                    "alias": alias,
                    "existing_ship_name": current_ship,
                    "new_ship_name": ship_name,
                    "dt": raw_alias,
                    "matched_title": ship_name,
                })
                continue
            alias_owner[alias] = ship_name
            merge_alias(ship_to_aliases, ship_name, alias)

    normalized_ship_to_aliases = {}
    for ship_name in sorted(ship_to_aliases.keys()):
        normalized_ship_to_aliases[ship_name] = sorted(ship_to_aliases[ship_name])

    return {
        "ship_to_aliases": normalized_ship_to_aliases,
        "conflicts": conflicts,
        "unmatched": unmatched,
    }


def build_output(html_path, parsed_data, ship_name_map):
    return {
        "source_file": str(html_path.relative_to(ROOT)).replace("\\", "/"),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "ship_name_count": len(ship_name_map),
        "alias_count": sum(len(items) for items in parsed_data["ship_to_aliases"].values()),
        "ship_with_alias_count": len(parsed_data["ship_to_aliases"]),
        "conflict_count": len(parsed_data["conflicts"]),
        "unmatched_count": len(parsed_data["unmatched"]),
        **parsed_data,
    }


def main():
    parser = argparse.ArgumentParser(description="解析昵称术语查询页面，生成舰船别名字典。")
    parser.add_argument("--html", default=str(DEFAULT_HTML), help="昵称 HTML 文件路径")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="输出 JSON 文件路径")
    args = parser.parse_args()

    html_path = Path(args.html).resolve()
    output_path = Path(args.output).resolve()

    if not html_path.exists():
        raise FileNotFoundError(f"未找到昵称 HTML 文件: {html_path}")

    html_text = html_path.read_text(encoding="utf-8")
    ship_name_map = load_ship_name_map()
    parsed_data = parse_blocks(html_text, ship_name_map)
    payload = build_output(html_path, parsed_data, ship_name_map)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"[alias] 已生成: {output_path}")
    print(f"[alias] 舰船总数: {payload['ship_name_count']}")
    print(f"[alias] 别名总数: {payload['alias_count']}")
    print(f"[alias] 有别名舰船数: {payload['ship_with_alias_count']}")
    print(f"[alias] 冲突数: {payload['conflict_count']}")
    print(f"[alias] 未命中条目数: {payload['unmatched_count']}")


if __name__ == "__main__":
    main()
