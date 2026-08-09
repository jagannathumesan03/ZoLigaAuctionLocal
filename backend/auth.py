"""Session-based auth for admin and viewer roles."""
import os
from fastapi import Request, HTTPException

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
VIEWER_PASSWORD = os.environ.get("VIEWER_PASSWORD", "viewer123")


def check_admin_credentials(username: str, password: str) -> bool:
    return username == ADMIN_USERNAME and password == ADMIN_PASSWORD


def check_viewer_credentials(password: str) -> bool:
    return password == VIEWER_PASSWORD


def require_role(request: Request, allowed: set[str]):
    role = request.session.get("role")
    if role not in allowed:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return role


def require_admin(request: Request):
    return require_role(request, {"admin"})


def require_any(request: Request):
    return require_role(request, {"admin", "viewer"})
