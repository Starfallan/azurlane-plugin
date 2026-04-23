#!/usr/bin/env python3
import argparse
import json
import re
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SHIP_DICT_FILE = ROOT / "resources" / "ship_dict_from_install_dates.json"
DEFAULT_ALIAS_FILE = ROOT / "resources" / "ship_aliases_from_nicknames.json"

DOT_RE = re.compile(r"[·・･‧]")


def normalize_text(value):
    return str(value or "").strip()


def remove_middle_dot(value):
    text = normalize_text(value)
    if not text:
        return ""
    return DOT_RE.sub("", text)


def add_alias(alias_map, ship_name, alias):
    ship_name = normalize_text(ship_name)
    alias = normalize_text(alias)
    if not ship_name or not alias or ship_name == alias:
        return False

    alias_map.setdefault(ship_name, [])
    if alias in alias_map[ship_name]:
        return False

    alias_map[ship_name].append(alias)
    return True


def main():
    parser = argparse.ArgumentParser(description="为含中点的舰船名称补充去点别名。")
    parser.add_argument("--ship-dict", default=str(SHIP_DICT_FILE), help="舰船字典 JSON 路径")
    parser.add_argument("--alias-file", default=str(DEFAULT_ALIAS_FILE), help="舰船别名 JSON 路径")
    args = parser.parse_args()

    ship_dict_path = Path(args.ship_dict).resolve()
    alias_file_path = Path(args.alias_file).resolve()

    ship_dict_payload = json.loads(ship_dict_path.read_text(encoding="utf-8"))
    alias_payload = json.loads(alias_file_path.read_text(encoding="utf-8"))

    entries = ship_dict_payload.get("entries", [])
    alias_map = alias_payload.get("ship_to_aliases", {})

    dotless_added = 0
    dotless_alias_name_added = 0

    for entry in entries:
        ship_name = normalize_text(entry.get("original_name"))
        if not ship_name:
            continue

        # 规则1: original_name 含点号，给该舰船增加去点别名。
        if DOT_RE.search(ship_name):
            alias = remove_middle_dot(ship_name)
            if add_alias(alias_map, ship_name, alias):
                dotless_added += 1

        # 规则2: alias_name 含点号，给该舰船增加 alias_name 的去点形式。
        alias_name = normalize_text(entry.get("alias_name"))
        if alias_name and DOT_RE.search(alias_name):
            alias_from_alias_name = remove_middle_dot(alias_name)
            if add_alias(alias_map, ship_name, alias_from_alias_name):
                dotless_alias_name_added += 1

    for ship_name, aliases in alias_map.items():
        alias_map[ship_name] = sorted(set(aliases))

    alias_payload["generated_at"] = datetime.now().isoformat(timespec="seconds")
    alias_payload["ship_name_count"] = len(entries)
    alias_payload["alias_count"] = sum(len(items) for items in alias_map.values())
    alias_payload["ship_with_alias_count"] = len([k for k, v in alias_map.items() if v])
    alias_payload["ship_to_aliases"] = alias_map
    alias_payload["dotless_alias_added"] = dotless_added
    alias_payload["dotless_alias_name_added"] = dotless_alias_name_added

    alias_file_path.write_text(json.dumps(alias_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"[ship-alias-dotless] 已更新: {alias_file_path}")
    print(f"[ship-alias-dotless] original_name 去点新增别名: {dotless_added}")
    print(f"[ship-alias-dotless] alias_name 去点新增别名: {dotless_alias_name_added}")
    print(f"[ship-alias-dotless] 别名总数: {alias_payload['alias_count']}")


if __name__ == "__main__":
    main()
