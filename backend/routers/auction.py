from fastapi import APIRouter, Request, Depends, HTTPException
from pydantic import BaseModel

from backend.database import db_cursor, row_to_dict, rows_to_list, enrich_player
from backend.auth import require_admin, require_any
from backend.sse import broadcaster

router = APIRouter(prefix="/api/auction", tags=["auction"])


class AssignBody(BaseModel):
    player_id: int
    team_id: int
    sold_price: int


class PlayerIdBody(BaseModel):
    player_id: int


class BidBody(BaseModel):
    player_id: int
    team_id: int
    amount: int


class CallBody(BaseModel):
    player_id: int
    call: str  # "going_once" | "going_twice"


def full_player(cur, player_id):
    cur.execute(
        """
        SELECT p.*, t.name as team_name, bt.name as current_bid_team_name
        FROM players p
        LEFT JOIN teams t ON p.team_id = t.id
        LEFT JOIN teams bt ON p.current_bid_team_id = bt.id
        WHERE p.id = ?
        """,
        (player_id,),
    )
    return enrich_player(row_to_dict(cur.fetchone()))


def get_bid_history(cur, player_id):
    cur.execute(
        """
        SELECT b.id, b.player_id, b.team_id, t.name as team_name, b.amount, b.created_at
        FROM bid_history b
        LEFT JOIN teams t ON b.team_id = t.id
        WHERE b.player_id = ?
        ORDER BY b.id ASC
        """,
        (player_id,),
    )
    return rows_to_list(cur.fetchall())


def clear_bid_state(cur, player_id):
    cur.execute(
        "UPDATE players SET current_bid_amount=NULL, current_bid_team_id=NULL WHERE id=?",
        (player_id,),
    )
    cur.execute("DELETE FROM bid_history WHERE player_id=?", (player_id,))


@router.get("/current")
def current_player(request: Request, _=Depends(require_any)):
    with db_cursor() as cur:
        cur.execute("SELECT id FROM players WHERE status = 'auction' LIMIT 1")
        row = cur.fetchone()
        if not row:
            return None
        player = full_player(cur, row["id"])
        player["history"] = get_bid_history(cur, row["id"])
        return player


@router.post("/set-current")
async def set_current(body: PlayerIdBody, request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM players WHERE id = ?", (body.player_id,))
        player = cur.fetchone()
        if not player:
            raise HTTPException(status_code=404, detail="Player not found")
        if player["status"] == "sold":
            raise HTTPException(status_code=400, detail="Player already sold")

        # clear any other player currently marked as 'auction' and its bid state
        cur.execute("SELECT id FROM players WHERE status = 'auction'")
        for prev in cur.fetchall():
            clear_bid_state(cur, prev["id"])
        cur.execute("UPDATE players SET status = 'waiting' WHERE status = 'auction'")

        # fresh bid state for the newly selected player, starting at base price
        clear_bid_state(cur, body.player_id)
        cur.execute(
            "UPDATE players SET status = 'auction', current_bid_amount = base_price WHERE id = ?",
            (body.player_id,),
        )
        result = full_player(cur, body.player_id)
        result["history"] = get_bid_history(cur, body.player_id)

    await broadcaster.publish("current_player", result)
    return result


@router.post("/bid")
async def place_bid(body: BidBody, request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM players WHERE id = ?", (body.player_id,))
        player = cur.fetchone()
        if not player:
            raise HTTPException(status_code=404, detail="Player not found")
        if player["status"] != "auction":
            raise HTTPException(status_code=400, detail="This player is not currently up for auction")

        cur.execute("SELECT * FROM teams WHERE id = ?", (body.team_id,))
        team = cur.fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        cur.execute("SELECT COUNT(*) as c FROM players WHERE team_id = ?", (body.team_id,))
        filled = cur.fetchone()["c"]
        if filled >= team["slots_max"]:
            raise HTTPException(status_code=400, detail=f"{team['name']} already has {team['slots_max']} players and can't bid")

        current_amount = player["current_bid_amount"] or player["base_price"]
        if body.amount <= current_amount:
            raise HTTPException(status_code=400, detail=f"Bid must be higher than the current bid of {current_amount}")

        cur.execute(
            "INSERT INTO bid_history (player_id, team_id, amount) VALUES (?, ?, ?)",
            (body.player_id, body.team_id, body.amount),
        )
        cur.execute(
            "UPDATE players SET current_bid_amount=?, current_bid_team_id=? WHERE id=?",
            (body.amount, body.team_id, body.player_id),
        )
        result = full_player(cur, body.player_id)
        result["history"] = get_bid_history(cur, body.player_id)

    await broadcaster.publish("bid_updated", result)
    return result


@router.post("/assign")
async def assign_player(body: AssignBody, request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM players WHERE id = ?", (body.player_id,))
        player = cur.fetchone()
        if not player:
            raise HTTPException(status_code=404, detail="Player not found")

        cur.execute("SELECT * FROM teams WHERE id = ?", (body.team_id,))
        team = cur.fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        cur.execute("SELECT COUNT(*) as c FROM players WHERE team_id = ?", (body.team_id,))
        filled = cur.fetchone()["c"]
        if filled >= team["slots_max"]:
            raise HTTPException(status_code=400, detail=f"{team['name']} already has {team['slots_max']} players")

        if body.sold_price > team["purse_remaining"]:
            raise HTTPException(status_code=400, detail=f"{team['name']} does not have enough purse remaining")

        cur.execute(
            "UPDATE players SET status='sold', sold_price=?, team_id=? WHERE id=?",
            (body.sold_price, body.team_id, body.player_id),
        )
        cur.execute(
            "UPDATE teams SET purse_remaining = purse_remaining - ? WHERE id = ?",
            (body.sold_price, body.team_id),
        )
        clear_bid_state(cur, body.player_id)
        player_result = full_player(cur, body.player_id)

        cur.execute("SELECT * FROM teams WHERE id = ?", (body.team_id,))
        team_result = row_to_dict(cur.fetchone())

    await broadcaster.publish("player_sold", player_result)
    await broadcaster.publish("team_updated", team_result)
    return player_result


@router.post("/unsold")
async def mark_unsold(body: PlayerIdBody, request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM players WHERE id = ?", (body.player_id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Player not found")
        cur.execute("UPDATE players SET status='unsold', team_id=NULL, sold_price=NULL WHERE id=?", (body.player_id,))
        clear_bid_state(cur, body.player_id)
        result = full_player(cur, body.player_id)

    await broadcaster.publish("player_unsold", result)
    return result


@router.post("/call")
async def broadcast_call(body: CallBody, request: Request, _=Depends(require_admin)):
    """Auctioneer's "Going once" / "Going twice" announcement.

    This is a live broadcast cue, not persisted auction state -- there's
    nothing to store in the database, so it's just published over SSE for
    the admin and viewer screens to flash briefly. The frontend clears it a
    few seconds later, or immediately once a new bid/sale/reset event
    arrives for this player (whichever comes first).
    """
    if body.call not in ("going_once", "going_twice"):
        raise HTTPException(status_code=400, detail="call must be 'going_once' or 'going_twice'")
    await broadcaster.publish("auction_call", {"player_id": body.player_id, "call": body.call})
    return {"ok": True}


@router.post("/undo")
async def undo_assignment(body: PlayerIdBody, request: Request, _=Depends(require_admin)):
    """Revert a sold/unsold player back to 'waiting' and refund purse if applicable."""
    with db_cursor() as cur:
        cur.execute("SELECT * FROM players WHERE id = ?", (body.player_id,))
        player = cur.fetchone()
        if not player:
            raise HTTPException(status_code=404, detail="Player not found")

        refunded_team = None
        if player["status"] == "sold" and player["team_id"]:
            cur.execute(
                "UPDATE teams SET purse_remaining = purse_remaining + ? WHERE id = ?",
                (player["sold_price"] or 0, player["team_id"]),
            )
            cur.execute("SELECT * FROM teams WHERE id = ?", (player["team_id"],))
            refunded_team = row_to_dict(cur.fetchone())

        cur.execute("UPDATE players SET status='waiting', team_id=NULL, sold_price=NULL WHERE id=?", (body.player_id,))
        clear_bid_state(cur, body.player_id)
        result = full_player(cur, body.player_id)

    await broadcaster.publish("player_reset", result)
    if refunded_team:
        await broadcaster.publish("team_updated", refunded_team)
    return result
