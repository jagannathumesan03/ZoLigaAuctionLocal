import os
import shutil
import uuid
from typing import Optional

from fastapi import APIRouter, Request, Depends, HTTPException, UploadFile, File, Form

from backend.database import (
    db_cursor,
    rows_to_list,
    row_to_dict,
    enrich_players,
    squad_completion_reserve,
    max_spendable,
    TEAM_SLOTS,
)
from backend.auth import require_admin, require_any, hash_team_password

router = APIRouter(prefix="/api/teams", tags=["teams"])

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "static", "uploads", "teams")
UPLOAD_DIR = os.path.abspath(UPLOAD_DIR)


def save_team_upload(upload: Optional[UploadFile]) -> Optional[str]:
    """Save a team image upload; return public URL or None if nothing uploaded."""
    if not upload or not upload.filename:
        return None
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(upload.filename)[1] or ".png"
    fname = f"{uuid.uuid4().hex}{ext}"
    dest = os.path.join(UPLOAD_DIR, fname)
    with open(dest, "wb") as f:
        shutil.copyfileobj(upload.file, f)
    return f"/static/uploads/teams/{fname}"


def team_with_squad(cur, team_row) -> dict:
    team = dict(team_row)
    has_password = bool(team.pop("owner_password", None))
    team["has_owner_password"] = has_password
    cur.execute("SELECT * FROM players WHERE team_id = ? ORDER BY sold_price DESC", (team["id"],))
    squad = enrich_players(rows_to_list(cur.fetchall()))
    team["squad"] = squad
    team["slots_filled"] = len(squad)
    team["slots_remaining"] = max(0, team["slots_max"] - len(squad))
    team["max_spend_reserve"] = squad_completion_reserve(team["slots_remaining"])
    team["max_spend"] = max_spendable(
        team["purse_remaining"],
        team["slots_max"],
        len(squad),
    )
    return team


@router.get("")
def list_teams(request: Request, _=Depends(require_any)):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM teams ORDER BY name")
        teams = [team_with_squad(cur, r) for r in cur.fetchall()]
    return teams


@router.get("/public")
def list_teams_public():
    """Jersey-order page: kit preview fields only, no purse/squad/passwords."""
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT id, name, logo_url, jersey_front_url, jersey_back_url
            FROM teams
            ORDER BY name
            """
        )
        return rows_to_list(cur.fetchall())


@router.get("/{team_id}")
def get_team(team_id: int, request: Request, _=Depends(require_any)):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM teams WHERE id = ?", (team_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Team not found")
        return team_with_squad(cur, row)


@router.post("")
def create_team(
    request: Request,
    name: str = Form(...),
    purse_total: int = Form(...),
    slots_max: int = Form(TEAM_SLOTS),
    owner_password: str = Form(""),
    logo: Optional[UploadFile] = File(None),
    jersey_front: Optional[UploadFile] = File(None),
    jersey_back: Optional[UploadFile] = File(None),
    _=Depends(require_admin),
):
    logo_url = save_team_upload(logo) or ""
    jersey_front_url = save_team_upload(jersey_front) or ""
    jersey_back_url = save_team_upload(jersey_back) or ""

    with db_cursor() as cur:
        try:
            password_hash = hash_team_password(owner_password) if owner_password.strip() else ""
            cur.execute(
                """INSERT INTO teams
                   (name, logo_url, jersey_front_url, jersey_back_url, purse_total, purse_remaining, slots_max, owner_password)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (name, logo_url, jersey_front_url, jersey_back_url, purse_total, purse_total, slots_max, password_hash),
            )
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not create team: {e}")
        team_id = cur.lastrowid
        cur.execute("SELECT * FROM teams WHERE id = ?", (team_id,))
        return team_with_squad(cur, cur.fetchone())


@router.put("/{team_id}")
def update_team(
    team_id: int,
    request: Request,
    name: str = Form(...),
    purse_total: int = Form(...),
    slots_max: int = Form(TEAM_SLOTS),
    owner_password: str = Form(""),
    logo: Optional[UploadFile] = File(None),
    jersey_front: Optional[UploadFile] = File(None),
    jersey_back: Optional[UploadFile] = File(None),
    _=Depends(require_admin),
):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM teams WHERE id = ?", (team_id,))
        existing = cur.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Team not found")

        # adjust remaining purse proportionally to any change in total
        spent = existing["purse_total"] - existing["purse_remaining"]
        new_remaining = max(purse_total - spent, 0)

        logo_url = existing["logo_url"] or ""
        jersey_front_url = (existing["jersey_front_url"] if "jersey_front_url" in existing.keys() else "") or ""
        jersey_back_url = (existing["jersey_back_url"] if "jersey_back_url" in existing.keys() else "") or ""

        new_logo = save_team_upload(logo)
        if new_logo:
            logo_url = new_logo
        new_front = save_team_upload(jersey_front)
        if new_front:
            jersey_front_url = new_front
        new_back = save_team_upload(jersey_back)
        if new_back:
            jersey_back_url = new_back

        if owner_password.strip():
            cur.execute(
                """UPDATE teams
                   SET name=?, logo_url=?, jersey_front_url=?, jersey_back_url=?,
                       purse_total=?, purse_remaining=?, slots_max=?, owner_password=?
                   WHERE id=?""",
                (name, logo_url, jersey_front_url, jersey_back_url, purse_total, new_remaining, slots_max, hash_team_password(owner_password), team_id),
            )
        else:
            cur.execute(
                """UPDATE teams
                   SET name=?, logo_url=?, jersey_front_url=?, jersey_back_url=?,
                       purse_total=?, purse_remaining=?, slots_max=?
                   WHERE id=?""",
                (name, logo_url, jersey_front_url, jersey_back_url, purse_total, new_remaining, slots_max, team_id),
            )
        cur.execute("SELECT * FROM teams WHERE id = ?", (team_id,))
        return team_with_squad(cur, cur.fetchone())


@router.delete("/{team_id}")
def delete_team(team_id: int, request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        cur.execute("SELECT COUNT(*) as c FROM players WHERE team_id = ?", (team_id,))
        if cur.fetchone()["c"] > 0:
            raise HTTPException(status_code=400, detail="Cannot delete a team with assigned players. Unassign players first.")
        cur.execute("DELETE FROM teams WHERE id = ?", (team_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Team not found")
    return {"ok": True}
