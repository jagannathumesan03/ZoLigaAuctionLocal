import os

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

import asyncio

from backend.database import init_db
from backend.sse import event_stream
from backend.routers import auth_routes, players, teams, auction, settings
from backend.routers.auction import auction_timer_loop

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
SECRET_KEY = os.environ.get("SESSION_SECRET", "football-auction-dev-secret-change-me")

app = FastAPI(title="Football Auction")

app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, same_site="lax")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

app.include_router(auth_routes.router)
app.include_router(players.router)
app.include_router(teams.router)
app.include_router(auction.router)
app.include_router(settings.router)


@app.on_event("startup")
async def on_startup():
    init_db()
    asyncio.create_task(auction_timer_loop())


@app.get("/api/events")
async def sse_endpoint(request: Request):
    # See the Catalyst variant's version of this endpoint for why these
    # headers matter: some hosts front the app with a buffering proxy that
    # holds back SSE bytes without them, making updates look "stuck" until
    # a manual refresh.
    return StreamingResponse(
        event_stream(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/")
def root():
    return RedirectResponse(url="/login")


@app.get("/login")
def login_page():
    return FileResponse(os.path.join(TEMPLATES_DIR, "login.html"))


@app.get("/admin")
def admin_page():
    return FileResponse(os.path.join(TEMPLATES_DIR, "admin.html"))


@app.get("/viewer")
def viewer_page():
    return FileResponse(os.path.join(TEMPLATES_DIR, "viewer.html"))
