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
)
from backend.auth import require_admin, require_any

router = APIRouter(prefix="/api/players", tags=["players"])

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "static", "uploads", "players")
UPLOAD_DIR = os.path.abspath(UPLOAD_DIR)


def save_photo(photo: UploadFile) -> str:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(photo.filename)[1] or ".jpg"
    fname = f"{uuid.uuid4().hex}{ext}"
    dest = os.path.join(UPLOAD_DIR, fname)
    with open(dest, "wb") as f:
        shutil.copyfileobj(photo.file, f)
    return f"/static/uploads/players/{fname}"


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
    base_price: int = Form(0),
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
    base_price: int = Form(0),
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
                base_price = int(float(row.get("base_price") or 0))
            except ValueError:
                base_price = 0
            if (row.get("stars") or "").strip():
                star_rating = clamp_stars(row.get("stars"), 3.0)
            elif any((row.get(f) or "").strip() for f in CARD_STAT_FIELDS):
                star_rating = stars_from_legacy_stats(
                    {f: clamp_stat(row.get(f)) for f in CARD_STAT_FIELDS}
                )
            else:
                star_rating = 3.0
            cur.execute(
                """INSERT INTO players
                   (name, photo_url, role, base_price, stats, status, stars)
                   VALUES (?, '', ?, ?, ?, 'waiting', ?)""",
                (name, role, base_price, stats, star_rating),
            )
            created += 1
    return {"created": created, "errors": errors}
