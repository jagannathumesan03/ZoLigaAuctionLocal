import csv
import io
import os
import shutil
import uuid
from typing import Optional

from fastapi import APIRouter, Request, Depends, HTTPException, UploadFile, File, Form

from backend.database import (
    db_cursor,
    rows_to_list,
    row_to_dict,
    enrich_player,
    enrich_players,
    clamp_stars,
    clamp_stat,
    stars_from_legacy_stats,
    CARD_STAT_FIELDS,
    PLAYER_BASE_PRICE_CR,
)
from backend.auth import require_admin, require_any

router = APIRouter(prefix="/api/players", tags=["players"])

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
UPLOAD_DIR = os.path.join(PROJECT_ROOT, "static", "uploads", "players")
IMPORT_PHOTOS_DIR = os.path.abspath(
    os.environ.get("IMPORT_PHOTOS_DIR", os.path.join(PROJECT_ROOT, "import", "photos"))
)
ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def save_photo(photo: UploadFile) -> str:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(photo.filename)[1] or ".jpg"
    fname = f"{uuid.uuid4().hex}{ext}"
    dest = os.path.join(UPLOAD_DIR, fname)
    with open(dest, "wb") as f:
        shutil.copyfileobj(photo.file, f)
    return f"/static/uploads/players/{fname}"


def _photo_path_candidates(raw_path: str) -> list[str]:
    raw_path = raw_path.strip().strip('"').strip("'")
    if not raw_path or raw_path.startswith(("http://", "https://", "/static/")):
        return []
    candidates = []
    if os.path.isabs(raw_path):
        candidates.append(os.path.abspath(raw_path))
    else:
        candidates.append(os.path.abspath(os.path.join(IMPORT_PHOTOS_DIR, raw_path)))
        candidates.append(os.path.abspath(os.path.join(PROJECT_ROOT, raw_path)))
    # Preserve order while dropping duplicates.
    seen = set()
    unique = []
    for path in candidates:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def resolve_photo_source(raw_path: str) -> Optional[str]:
    for path in _photo_path_candidates(raw_path):
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(path)[1].lower()
        if ext in ALLOWED_IMAGE_EXTS:
            return path
    return None


def save_photo_from_path(raw_path: str) -> str:
    source = resolve_photo_source(raw_path)
    if not source:
        raise ValueError(f"Photo not found or unsupported type: {raw_path}")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(source)[1].lower() or ".jpg"
    fname = f"{uuid.uuid4().hex}{ext}"
    dest = os.path.join(UPLOAD_DIR, fname)
    shutil.copy2(source, dest)
    return f"/static/uploads/players/{fname}"


def csv_photo_path(row: dict) -> str:
    for key in ("photo_path", "photo", "photo_file", "photo_location"):
        value = (row.get(key) or "").strip()
        if value:
            return value
    return ""


@router.get("")
def list_players(
    request: Request,
    search: str = "",
    status: str = "",
    role: str = "",
    _=Depends(require_any),
):
    query = "SELECT p.*, t.name as team_name FROM players p LEFT JOIN teams t ON p.team_id = t.id WHERE 1=1"
    params = []
    if search:
        query += " AND (p.name LIKE ? OR p.role LIKE ?)"
        params.extend([f"%{search}%", f"%{search}%"])
    if status:
        query += " AND p.status = ?"
        params.append(status)
    if role:
        query += " AND p.role = ?"
        params.append(role)
    query += " ORDER BY p.name"
    with db_cursor() as cur:
        cur.execute(query, params)
        return enrich_players(rows_to_list(cur.fetchall()))


@router.get("/{player_id}")
def get_player(player_id: int, request: Request, _=Depends(require_any)):
    with db_cursor() as cur:
        cur.execute(
            "SELECT p.*, t.name as team_name FROM players p LEFT JOIN teams t ON p.team_id = t.id WHERE p.id = ?",
            (player_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")
        return enrich_player(dict(row))


@router.post("")
def create_player(
    request: Request,
    name: str = Form(...),
    role: str = Form(""),
    base_price: int = Form(PLAYER_BASE_PRICE_CR),
    stats: str = Form(""),
    stars: float = Form(3.0),
    photo: Optional[UploadFile] = File(None),
    _=Depends(require_admin),
):
    photo_url = save_photo(photo) if (photo and photo.filename) else ""
    star_rating = clamp_stars(stars)
    with db_cursor() as cur:
        cur.execute(
            """INSERT INTO players
               (name, photo_url, role, base_price, stats, status, stars)
               VALUES (?, ?, ?, ?, ?, 'waiting', ?)""",
            (name, photo_url, role, base_price, stats, star_rating),
        )
        player_id = cur.lastrowid
        cur.execute("SELECT * FROM players WHERE id = ?", (player_id,))
        return enrich_player(row_to_dict(cur.fetchone()))


@router.put("/{player_id}")
def update_player(
    player_id: int,
    request: Request,
    name: str = Form(...),
    role: str = Form(""),
    base_price: int = Form(PLAYER_BASE_PRICE_CR),
    stats: str = Form(""),
    stars: float = Form(3.0),
    photo: Optional[UploadFile] = File(None),
    _=Depends(require_admin),
):
    star_rating = clamp_stars(stars)
    with db_cursor() as cur:
        cur.execute("SELECT * FROM players WHERE id = ?", (player_id,))
        existing = cur.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Player not found")
        photo_url = existing["photo_url"]
        if photo and photo.filename:
            photo_url = save_photo(photo)
        cur.execute(
            """UPDATE players
               SET name=?, photo_url=?, role=?, base_price=?, stats=?, stars=?
               WHERE id=?""",
            (name, photo_url, role, base_price, stats, star_rating, player_id),
        )
        cur.execute("SELECT * FROM players WHERE id = ?", (player_id,))
        return enrich_player(row_to_dict(cur.fetchone()))


@router.delete("/{player_id}")
def delete_player(player_id: int, request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        cur.execute("DELETE FROM players WHERE id = ?", (player_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Player not found")
    return {"ok": True}


@router.post("/bulk-csv")
async def bulk_upload_csv(request: Request, file: UploadFile = File(...), _=Depends(require_admin)):
    content = await file.read()
    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    created = 0
    photos_imported = 0
    errors = []
    with db_cursor() as cur:
        for i, row in enumerate(reader, start=2):
            name = (row.get("name") or "").strip()
            if not name:
                errors.append(f"Row {i}: missing name")
                continue
            role = (row.get("role") or "").strip()
            stats = (row.get("stats") or "").strip()
            try:
                base_price = int(float(row.get("base_price") or PLAYER_BASE_PRICE_CR))
            except ValueError:
                base_price = PLAYER_BASE_PRICE_CR
            if base_price <= 0:
                base_price = PLAYER_BASE_PRICE_CR
            if (row.get("stars") or "").strip():
                star_rating = clamp_stars(row.get("stars"), 3.0)
            elif any((row.get(f) or "").strip() for f in CARD_STAT_FIELDS):
                star_rating = stars_from_legacy_stats(
                    {f: clamp_stat(row.get(f)) for f in CARD_STAT_FIELDS}
                )
            else:
                star_rating = 3.0
            photo_url = ""
            photo_path_raw = csv_photo_path(row)
            if photo_path_raw:
                try:
                    photo_url = save_photo_from_path(photo_path_raw)
                    photos_imported += 1
                except ValueError as exc:
                    errors.append(f"Row {i} ({name}): {exc}")
            cur.execute(
                """INSERT INTO players
                   (name, photo_url, role, base_price, stats, status, stars)
                   VALUES (?, ?, ?, ?, ?, 'waiting', ?)""",
                (name, photo_url, role, base_price, stats, star_rating),
            )
            created += 1
    return {"created": created, "photos_imported": photos_imported, "errors": errors}
