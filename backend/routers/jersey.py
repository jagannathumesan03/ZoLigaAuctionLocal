import csv
import io
import json
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel

from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import Response

from backend.database import db_cursor, rows_to_list
from backend.auth import require_admin
from backend.sse import broadcaster
from backend.routers.settings import get_jersey_sizes, get_shorts_sizes, get_jersey_form_fields

router = APIRouter(prefix="/api/jersey-orders", tags=["jersey"])


class JerseyOrderBody(BaseModel):
    team_id: int
    player_name: str = ""
    jersey_number: str = ""
    size: str = ""
    shorts_size: str = ""
    want_shorts: bool = False
    want_print: bool = False
    extra_fields: Optional[dict] = None


def _parse_extra_fields(raw) -> dict:
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return {str(k): "" if v is None else str(v) for k, v in data.items()}
    except (json.JSONDecodeError, TypeError):
        pass
    return {}


def _enrich_order(row) -> dict:
    order = dict(row)
    order["extra_fields"] = _parse_extra_fields(order.get("extra_fields"))
    return order


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
    return _enrich_order(row) if row else None


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
    return [_enrich_order(r) for r in cur.fetchall()]


@router.get("")
def list_jersey_orders(request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        return _list_orders(cur)


@router.get("/export")
def export_jersey_orders_csv(request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        orders = _list_orders(cur)
        fields = get_jersey_form_fields(cur)

    custom_defs = fields.get("custom") or []
    custom_ids = [c["id"] for c in custom_defs]
    # Include any leftover keys from saved orders so history isn't lost.
    seen = set(custom_ids)
    for o in orders:
        for key in (o.get("extra_fields") or {}):
            if key not in seen:
                custom_ids.append(key)
                seen.add(key)
    label_by_id = {c["id"]: c["label"] for c in custom_defs}

    buf = io.StringIO()
    writer = csv.writer(buf)
    header = ["when", "team", "name", "number", "size", "shorts_size"] + [
        label_by_id.get(cid, cid) for cid in custom_ids
    ]
    writer.writerow(header)
    for o in orders:
        extras = o.get("extra_fields") or {}
        row = [
            o.get("created_at") or "",
            o.get("team_name") or "",
            o.get("player_name") or "",
            o.get("jersey_number") or "",
            o.get("size") or "",
            o.get("shorts_size") or "",
        ]
        row.extend(extras.get(cid, "") for cid in custom_ids)
        writer.writerow(row)

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
    submitted_by = (
        request.session.get("username")
        or request.session.get("role")
        or "anonymous"
    )

    with db_cursor() as cur:
        fields = get_jersey_form_fields(cur)
        name = (body.player_name or "").strip()
        number = (body.jersey_number or "").strip()
        raw_size = (body.size or "").strip()
        raw_shorts = (body.shorts_size or "").strip()
        want_shorts = bool(body.want_shorts) or bool(raw_shorts)
        want_print = bool(body.want_print) or bool(name) or bool(number)
        incoming_extra = body.extra_fields if isinstance(body.extra_fields, dict) else {}

        if not fields["player_name"]["enabled"] or not want_print:
            name = ""
        elif fields["player_name"]["required"] and not name:
            raise HTTPException(status_code=400, detail="Player name is required")

        if not fields["jersey_number"]["enabled"] or not want_print:
            number = ""
        elif fields["jersey_number"]["required"] and not number:
            raise HTTPException(status_code=400, detail="Jersey number is required")

        if want_print and fields["player_name"]["enabled"] and fields["jersey_number"]["enabled"]:
            name_req = fields["player_name"]["required"]
            number_req = fields["jersey_number"]["required"]
            if not name_req and not number_req and not name and not number:
                raise HTTPException(status_code=400, detail="Enter a name, a number, or both")

        size = ""
        if fields["size"]["enabled"]:
            if fields["size"]["required"] and not raw_size:
                raise HTTPException(status_code=400, detail="Choose a jersey size")
            if raw_size:
                allowed = get_jersey_sizes(cur)
                size = _canonical_size(allowed, raw_size)
                if not size:
                    raise HTTPException(status_code=400, detail="Choose a valid jersey size")

        shorts_size = ""
        if want_shorts:
            if not raw_shorts:
                raise HTTPException(status_code=400, detail="Choose a shorts size")
            allowed_shorts = get_shorts_sizes(cur)
            shorts_size = _canonical_size(allowed_shorts, raw_shorts)
            if not shorts_size:
                raise HTTPException(status_code=400, detail="Choose a valid shorts size")

        if not body.team_id:
            raise HTTPException(status_code=400, detail="Select a team first")

        extra = {}
        for custom in fields.get("custom") or []:
            if not custom.get("enabled"):
                continue
            field_id = custom["id"]
            label = custom.get("label") or field_id
            value = str(incoming_extra.get(field_id, "") or "").strip()
            if custom.get("required") and not value:
                raise HTTPException(status_code=400, detail=f"{label} is required")
            if value:
                extra[field_id] = value

        cur.execute("SELECT id FROM teams WHERE id = ?", (body.team_id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Team not found")
        cur.execute(
            """
            INSERT INTO jersey_orders
              (team_id, player_name, jersey_number, size, shorts_size, extra_fields, submitted_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (body.team_id, name, number, size, shorts_size, json.dumps(extra), submitted_by),
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
