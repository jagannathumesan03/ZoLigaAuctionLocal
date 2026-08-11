"""Session-based auth for admin, viewer, and team-owner roles."""
import hashlib
import os
from fastapi import Request, HTTPException

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
VIEWER_PASSWORD = os.environ.get("VIEWER_PASSWORD", "viewer123")


def hash_team_password(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def check_admin_credentials(username: str, password: str) -> bool:
    return username == ADMIN_USERNAME and password == ADMIN_PASSWORD


def check_viewer_credentials(password: str) -> bool:
    return password == VIEWER_PASSWORD


def find_team_for_password(password: str):
    """Return {id, name} if the password matches a team's owner password."""
    from backend.database import db_cursor

    if not password:
        return None
    digest = hash_team_password(password)
    with db_cursor() as cur:
        cur.execute(
            "SELECT id, name FROM teams WHERE owner_password != '' AND owner_password = ? LIMIT 1",
            (digest,),
        )
        row = cur.fetchone()
        return dict(row) if row else None


def require_role(request: Request, allowed: set[str]):
    role = request.session.get("role")
    if role not in allowed:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return role


def require_admin(request: Request):
    return require_role(request, {"admin"})


def require_any(request: Request):
    return require_role(request, {"admin", "viewer", "team"})


def session_team_id(request: Request):
    if request.session.get("role") != "team":
        return None
    return request.session.get("team_id")
