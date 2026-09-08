"""Cross-cutting SKU rules shared by Task A and Task B (see PRENETICS_TOOL_SPEC.md)."""

SKU_ALIAS_MAP = {
    "IM8-FAKE-216": "IM8-FG-000216",
    "IM8-FAKE-215": "IM8-FG-000215",
}

SERVICE_SKU_PREFIX = "IM8-SER-"
PALLET_SKU_MARKERS = ("9X7X4", "10X8X5")


def normalize_sku(sku):
    if sku is None:
        return sku
    s = str(sku).strip()
    return SKU_ALIAS_MAP.get(s, s)


def is_service_sku(sku):
    return str(sku).strip().upper().startswith(SERVICE_SKU_PREFIX)


def is_pallet_sku(sku):
    s = str(sku).strip().upper()
    return any(marker in s for marker in PALLET_SKU_MARKERS)


def is_excluded_sku(sku):
    return is_service_sku(sku) or is_pallet_sku(sku)
