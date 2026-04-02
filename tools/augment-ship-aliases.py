#!/usr/bin/env python3
import argparse
import json
import re
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SHIP_DICT_FILE = ROOT / "resources" / "ship_dict_from_install_dates.json"
DEFAULT_ALIAS_FILE = ROOT / "resources" / "ship_aliases_from_nicknames.json"

META_DOT_RE = re.compile(r"([·・･‧])\s*(META)$", re.IGNORECASE)
II_SUFFIX_RE = re.compile(r"II$", re.IGNORECASE)


def normalize_name(value):
    return str(value or "").strip()


def add_alias(alias_map, ship_name, alias):
    ship_name = normalize_name(ship_name)
    alias = normalize_name(alias)
    if not ship_name or not alias or ship_name == alias:
        return False

    alias_map.setdefault(ship_name, [])
    if alias in alias_map[ship_name]:
        return False

    alias_map[ship_name].append(alias)
    return True


def build_meta_alias(ship_name):
    # 猎人·META -> 猎人META
    return META_DOT_RE.sub(r"\2", ship_name)


def build_ii_alias(ship_name):
    # 哈曼II -> 哈曼2
    return II_SUFFIX_RE.sub("2", ship_name)


def main():
    parser = argparse.ArgumentParser(description="为舰船别名文件补充 META 与 II 规则别名。")
    parser.add_argument("--ship-dict", default=str(SHIP_DICT_FILE), help="舰船字典 JSON 路径")
    parser.add_argument("--alias-file", default=str(DEFAULT_ALIAS_FILE), help="舰船别名 JSON 路径")
    args = parser.parse_args()

    ship_dict_path = Path(args.ship_dict).resolve()
    alias_file_path = Path(args.alias_file).resolve()

    ship_dict_payload = json.loads(ship_dict_path.read_text(encoding="utf-8"))
    alias_payload = json.loads(alias_file_path.read_text(encoding="utf-8"))

    entries = ship_dict_payload.get("entries", [])
    alias_map = alias_payload.get("ship_to_aliases", {})

    meta_added = 0
    meta_alias_name_added = 0
    ii_added = 0

    for entry in entries:
        ship_name = normalize_name(entry.get("original_name"))
        ship_id = normalize_name(entry.get("ship_id"))
        if not ship_name:
            continue

        if ship_id.upper().startswith("META"):
            meta_alias = build_meta_alias(ship_name)
            if add_alias(alias_map, ship_name, meta_alias):
                meta_added += 1

            alias_name = normalize_name(entry.get("alias_name"))
            if alias_name:
                alias_meta = build_meta_alias(alias_name)
                if add_alias(alias_map, ship_name, alias_meta):
                    meta_alias_name_added += 1

        if II_SUFFIX_RE.search(ship_name):
            ii_alias = build_ii_alias(ship_name)
            if add_alias(alias_map, ship_name, ii_alias):
                ii_added += 1

    for ship_name, aliases in alias_map.items():
        alias_map[ship_name] = sorted(set(aliases))

    alias_payload["generated_at"] = datetime.now().isoformat(timespec="seconds")
    alias_payload["ship_name_count"] = len(entries)
    alias_payload["alias_count"] = sum(len(items) for items in alias_map.values())
    alias_payload["ship_with_alias_count"] = len([k for k, v in alias_map.items() if v])
    alias_payload["ship_to_aliases"] = alias_map
    alias_payload["meta_alias_added"] = meta_added
    alias_payload["meta_alias_name_added"] = meta_alias_name_added
    alias_payload["ii_alias_added"] = ii_added

    alias_file_path.write_text(json.dumps(alias_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"[ship-alias] 已更新: {alias_file_path}")
    print(f"[ship-alias] META 新增别名: {meta_added}")
    print(f"[ship-alias] META(alias_name) 新增别名: {meta_alias_name_added}")
    print(f"[ship-alias] II->2 新增别名: {ii_added}")
    print(f"[ship-alias] 别名总数: {alias_payload['alias_count']}")


if __name__ == "__main__":
    main()
