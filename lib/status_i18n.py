"""Normalize known Chinese WMS status strings to English (see spec: Chinese WMS at
OPS-WH02, GPS reports at WH04). Only the term confirmed in the spec is mapped by
default — extend STATUS_TRANSLATIONS as more real values are observed. Unknown
values pass through unchanged rather than failing.
"""

STATUS_TRANSLATIONS = {
    "已出庫": "Dispatched",
    "已出库": "Dispatched",
}


def normalize_status(value):
    if value is None:
        return value
    s = str(value).strip()
    return STATUS_TRANSLATIONS.get(s, s)
