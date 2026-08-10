import os
import shutil
import uuid

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


class SettingsBody(BaseModel):
    auction_timer_seconds: int
    auction_timer_enabled: bool = True


def _read_settings(cur):
    return {
        "auction_timer_seconds": get_auction_timer_seconds(cur),
        "auction_timer_enabled": is_auction_timer_enabled(cur),
        "waiting_background_url": get_setting(cur, WAITING_BG_KEY, "") or "",
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


@router.get("")
def get_settings(request: Request, _=Depends(require_any)):
    with db_cursor() as cur:
        return _read_settings(cur)


@router.put("")
async def update_settings(body: SettingsBody, request: Request, _=Depends(require_admin)):
    seconds = int(body.auction_timer_seconds)
    if seconds < 5 or seconds > 60 * 60:
        raise HTTPException(status_code=400, detail="Timer must be between 5 seconds and 60 minutes")
    with db_cursor() as cur:
        set_setting(cur, "auction_timer_seconds", seconds)
        set_setting(cur, "auction_timer_enabled", "1" if body.auction_timer_enabled else "0")
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
    if not photo.content_type or not photo.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Please upload an image file")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(photo.filename or "")[1].lower() or ".jpg"
    if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        ext = ".jpg"
    fname = f"waiting-bg-{uuid.uuid4().hex}{ext}"
    dest = os.path.join(UPLOAD_DIR, fname)
    with open(dest, "wb") as f:
        shutil.copyfileobj(photo.file, f)
    url = f"/static/uploads/branding/{fname}"

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
