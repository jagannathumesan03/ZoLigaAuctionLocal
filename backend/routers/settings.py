import json
import os
import shutil
import uuid
from typing import Optional

from fastapi import APIRouter, Request, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel

from backend.database import (
    db_cursor,
    get_auction_timer_seconds,
    is_auction_timer_enabled,
    get_setting,
    set_setting,
)
from backend.auth import require_admin, require_any
from backend.sse import broadcaster

router = APIRouter(prefix="/api/settings", tags=["settings"])

UPLOAD_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "static", "uploads", "branding")
)
WAITING_BG_KEY = "waiting_background_url"
SIZE_CHART_KEY = "jersey_size_chart_url"
JERSEY_SIZES_KEY = "jersey_sizes"
JERSEY_FIELDS_KEY = "jersey_form_fields"
DEFAULT_JERSEY_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "3XL"]
DEFAULT_JERSEY_FIELDS = {
    "team": {"enabled": True, "required": True},
    "player_name": {"enabled": True, "required": False},
    "jersey_number": {"enabled": True, "required": False},
    "size": {"enabled": True, "required": True},
    "custom": [],
    "order": ["team", "player_name", "jersey_number", "size"],
}
JERSEY_FIELD_KEYS = ("team", "player_name", "jersey_number", "size")


class SettingsBody(BaseModel):
    auction_timer_seconds: int
    auction_timer_enabled: bool = True
    jersey_sizes: Optional[list[str]] = None
    jersey_form_fields: Optional[dict] = None


def parse_jersey_sizes(raw: str) -> list[str]:
    text = (raw or "").strip()
    if not text:
        return list(DEFAULT_JERSEY_SIZES)
    try:
        data = json.loads(text)
        if isinstance(data, list):
            sizes = [str(item).strip() for item in data if str(item).strip()]
            if sizes:
                return sizes
    except json.JSONDecodeError:
        pass
    sizes = [part.strip() for part in text.replace("\n", ",").split(",") if part.strip()]
    return sizes or list(DEFAULT_JERSEY_SIZES)


def get_jersey_sizes(cur) -> list[str]:
    return parse_jersey_sizes(get_setting(cur, JERSEY_SIZES_KEY, "") or "")


def _slug_field_id(label: str, used: set[str]) -> str:
    base = "".join(ch.lower() if ch.isalnum() else "_" for ch in (label or "field")).strip("_")
    base = base or "field"
    candidate = base[:40]
    n = 2
    while candidate in used:
        candidate = f"{base[:36]}_{n}"
        n += 1
    used.add(candidate)
    return candidate


def _normalize_field_order(raw_order, known_keys: list[str]) -> list[str]:
    known = list(known_keys)
    known_set = set(known)
    result = []
    if isinstance(raw_order, list):
        for item in raw_order:
            key = str(item or "").strip()
            if key in known_set and key not in result:
                result.append(key)
    for key in known:
        if key not in result:
            result.append(key)
    return result


def normalize_jersey_form_fields(raw) -> dict:
    """Merge stored config with defaults. Team is always enabled + required."""
    base = {key: dict(value) for key, value in DEFAULT_JERSEY_FIELDS.items() if key not in ("custom", "order")}
    base["custom"] = []
    data = raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            base["order"] = list(DEFAULT_JERSEY_FIELDS["order"])
            return base
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            base["order"] = list(DEFAULT_JERSEY_FIELDS["order"])
            return base
    if not isinstance(data, dict):
        base["order"] = list(DEFAULT_JERSEY_FIELDS["order"])
        return base
    for key in JERSEY_FIELD_KEYS:
        item = data.get(key)
        if not isinstance(item, dict):
            continue
        enabled = bool(item.get("enabled", base[key]["enabled"]))
        required = bool(item.get("required", base[key]["required"]))
        if key == "team":
            enabled = True
            required = True
        if not enabled:
            required = False
        base[key] = {"enabled": enabled, "required": required}

    custom_raw = data.get("custom")
    custom = []
    used_ids: set[str] = set()
    if isinstance(custom_raw, list):
        for item in custom_raw:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or "").strip()
            if not label:
                continue
            field_id = str(item.get("id") or "").strip()
            if not field_id or field_id in used_ids or field_id in JERSEY_FIELD_KEYS:
                field_id = _slug_field_id(label, used_ids)
            else:
                used_ids.add(field_id)
            enabled = bool(item.get("enabled", True))
            required = bool(item.get("required", False)) if enabled else False
            custom.append({
                "id": field_id,
                "label": label[:80],
                "enabled": enabled,
                "required": required,
            })
    base["custom"] = custom
    known_order = list(JERSEY_FIELD_KEYS) + [f"custom:{c['id']}" for c in custom]
    base["order"] = _normalize_field_order(data.get("order"), known_order)
    return base


def get_jersey_form_fields(cur) -> dict:
    return normalize_jersey_form_fields(get_setting(cur, JERSEY_FIELDS_KEY, "") or "")


def _read_settings(cur):
    return {
        "auction_timer_seconds": get_auction_timer_seconds(cur),
        "auction_timer_enabled": is_auction_timer_enabled(cur),
        "waiting_background_url": get_setting(cur, WAITING_BG_KEY, "") or "",
        "jersey_size_chart_url": get_setting(cur, SIZE_CHART_KEY, "") or "",
        "jersey_sizes": get_jersey_sizes(cur),
        "jersey_form_fields": get_jersey_form_fields(cur),
    }


def _clear_live_timer(cur):
    """If a player is mid-auction, drop the countdown when the timer is disabled."""
    cur.execute(
        """
        UPDATE players
        SET auction_ends_at=NULL,
            auction_timer_paused=0,
            auction_remaining_seconds=NULL
        WHERE status = 'auction'
        """
    )


def _delete_local_file(url):
    if not url or not url.startswith("/static/uploads/branding/"):
        return
    path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", url.lstrip("/"))
    )
    # Stay inside the branding uploads folder.
    if not path.startswith(UPLOAD_DIR + os.sep):
        return
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


def _save_branding_upload(photo: UploadFile, prefix: str) -> str:
    filename = photo.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    content_type = (photo.content_type or "").lower()
    allowed_ext = (".jpg", ".jpeg", ".png", ".webp", ".gif")
    looks_like_image = content_type.startswith("image/") or ext in allowed_ext
    if not looks_like_image:
        raise HTTPException(status_code=400, detail="Please upload an image file (JPG, PNG, WebP, or GIF)")
    if ext not in allowed_ext:
        ext = ".jpg"
    try:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Cannot create upload folder: {exc}") from exc
    fname = f"{prefix}-{uuid.uuid4().hex}{ext}"
    dest = os.path.join(UPLOAD_DIR, fname)
    try:
        with open(dest, "wb") as f:
            shutil.copyfileobj(photo.file, f)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Cannot save upload: {exc}") from exc
    return f"/static/uploads/branding/{fname}"


@router.get("")
def get_settings(request: Request, _=Depends(require_any)):
    with db_cursor() as cur:
        return _read_settings(cur)


@router.get("/jersey-public")
def get_jersey_public_settings():
    """Public jersey page: sizes, size chart, and form field rules."""
    with db_cursor() as cur:
        return {
            "jersey_size_chart_url": get_setting(cur, SIZE_CHART_KEY, "") or "",
            "jersey_sizes": get_jersey_sizes(cur),
            "jersey_form_fields": get_jersey_form_fields(cur),
        }


@router.put("")
async def update_settings(body: SettingsBody, request: Request, _=Depends(require_admin)):
    seconds = int(body.auction_timer_seconds)
    if seconds < 5 or seconds > 60 * 60:
        raise HTTPException(status_code=400, detail="Timer must be between 5 seconds and 60 minutes")
    with db_cursor() as cur:
        set_setting(cur, "auction_timer_seconds", seconds)
        set_setting(cur, "auction_timer_enabled", "1" if body.auction_timer_enabled else "0")
        if body.jersey_sizes is not None:
            sizes = [str(item).strip() for item in body.jersey_sizes if str(item).strip()]
            if not sizes:
                raise HTTPException(status_code=400, detail="Add at least one jersey size")
            set_setting(cur, JERSEY_SIZES_KEY, json.dumps(sizes))
        if body.jersey_form_fields is not None:
            fields = normalize_jersey_form_fields(body.jersey_form_fields)
            set_setting(cur, JERSEY_FIELDS_KEY, json.dumps(fields))
        if not body.auction_timer_enabled:
            _clear_live_timer(cur)
        result = _read_settings(cur)
    await broadcaster.publish("settings_updated", result)
    return result


@router.post("/waiting-background")
async def upload_waiting_background(
    request: Request,
    photo: UploadFile = File(...),
    _=Depends(require_admin),
):
    url = _save_branding_upload(photo, "waiting-bg")
    with db_cursor() as cur:
        old = get_setting(cur, WAITING_BG_KEY, "") or ""
        set_setting(cur, WAITING_BG_KEY, url)
        result = _read_settings(cur)
    if old and old != url:
        _delete_local_file(old)
    await broadcaster.publish("settings_updated", result)
    return result


@router.delete("/waiting-background")
async def clear_waiting_background(request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        old = get_setting(cur, WAITING_BG_KEY, "") or ""
        set_setting(cur, WAITING_BG_KEY, "")
        result = _read_settings(cur)
    if old:
        _delete_local_file(old)
    await broadcaster.publish("settings_updated", result)
    return result


@router.post("/jersey-size-chart")
async def upload_jersey_size_chart(
    request: Request,
    photo: UploadFile = File(...),
    _=Depends(require_admin),
):
    url = _save_branding_upload(photo, "jersey-size-chart")
    with db_cursor() as cur:
        old = get_setting(cur, SIZE_CHART_KEY, "") or ""
        set_setting(cur, SIZE_CHART_KEY, url)
        result = _read_settings(cur)
    if old and old != url:
        _delete_local_file(old)
    await broadcaster.publish("settings_updated", result)
    return result


@router.delete("/jersey-size-chart")
async def clear_jersey_size_chart(request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        old = get_setting(cur, SIZE_CHART_KEY, "") or ""
        set_setting(cur, SIZE_CHART_KEY, "")
        result = _read_settings(cur)
    if old:
        _delete_local_file(old)
    await broadcaster.publish("settings_updated", result)
    return result
