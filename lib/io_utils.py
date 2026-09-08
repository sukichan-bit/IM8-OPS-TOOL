"""Shared helpers for reading uploaded Excel/CSV exports into DataFrames.

Real-world exports in this workflow are messy: header rows aren't always row 1,
sheet names vary, and column names have near-duplicate variants (e.g. "Available
physical" vs "Available physical on exact dimensions"). These helpers surface a
best-guess and let the caller (Streamlit UI) confirm/override rather than
silently picking wrong.
"""

import io
import re

import pandas as pd


def _normalize(s):
    return re.sub(r"\s+", " ", str(s).strip().lower())


def is_excel(filename):
    return str(filename).lower().endswith((".xlsx", ".xls", ".xlsm"))


def guess_warehouse_from_filename(filename, known_warehouses):
    """When a team uploads one fulfillment report per warehouse, the warehouse
    code is usually right there in the filename (e.g. '...OPS-WH02 Fulfillment
    Report.xlsx'). Returns the single matching warehouse, or None if zero or
    more than one candidate matches."""
    name_upper = str(filename).upper()
    matches = [wh for wh in known_warehouses if str(wh).upper() in name_upper]
    return matches[0] if len(matches) == 1 else None


def list_sheets(file_bytes, filename):
    if not is_excel(filename):
        return None
    xl = pd.ExcelFile(io.BytesIO(file_bytes))
    return xl.sheet_names


def read_raw_preview(file_bytes, filename, sheet_name=None, n_rows=15):
    """Read the first n_rows of a sheet/CSV with no header, for header-row picking."""
    if is_excel(filename):
        return pd.read_excel(
            io.BytesIO(file_bytes), sheet_name=sheet_name, header=None, nrows=n_rows
        )
    return pd.read_csv(io.BytesIO(file_bytes), header=None, nrows=n_rows)


def guess_header_row_and_score(raw_preview_df, candidates, max_scan=20):
    """Return (0-indexed best header row, score) — score is how many cells in
    that row match a candidate column name (also matching bilingual headers
    like "Tracking No./物流跟踪号" on their pre-slash segment)."""
    all_candidate_terms = set()
    for terms in candidates.values():
        all_candidate_terms.update(_normalize(t) for t in terms)

    def _row_score(row_vals):
        score = 0
        for v in row_vals:
            if v in all_candidate_terms:
                score += 1
            elif "/" in v and _normalize(v.split("/")[0]) in all_candidate_terms:
                score += 1
        return score

    best_row, best_score = 0, -1
    for i in range(min(max_scan, len(raw_preview_df))):
        row_vals = [str(v).strip().lower() for v in raw_preview_df.iloc[i].tolist() if pd.notna(v)]
        score = _row_score(row_vals)
        if score > best_score:
            best_row, best_score = i, score
    return best_row, best_score


def guess_header_row(raw_preview_df, candidates, max_scan=20):
    """Return just the 0-indexed best header row (see guess_header_row_and_score)."""
    row, _ = guess_header_row_and_score(raw_preview_df, candidates, max_scan=max_scan)
    return row


def pick_best_sheet(file_bytes, filename, sheets, candidates, n_rows=20):
    """When a workbook has multiple sheets, auto-pick the one whose guessed
    header row matches the most candidate columns. Returns (sheet_name, header_row).
    """
    best_sheet, best_row, best_score = sheets[0], 0, -1
    for sheet in sheets:
        preview = read_raw_preview(file_bytes, filename, sheet_name=sheet, n_rows=n_rows)
        row, score = guess_header_row_and_score(preview, candidates)
        if score > best_score:
            best_sheet, best_row, best_score = sheet, row, score
    return best_sheet, best_row


def load_table(file_bytes, filename, sheet_name=None, header_row=0):
    """Load the full table using the given header row (0-indexed)."""
    if is_excel(filename):
        df = pd.read_excel(
            io.BytesIO(file_bytes), sheet_name=sheet_name, header=header_row
        )
    else:
        df = pd.read_csv(io.BytesIO(file_bytes), header=header_row)
    df.columns = [str(c).strip() for c in df.columns]
    return df


def fuzzy_match_column(columns, candidates):
    """Find the best match in `columns` for a logical field, given a list of
    candidate header strings (in priority order). Exact (normalized) matches
    only — no substring matching, since real files have near-duplicate columns
    (e.g. "Available physical" vs "Available physical on exact dimensions")
    that a substring match would confuse.

    Returns the matched column name, or None if no candidate matches exactly.
    """
    norm_lookup = {_normalize(c): c for c in columns}
    for cand in candidates:
        norm_cand = _normalize(cand)
        if norm_cand in norm_lookup:
            return norm_lookup[norm_cand]

    # Bilingual headers like "Tracking No./物流跟踪号" won't exact-match a plain
    # English candidate — retry against the segment before the first "/" (also
    # stripping a trailing "." from abbreviations like "Reference order No.").
    segment_lookup = {
        _normalize(c.split("/")[0]).rstrip("."): c for c in columns if "/" in str(c)
    }
    for cand in candidates:
        norm_cand = _normalize(cand)
        if norm_cand in segment_lookup:
            return segment_lookup[norm_cand]

    # Some exports run words together with no space at all (e.g. "OutboundTime"
    # for "Outbound Time") — last resort: compare with all whitespace stripped.
    def _no_space(s):
        return _normalize(s).replace(" ", "")

    nospace_lookup = {_no_space(c.split("/")[0]).rstrip("."): c for c in columns}
    for cand in candidates:
        norm_cand = _no_space(cand)
        if norm_cand in nospace_lookup:
            return nospace_lookup[norm_cand]
    return None


SKU_BLOCK_RE = re.compile(r"^SKU\s*(\d+)\s*[\r\n]+(.+)$", re.IGNORECASE)


def has_sku_blocks(columns):
    """True if columns follow the repeated 'SKU 1\\nSKU', 'SKU 1\\nOutbound Qty',
    'SKU 2\\nSKU', ... wide-block pattern some WMS exports use (one order per row,
    one column-group per line item, up to N SKU slots)."""
    return any(SKU_BLOCK_RE.match(str(c)) for c in columns)


def unpivot_sku_blocks(df):
    """Convert a wide 'SKU 1/SKU 2/...' per-row-per-order export into one row per
    (order, SKU line). Non-block columns are carried through unchanged; each block
    contributes a 'SKU', 'Outbound Qty', and (if present) 'Product Name' column.
    Rows where that block's SKU is blank (order used fewer SKU slots) are dropped.
    """
    blocks = {}
    base_cols = []
    for col in df.columns:
        m = SKU_BLOCK_RE.match(str(col))
        if not m:
            base_cols.append(col)
            continue
        block_num, field = m.group(1), m.group(2)
        blocks.setdefault(block_num, {})[field] = col

    def _first_segment(field_name):
        # Bilingual headers look like "Outbound Qty/出库数量" — compare on the
        # English label before the slash, not the full bilingual string.
        return _normalize(str(field_name).split("/")[0])

    def _find_field(fields, candidates):
        for field_name in fields:
            if _first_segment(field_name) in candidates:
                return field_name
        return None

    parts = []
    for block_num, fields in blocks.items():
        sku_col = _find_field(fields.keys(), {"sku", "item number"})
        qty_col = _find_field(fields.keys(), {"outbound qty", "shipped qty", "qty"})
        if sku_col is None or qty_col is None:
            continue
        product_col = _find_field(fields.keys(), {"product name"})

        cols_to_take = base_cols + [fields[sku_col], fields[qty_col]]
        rename = {fields[sku_col]: "SKU", fields[qty_col]: "Outbound Qty"}
        if product_col:
            cols_to_take.append(fields[product_col])
            rename[fields[product_col]] = "Product Name"

        part = df[cols_to_take].rename(columns=rename)
        part = part[part["SKU"].notna() & (part["SKU"].astype(str).str.strip() != "")]
        parts.append(part)

    if not parts:
        return df.iloc[0:0]
    return pd.concat(parts, ignore_index=True)


ROW_COLOR_STYLES = {
    "red": {"bg_color": "#FFC7CE", "font_color": "#9C0006"},
    "green": {"bg_color": "#C6EFCE", "font_color": "#006100"},
    "amber": {"bg_color": "#FFD966"},
}


def to_excel_bytes(sheet_dict, row_colors=None):
    """Write {sheet_name: DataFrame} to an xlsx file in memory.

    row_colors: optional {sheet_name: list of 'red'/'green'/'amber'/None,
    aligned to the DataFrame's rows} for named highlight styles.
    """
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
        workbook = writer.book
        color_formats = {key: workbook.add_format(style) for key, style in ROW_COLOR_STYLES.items()}
        bold = workbook.add_format({"bold": True})

        for sheet_name, df in sheet_dict.items():
            safe_name = sheet_name[:31]
            df.to_excel(writer, sheet_name=safe_name, index=False)
            worksheet = writer.sheets[safe_name]
            worksheet.set_row(0, None, bold)

            colors = None
            if row_colors and sheet_name in row_colors:
                colors = row_colors[sheet_name]
            if colors is not None:
                for row_idx, color_key in enumerate(colors):
                    fmt = color_formats.get(color_key) if color_key else None
                    if fmt is None:
                        continue
                    for col_idx in range(len(df.columns)):
                        value = df.iat[row_idx, col_idx]
                        if pd.isna(value):
                            worksheet.write_blank(row_idx + 1, col_idx, None, fmt)
                        else:
                            worksheet.write(row_idx + 1, col_idx, value, fmt)

    return output.getvalue()
