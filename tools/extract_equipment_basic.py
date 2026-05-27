#!/usr/bin/env python3
"""
从装备图鉴 HTML 中提取装备基础属性，生成装备索引 JSON。
输出:
  - JSON 索引: resources/equip/装备图鉴_装备基础属性.json
  - CSV 索引: tools/build_equip_data/装备基础属性.csv
  - 提取失败日志: tools/build_equip_data/extract_equip_failures.txt
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

# ── 路径常量 ──────────────────────────────────────────────

TOOLS_DIR = Path(__file__).resolve().parent
ROOT_DIR = TOOLS_DIR.parent
BUILD_DATA_DIR = TOOLS_DIR / "build_equip_data"

DEFAULT_HTML = TOOLS_DIR / "装备图鉴.html"
DEFAULT_JSON = ROOT_DIR / "resources" / "equip" / "装备图鉴_装备基础属性.json"
DEFAULT_CSV = BUILD_DATA_DIR / "装备基础属性.csv"
DEFAULT_FAILURES = BUILD_DATA_DIR / "extract_equip_failures.txt"

BASE_WIKI_URL = "https://wiki.biligame.com"
CARD_CLASS_NAMES = {"divsort", "jntj-1"}
NAME_SPAN_CLASS = "jntj-4"
TIER_RE = re.compile(r"#(T\d+)$")


@dataclass
class EquipmentRecord:
    name: str
    full_name: str
    tier: str
    wiki_url: str
    equipment_type: str
    ship_types: list[str]
    rarity: str
    faction: str


def split_ship_types(raw_value: str) -> list[str]:
    return [part.strip() for part in raw_value.split(",") if part.strip()]


def extract_tier(href: str, full_name: str) -> str:
    href_match = TIER_RE.search(href)
    if href_match:
        return href_match.group(1)

    text_match = re.search(r"(T\d+)$", full_name)
    if text_match:
        return text_match.group(1)

    return ""


class EquipmentHTMLParser(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.records: list[EquipmentRecord] = []
        self.current_card: dict[str, object] | None = None
        self.card_div_depth = 0
        self.name_span_depth = 0
        self.capture_name_text = False
        self.name_text_parts: list[str] = []
        self.failures: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key: value or "" for key, value in attrs}

        if tag == "div":
            class_names = set(attr_map.get("class", "").split())
            if self.current_card is None and CARD_CLASS_NAMES.issubset(class_names):
                self.current_card = {
                    "equipment_type": attr_map.get("data-param1", "").strip(),
                    "ship_types": split_ship_types(attr_map.get("data-param2", "")),
                    "rarity": attr_map.get("data-param3", "").strip(),
                    "faction": attr_map.get("data-param4", "").strip(),
                    "name": "",
                    "full_name": "",
                    "href": "",
                }
                self.card_div_depth = 1
                self.name_span_depth = 0
                self.capture_name_text = False
                self.name_text_parts = []
                return

            if self.current_card is not None:
                self.card_div_depth += 1
                return

        if self.current_card is None:
            return

        if tag == "span":
            class_names = set(attr_map.get("class", "").split())
            if NAME_SPAN_CLASS in class_names:
                self.name_span_depth += 1
            return

        if tag == "a" and self.name_span_depth > 0:
            self.current_card["name"] = attr_map.get("title", "").strip()
            self.current_card["href"] = attr_map.get("href", "").strip()
            self.capture_name_text = True
            self.name_text_parts = []

    def handle_data(self, data: str) -> None:
        if self.capture_name_text:
            self.name_text_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self.current_card is None:
            return

        if tag == "a" and self.capture_name_text:
            self.current_card["full_name"] = "".join(self.name_text_parts).strip()
            self.capture_name_text = False
            self.name_text_parts = []
            return

        if tag == "span" and self.name_span_depth > 0:
            self.name_span_depth -= 1
            return

        if tag == "div":
            self.card_div_depth -= 1
            if self.card_div_depth == 0:
                self._finalize_card()

    def _finalize_card(self) -> None:
        assert self.current_card is not None

        href = str(self.current_card["href"])
        full_name = str(self.current_card["full_name"])
        name = str(self.current_card["name"])
        if name and href:
            self.records.append(
                EquipmentRecord(
                    name=name,
                    full_name=full_name,
                    tier=extract_tier(href, full_name),
                    wiki_url=urljoin(self.base_url, href),
                    equipment_type=str(self.current_card["equipment_type"]),
                    ship_types=list(self.current_card["ship_types"]),
                    rarity=str(self.current_card["rarity"]),
                    faction=str(self.current_card["faction"]),
                )
            )
        elif href and not name:
            self.failures.append({"href": href, "detail": "缺少装备名称"})

        self.current_card = None
        self.card_div_depth = 0
        self.name_span_depth = 0
        self.capture_name_text = False
        self.name_text_parts = []


def parse_equipment(html_text: str, base_url: str) -> tuple[list[EquipmentRecord], list[dict[str, str]]]:
    parser = EquipmentHTMLParser(base_url=base_url)
    parser.feed(html_text)
    parser.close()
    return parser.records, parser.failures


def load_existing_index(json_path: Path) -> tuple[set[str], list[dict]]:
    """加载已有装备索引。返回 (已有 full_name 集合, 已有条目列表)。"""
    if not json_path.exists():
        return set(), []
    data = json.loads(json_path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        return set(), []
    existing_names = {item.get("full_name") for item in data if item.get("full_name")}
    return existing_names, data


def write_outputs(
    all_records: list[dict],
    new_records: list[EquipmentRecord],
    failures: list[dict[str, str]],
    json_path: Path,
    csv_path: Path,
    failures_path: Path,
) -> None:
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(all_records, ensure_ascii=False, indent=2), encoding="utf-8")

    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(
            file,
            fieldnames=[
                "name",
                "full_name",
                "tier",
                "wiki_url",
                "equipment_type",
                "ship_types",
                "rarity",
                "faction",
            ],
        )
        writer.writeheader()
        for record in new_records:
            row = asdict(record)
            row["ship_types"] = "|".join(record.ship_types)
            writer.writerow(row)

    if failures:
        failures_path.parent.mkdir(parents=True, exist_ok=True)
        lines = [f"failures: {len(failures)}", ""]
        lines.extend(f"[FAIL] {f.get('href', '')} detail={f.get('detail', '')}" for f in failures)
        failures_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="从装备图鉴 HTML 中提取装备基础属性，生成装备索引 JSON。"
    )
    parser.add_argument(
        "--html",
        type=Path,
        default=DEFAULT_HTML,
        help=f"输入的 HTML 文件路径，默认: {DEFAULT_HTML}",
    )
    parser.add_argument(
        "--json-out",
        type=Path,
        default=DEFAULT_JSON,
        help=f"输出 JSON 路径，默认: {DEFAULT_JSON}",
    )
    parser.add_argument(
        "--base-url",
        default=BASE_WIKI_URL,
        help=f"拼接 Wiki 地址使用的站点前缀，默认: {BASE_WIKI_URL}",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="覆盖模式：忽略已有条目，全量重写 JSON。默认为追加模式。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    html_path = args.html.resolve()
    json_path = args.json_out.resolve()
    csv_path = DEFAULT_CSV.resolve()
    failures_path = DEFAULT_FAILURES.resolve()

    if not html_path.exists():
        print(f"HTML 文件不存在: {html_path}", file=sys.stderr)
        return 1
    if not html_path.is_file():
        print(f"输入路径不是文件: {html_path}", file=sys.stderr)
        return 1

    html_text = html_path.read_text(encoding="utf-8-sig")
    records, failures = parse_equipment(html_text, base_url=args.base_url)
    if not records:
        print("没有在 HTML 中找到任何装备卡片，请确认文件内容是否完整。", file=sys.stderr)
        return 2

    print(f"HTML 提取: {len(records)} 条装备记录，{len(failures)} 条失败。")

    if args.force:
        all_records = [asdict(r) for r in records]
        new_records = records
        print(f"覆盖模式，全量写入 {len(all_records)} 条。")
    else:
        existing_names, existing_data = load_existing_index(json_path)
        print(f"已有索引: {len(existing_names)} 条。")
        new_records = [r for r in records if r.full_name not in existing_names]
        print(f"新增: {len(new_records)} 条，跳过: {len(records) - len(new_records)} 条。")
        all_records = existing_data + [asdict(r) for r in new_records]

    write_outputs(all_records, new_records, failures, json_path, csv_path, failures_path)

    print(f"JSON 输出: {json_path} (共 {len(all_records)} 条)")
    print(f"CSV 输出: {csv_path} (新增 {len(new_records)} 条)")
    if failures:
        print(f"失败日志: {failures_path}")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
