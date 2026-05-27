#!/usr/bin/env python3
import argparse
import html
import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path


TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent
DEFAULT_HTML = ROOT / "temp" / "装备昵称.html"
DEFAULT_OUTPUT = ROOT / "resources" / "equip_aliases_from_nicknames.json"
EQUIP_INDEX_FILE = ROOT / "resources" / "equip" / "装备图鉴_装备基础属性.json"

DL_RE = re.compile(r"<dl\b[^>]*>(.*?)</dl>", re.IGNORECASE | re.DOTALL)
DT_RE = re.compile(r"<dt\b[^>]*>(.*?)</dt>", re.IGNORECASE | re.DOTALL)
DD_RE = re.compile(r"<dd\b[^>]*>(.*?)</dd>", re.IGNORECASE | re.DOTALL)
A_TITLE_RE = re.compile(r"<a\b[^>]*\btitle=(?:\"([^\"]+)\"|'([^']+)')[^>]*>", re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
ALIAS_SPLIT_RE = re.compile(r"[、/／,，;；|]+")


def normalize_keyword(value):
    return (
        str(value or "")
        .strip()
        .lower()
        .replace("·", "")
        .replace("・", "")
        .replace("･", "")
        .replace("‧", "")
        .replace("(", "")
        .replace(")", "")
        .replace("（", "")
        .replace("）", "")
        .replace("[", "")
        .replace("]", "")
        .replace("【", "")
        .replace("】", "")
    )


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


def build_title_variants(title):
    raw = str(title or "").strip()
    if not raw:
        return []

    variants = [raw]
    variants.append(re.sub(r"#\s*(T\d+)$", r"\1", raw, flags=re.IGNORECASE))
    variants.append(raw.replace("#", ""))

    seen = set()
    result = []
    for item in variants:
        normalized = normalize_keyword(item)
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def load_equip_name_map():
    raw = EQUIP_INDEX_FILE.read_text(encoding="utf-8")
    entries = json.loads(raw)

    equip_meta = {}
    key_to_full_names = defaultdict(set)

    for entry in entries:
        full_name = str(entry.get("full_name", "")).strip()
        name = str(entry.get("name", "")).strip()
        tier = str(entry.get("tier", "")).strip().upper()
        wiki_url = str(entry.get("wiki_url", "")).strip()

        if not full_name:
            continue

        equip_meta[full_name] = {
            "full_name": full_name,
            "name": name,
            "tier": tier,
            "wiki_url": wiki_url,
        }

        for candidate in [
            full_name,
            name,
            f"{name}{tier}" if name and tier else "",
            f"{name}#{tier}" if name and tier else "",
            re.sub(r"#\s*(T\d+)$", r"\1", full_name, flags=re.IGNORECASE),
        ]:
            normalized = normalize_keyword(candidate)
            if normalized:
                key_to_full_names[normalized].add(full_name)

    return equip_meta, key_to_full_names


def resolve_matched_equip(titles, key_to_full_names):
    for title in titles:
        for normalized in build_title_variants(title):
            matches = sorted(key_to_full_names.get(normalized, set()))
            if len(matches) == 1:
                return matches[0], title
    return None, ""


def merge_alias(equip_to_aliases, full_name, alias):
    alias = str(alias or "").strip()
    if not alias:
        return
    if alias == full_name:
        return
    if alias not in equip_to_aliases[full_name]:
        equip_to_aliases[full_name].append(alias)


def parse_blocks(html_text, equip_meta, key_to_full_names):
    equip_to_aliases = defaultdict(list)
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
        matched_full_name, matched_title = resolve_matched_equip(titles, key_to_full_names)
        if not matched_full_name or matched_full_name not in equip_meta:
            unmatched.append(
                {
                    "dt": strip_tags(dt_html),
                    "titles": titles[:10],
                }
            )
            continue

        for alias in alias_list:
            current_equip = alias_owner.get(alias)
            if current_equip and current_equip != matched_full_name:
                conflicts.append(
                    {
                        "alias": alias,
                        "existing_full_name": current_equip,
                        "new_full_name": matched_full_name,
                        "dt": strip_tags(dt_html),
                        "matched_title": matched_title,
                    }
                )
                continue

            alias_owner[alias] = matched_full_name
            merge_alias(equip_to_aliases, matched_full_name, alias)

    normalized = {}
    for full_name in sorted(equip_to_aliases.keys()):
        normalized[full_name] = sorted(equip_to_aliases[full_name])

    return {
        "equip_to_aliases": normalized,
        "conflicts": conflicts,
        "unmatched": unmatched,
    }


def load_existing_aliases(output_path: Path) -> dict[str, list[str]]:
    """加载已有别名数据。返回 equip_to_aliases 字典。"""
    if not output_path.exists():
        return {}
    data = json.loads(output_path.read_text(encoding="utf-8"))
    return data.get("equip_to_aliases", {})


def merge_aliases(
    existing: dict[str, list[str]],
    new_data: dict[str, list[str]],
) -> tuple[dict[str, list[str]], int, int]:
    """合并已有和新增别名。返回 (合并后字典, 新增装备数, 新增别名数)。"""
    merged = {name: list(aliases) for name, aliases in existing.items()}
    new_equip_count = 0
    new_alias_count = 0

    for full_name, new_aliases in new_data.items():
        if full_name not in merged:
            merged[full_name] = sorted(new_aliases)
            new_equip_count += 1
            new_alias_count += len(new_aliases)
        else:
            existing_set = set(merged[full_name])
            for alias in new_aliases:
                if alias not in existing_set:
                    merged[full_name].append(alias)
                    existing_set.add(alias)
                    new_alias_count += 1
            merged[full_name] = sorted(merged[full_name])

    return merged, new_equip_count, new_alias_count


def build_output(html_path, equip_to_aliases, equip_meta, conflicts, unmatched):
    return {
        "source_file": str(html_path.relative_to(ROOT)).replace("\\", "/"),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "equip_name_count": len(equip_meta),
        "alias_count": sum(len(items) for items in equip_to_aliases.values()),
        "equip_with_alias_count": len(equip_to_aliases),
        "conflict_count": len(conflicts),
        "unmatched_count": len(unmatched),
        "equip_to_aliases": equip_to_aliases,
        "conflicts": conflicts,
        "unmatched": unmatched,
    }


def main():
    parser = argparse.ArgumentParser(description="解析装备别称查询页面，生成装备别名字典。")
    parser.add_argument("--html", default=str(DEFAULT_HTML), help="装备昵称 HTML 文件路径")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="输出 JSON 文件路径")
    parser.add_argument("--force", action="store_true", help="覆盖模式：忽略已有别名，全量重写。默认为追加模式。")
    args = parser.parse_args()

    html_path = Path(args.html).resolve()
    output_path = Path(args.output).resolve()

    if not html_path.exists():
        raise FileNotFoundError(f"未找到装备昵称 HTML 文件: {html_path}")

    html_text = html_path.read_text(encoding="utf-8")
    equip_meta, key_to_full_names = load_equip_name_map()
    parsed_data = parse_blocks(html_text, equip_meta, key_to_full_names)
    new_aliases = parsed_data["equip_to_aliases"]

    if args.force:
        equip_to_aliases = new_aliases
        print(f"[equip-alias] 覆盖模式，全量写入。")
    else:
        existing_aliases = load_existing_aliases(output_path)
        equip_to_aliases, new_equip_count, new_alias_count = merge_aliases(
            existing_aliases, new_aliases
        )
        print(f"[equip-alias] 已有装备: {len(existing_aliases)}，新增装备: {new_equip_count}，新增别名: {new_alias_count}")

    payload = build_output(
        html_path, equip_to_aliases, equip_meta,
        parsed_data["conflicts"], parsed_data["unmatched"]
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"[equip-alias] 已写入: {output_path}")
    print(f"[equip-alias] 装备总数: {payload['equip_name_count']}")
    print(f"[equip-alias] 别名总数: {payload['alias_count']}")
    print(f"[equip-alias] 有别名装备数: {payload['equip_with_alias_count']}")
    print(f"[equip-alias] 冲突数: {payload['conflict_count']}")
    print(f"[equip-alias] 未命中条目数: {payload['unmatched_count']}")


if __name__ == "__main__":
    main()
