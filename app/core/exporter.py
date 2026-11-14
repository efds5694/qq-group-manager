"""导出：CSV 始终可用，xlsx 仅在装有 openpyxl 时启用。

CSV 使用 utf-8-sig，保证 Excel 双击打开中文不乱码。
"""

from __future__ import annotations

import csv
import io

# 字段白名单：顺序即导出列顺序
FIELD_LABELS: dict[str, str] = {
    "qq": "QQ号",
    "nickname": "昵称",
    "card": "群名片",
    "role": "身份",
    "level": "等级",
    "join_time": "加群时间",
    "last_sent_time": "最后发言",
    "title": "头衔",
}

DEFAULT_FIELDS = ["qq", "nickname", "card", "role", "join_time", "last_sent_time"]


def normalize_fields(fields: list[str] | None) -> list[str]:
    if not fields:
        return list(DEFAULT_FIELDS)
    picked = [name for name in fields if name in FIELD_LABELS]
    return picked or list(DEFAULT_FIELDS)


def _openpyxl_available() -> bool:
    try:
        import openpyxl  # noqa: F401
    except Exception:
        return False
    return True


def supported_formats() -> list[str]:
    return ["csv", "xlsx"] if _openpyxl_available() else ["csv"]


def build_row(member: dict, fields: list[str]) -> list[str]:
    row = []
    for name in fields:
        if name == "role":
            row.append(str(member.get("role_label") or member.get("role") or ""))
        else:
            row.append(str(member.get(name, "") or ""))
    return row


def build_rows(members: list[dict], fields: list[str]) -> list[list[str]]:
    return [build_row(member, fields) for member in members]


# ------------------------------------------------------------------ 通用输出
# 多群导出 / 共同成员导出的列是动态的，所以这里提供「表头 + 二维数据」的通用出口。
def _safe_text(value) -> str:
    text = str(value if value is not None else "")
    if text.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + text
    return text


def rows_to_csv(header: list[str], rows: list[list[str]]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow([_safe_text(cell) for cell in header])
    writer.writerows([_safe_text(cell) for cell in row] for row in rows)
    return buffer.getvalue().encode("utf-8-sig")


def rows_to_tsv(header: list[str], rows: list[list[str]]) -> bytes:
    """制表符分隔：复制到剪贴板后可直接粘进 Excel / WPS。"""
    def clean(value) -> str:
        return _safe_text(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")

    lines = ["\t".join(clean(cell) for cell in header)]
    lines.extend("\t".join(clean(cell) for cell in row) for row in rows)
    return ("\n".join(lines)).encode("utf-8")


def rows_to_xlsx(header: list[str], rows: list[list[str]], sheet_title: str = "群成员") -> bytes | None:
    if not _openpyxl_available():
        return None
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "".join(ch for ch in (sheet_title or "群成员") if ch not in '\\/*?:[]')[:28] or "群成员"

    header_fill = PatternFill("solid", fgColor="2F4BFF")
    header_font = Font(color="FFFFFF", bold=True)
    sheet.append(list(header))
    for cell in sheet[1]:
        cell.fill = header_fill
        cell.font = header_font

    for row in rows:
        sheet.append(list(row))

    for cells in sheet.iter_rows():
        for cell in cells:
            cell.data_type = "s"

    from openpyxl.utils import get_column_letter

    for index in range(1, len(header) + 1):
        sheet.column_dimensions[get_column_letter(index)].width = 18

    sheet.freeze_panes = "A2"
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def to_csv(members: list[dict], fields: list[str]) -> bytes:
    return rows_to_csv([FIELD_LABELS[name] for name in fields], build_rows(members, fields))


def to_tsv(members: list[dict], fields: list[str]) -> bytes:
    return rows_to_tsv([FIELD_LABELS[name] for name in fields], build_rows(members, fields))


def to_xlsx(members: list[dict], fields: list[str], sheet_title: str = "群成员") -> bytes | None:
    raw = rows_to_xlsx([FIELD_LABELS[name] for name in fields], build_rows(members, fields), sheet_title)
    if raw is None:
        return None
    return raw
