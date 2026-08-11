from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

from backend.auth import check_admin_credentials, check_viewer_credentials, find_team_for_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


class AdminLogin(BaseModel):
    username: str
    password: str


class ViewerLogin(BaseModel):
    password: str


@router.post("/login/admin")
def login_admin(body: AdminLogin, request: Request):
    if not check_admin_credentials(body.username, body.password):
        raise HTTPException(status_code=401, detail="Invalid admin credentials")
    request.session["role"] = "admin"
    request.session["username"] = body.username
    return {"role": "admin", "username": body.username}


@router.post("/login/viewer")
def login_viewer(body: ViewerLogin, request: Request):
    team = find_team_for_password(body.password)
    if team:
        request.session["role"] = "team"
        request.session["username"] = team["name"]
        request.session["team_id"] = team["id"]
        return {"role": "team", "username": team["name"], "team_id": team["id"]}
    if not check_viewer_credentials(body.password):
        raise HTTPException(status_code=401, detail="Invalid viewer or team password")
    request.session["role"] = "viewer"
    request.session["username"] = "viewer"
    request.session.pop("team_id", None)
    return {"role": "viewer", "username": "viewer"}


@router.post("/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    role = request.session.get("role")
    if not role:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {
        "role": role,
        "username": request.session.get("username"),
        "team_id": request.session.get("team_id"),
    }
