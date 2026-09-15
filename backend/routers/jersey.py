import csv
import io
from datetime import datetime, timezone

from pydantic import BaseModel, Field

from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import Response

from backend.database import db_cursor, rows_to_list
from backend.auth import require_admin
from backend.sse import broadcaster
from backend.routers.settings import get_jersey_sizes

router = APIRouter(prefix="/api/jersey-orders", tags=["jersey"])


class JerseyOrderBody(BaseModel):
    team_id: int
    player_name: str = Field(min_length=1)
    jersey_number: str = ""
    size: str = Field(min_length=1)


def _order_row(cur, order_id: int):
    cur.execute(
        """
        SELECT o.*, t.name AS team_name, t.logo_url AS team_logo_url
        FROM jersey_orders o
        JOIN teams t ON t.id = o.team_id
        WHERE o.id = ?
        """,
        (order_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def _canonical_size(allowed: list[str], raw: str):
    needle = (raw or "").strip().lower()
    if not needle:
        return None
    for size in allowed:
        if size.lower() == needle:
            return size
    return None


def _list_orders(cur):
    cur.execute(
        """
        SELECT o.*, t.name AS team_name, t.logo_url AS team_logo_url
        FROM jersey_orders o
        JOIN teams t ON t.id = o.team_id
        ORDER BY o.created_at DESC, o.id DESC
        """
    )
    return rows_to_list(cur.fetchall())


@router.get("")
def list_jersey_orders(request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        return _list_orders(cur)


@router.get("/export")
def export_jersey_orders_csv(request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        orders = _list_orders(cur)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["when", "team", "name", "number", "size"])
    for o in orders:
        writer.writerow([
            o.get("created_at") or "",
            o.get("team_name") or "",
            o.get("player_name") or "",
            o.get("jersey_number") or "",
            o.get("size") or "",
        ])

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return Response(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="jersey-orders-{stamp}.csv"',
        },
    )


@router.post("")
async def create_jersey_order(body: JerseyOrderBody, request: Request):
    """Public — anyone can submit a jersey order from /jersey (no login)."""
    name = (body.player_name or "").strip()
    number = (body.jersey_number or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Player name is required")

    submitted_by = (
        request.session.get("username")
        or request.session.get("role")
        or "anonymous"
    )

    with db_cursor() as cur:
        allowed = get_jersey_sizes(cur)
        size = _canonical_size(allowed, body.size)
        if not size:
            raise HTTPException(status_code=400, detail="Choose a valid jersey size")
        cur.execute("SELECT id FROM teams WHERE id = ?", (body.team_id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Team not found")
        cur.execute(
            """
            INSERT INTO jersey_orders (team_id, player_name, jersey_number, size, submitted_by)
            VALUES (?, ?, ?, ?, ?)
            """,
            (body.team_id, name, number, size, submitted_by),
        )
        order = _order_row(cur, cur.lastrowid)

    await broadcaster.publish("jersey_order_created", order)
    return order


@router.delete("/{order_id}")
async def delete_jersey_order(order_id: int, request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        cur.execute("DELETE FROM jersey_orders WHERE id = ?", (order_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Jersey order not found")
    await broadcaster.publish("jersey_order_deleted", {"id": order_id})
    return {"ok": True}
