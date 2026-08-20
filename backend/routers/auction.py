import asyncio
import random
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Request, Depends, HTTPException
from pydantic import BaseModel

from backend.database import (
    db_cursor,
    row_to_dict,
    rows_to_list,
    enrich_player,
    get_auction_timer_seconds,
    is_auction_timer_enabled,
    max_spendable,
    is_valid_bid_amount,
    next_standard_bid,
    PLAYER_BASE_PRICE_CR,
    BID_STEP_LOW_CR,
    BID_STEP_HIGH_CR,
    BID_HIGH_THRESHOLD_CR,
)
from backend.auth import require_admin, require_any
from backend.sse import broadcaster

router = APIRouter(prefix="/api/auction", tags=["auction"])

# Keep in sync with static/js/pack-reveal.js total duration. The live timer
# does not start counting until this reveal window ends, so the pack animation
# never eats into auction time.
PACK_REVEAL_SECONDS = 5


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


def utc_now():
    return datetime.now(timezone.utc)


def to_iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(value):
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def auction_time_remaining_seconds(player, now=None):
    """Seconds left on the auction clock, ignoring the pack-reveal window."""
    now = now or utc_now()
    if player.get("auction_timer_paused"):
        remaining = player.get("auction_remaining_seconds")
        return max(0, int(remaining or 0))

    ends_at = parse_iso(player.get("auction_ends_at"))
    if not ends_at:
        return 0

    reveal_until = parse_iso(player.get("auction_reveal_until"))
    effective_now = now
    if reveal_until and now < reveal_until:
        effective_now = reveal_until
    return max(0, int((ends_at - effective_now).total_seconds()))


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


def mark_player_unsold(cur, player_id: int):
    """Mark player unsold and stamp queue order for later re-auction."""
    cur.execute(
        """
        UPDATE players
        SET status = 'unsold',
            team_id = NULL,
            sold_price = NULL,
            auction_ends_at = NULL,
            auction_timer_paused = 0,
            auction_remaining_seconds = NULL,
            auction_reveal_until = NULL,
            unsold_at = ?
        WHERE id = ?
        """,
        (to_iso(utc_now()), player_id),
    )
    clear_bid_state(cur, player_id)
    return full_player(cur, player_id)


def pick_next_auction_player_id(cur):
    """Prefer waiting players (random). Only after that pool is empty, take the
    earliest unsold player (FIFO: first unsold comes back before later ones)."""
    cur.execute("SELECT id FROM players WHERE status = 'waiting'")
    waiting = cur.fetchall()
    if waiting:
        return random.choice(waiting)["id"]

    cur.execute(
        """
        SELECT id FROM players
        WHERE status = 'unsold'
        ORDER BY COALESCE(unsold_at, '9999-12-31'), id ASC
        LIMIT 1
        """
    )
    unsold = cur.fetchone()
    return unsold["id"] if unsold else None


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
        """
        UPDATE players
        SET current_bid_amount=NULL,
            current_bid_team_id=NULL,
            auction_ends_at=NULL,
            auction_timer_paused=0,
            auction_remaining_seconds=NULL,
            auction_reveal_until=NULL
        WHERE id=?
        """,
        (player_id,),
    )
    cur.execute("DELETE FROM bid_history WHERE player_id=?", (player_id,))


def attach_auction_payload(cur, player):
    if not player:
        return None
    player["history"] = get_bid_history(cur, player["id"])
    player["auction_timer_paused"] = bool(player.get("auction_timer_paused"))
    return player


@router.get("/current")
def current_player(request: Request, _=Depends(require_any)):
    with db_cursor() as cur:
        cur.execute("SELECT id FROM players WHERE status = 'auction' LIMIT 1")
        row = cur.fetchone()
        if not row:
            return None
        return attach_auction_payload(cur, full_player(cur, row["id"]))


@router.post("/set-current")
async def set_current(body: PlayerIdBody, request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        result = put_player_up(cur, body.player_id)
    await broadcaster.publish("current_player", result)
    return result


@router.post("/start")
async def start_auction(request: Request, _=Depends(require_admin)):
    """Pick the next player for auction.

    Waiting players are drawn at random. Unsold players only return after every
    waiting player has been auctioned, in the order they were marked unsold.
    """
    with db_cursor() as cur:
        cur.execute("SELECT id FROM players WHERE status = 'auction' LIMIT 1")
        if cur.fetchone():
            raise HTTPException(
                status_code=400,
                detail="A player is already up for auction — finish or mark unsold first",
            )
        chosen_id = pick_next_auction_player_id(cur)
        if not chosen_id:
            raise HTTPException(status_code=400, detail="No players left in the pool")
        result = put_player_up(cur, chosen_id)
    await broadcaster.publish("current_player", result)
    return result


def put_player_up(cur, player_id: int):
    """Mark player as auction current; clears any previous auction player."""
    cur.execute("SELECT * FROM players WHERE id = ?", (player_id,))
    player = cur.fetchone()
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    if player["status"] == "sold":
        raise HTTPException(status_code=400, detail="Player already sold")

    # clear any other player currently marked as 'auction' and its bid state
    cur.execute("SELECT id FROM players WHERE status = 'auction'")
    for prev in cur.fetchall():
        clear_bid_state(cur, prev["id"])
    cur.execute(
        """
        UPDATE players
        SET status = 'waiting',
            auction_ends_at=NULL,
            auction_timer_paused=0,
            auction_remaining_seconds=NULL,
            auction_reveal_until=NULL
        WHERE status = 'auction'
        """
    )

    timer_enabled = is_auction_timer_enabled(cur)
    timer_seconds = get_auction_timer_seconds(cur) if timer_enabled else 0
    now = utc_now()
    reveal_until_dt = now + timedelta(seconds=PACK_REVEAL_SECONDS)
    reveal_until = to_iso(reveal_until_dt)
    # Timer only starts after the pack reveal window, so auction duration
    # is preserved in full once the card flip finishes. When the timer is
    # disabled in settings, leave auction_ends_at empty so nothing expires.
    ends_at = (
        to_iso(reveal_until_dt + timedelta(seconds=timer_seconds))
        if timer_enabled
        else None
    )

    # fresh bid state for the newly selected player, starting at base price
    clear_bid_state(cur, player_id)
    cur.execute(
        """
        UPDATE players
        SET status = 'auction',
            current_bid_amount = base_price,
            auction_ends_at = ?,
            auction_timer_paused = 0,
            auction_remaining_seconds = NULL,
            auction_reveal_until = ?,
            unsold_at = NULL
        WHERE id = ?
        """,
        (ends_at, reveal_until, player_id),
    )
    return attach_auction_payload(cur, full_player(cur, player_id))


@router.post("/timer/pause")
async def pause_timer(request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        if not is_auction_timer_enabled(cur):
            raise HTTPException(status_code=400, detail="Auction timer is disabled in settings")
        cur.execute("SELECT * FROM players WHERE status = 'auction' LIMIT 1")
        player = cur.fetchone()
        if not player:
            raise HTTPException(status_code=400, detail="No player is currently up for auction")
        if player["auction_timer_paused"]:
            return attach_auction_payload(cur, full_player(cur, player["id"]))
        if not player["auction_ends_at"] and not player["auction_remaining_seconds"]:
            raise HTTPException(status_code=400, detail="No active countdown to pause")

        remaining = auction_time_remaining_seconds(dict(player))
        cur.execute(
            """
            UPDATE players
            SET auction_timer_paused = 1,
                auction_remaining_seconds = ?,
                auction_ends_at = NULL,
                auction_reveal_until = NULL
            WHERE id = ?
            """,
            (remaining, player["id"]),
        )
        result = attach_auction_payload(cur, full_player(cur, player["id"]))

    await broadcaster.publish("timer_paused", result)
    return result


@router.post("/timer/resume")
async def resume_timer(request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        if not is_auction_timer_enabled(cur):
            raise HTTPException(status_code=400, detail="Auction timer is disabled in settings")
        cur.execute("SELECT * FROM players WHERE status = 'auction' LIMIT 1")
        player = cur.fetchone()
        if not player:
            raise HTTPException(status_code=400, detail="No player is currently up for auction")
        if not player["auction_timer_paused"]:
            return attach_auction_payload(cur, full_player(cur, player["id"]))

        remaining = player["auction_remaining_seconds"]
        if remaining is None:
            remaining = get_auction_timer_seconds(cur)
        remaining = max(0, int(remaining))
        ends_at = to_iso(utc_now() + timedelta(seconds=remaining))
        cur.execute(
            """
            UPDATE players
            SET auction_timer_paused = 0,
                auction_remaining_seconds = NULL,
                auction_ends_at = ?,
                auction_reveal_until = NULL
            WHERE id = ?
            """,
            (ends_at, player["id"]),
        )
        result = attach_auction_payload(cur, full_player(cur, player["id"]))

    await broadcaster.publish("timer_resumed", result)
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

        current_amount = player["current_bid_amount"] or player["base_price"] or PLAYER_BASE_PRICE_CR
        has_live_bid = bool(player["current_bid_team_id"])
        max_spend = max_spendable(
            team["purse_remaining"],
            team["slots_max"],
            filled,
        )
        if not is_valid_bid_amount(body.amount, current_amount, max_spend, has_live_bid):
            next_std = next_standard_bid(current_amount) if has_live_bid else current_amount
            if body.amount > max_spend:
                detail = (
                    f"{team['name']} can spend at most ₹{max_spend} Cr on this player "
                    f"(must keep ₹{PLAYER_BASE_PRICE_CR} Cr for each remaining squad slot)"
                )
            elif has_live_bid and body.amount <= current_amount:
                detail = f"Bid must be higher than the current bid of ₹{current_amount} Cr"
            elif max_spend < next_std:
                detail = (
                    f"{team['name']} may only place an all-in bid of ₹{max_spend} Cr "
                    f"(below the next standard bid of ₹{next_std} Cr)"
                )
            else:
                detail = (
                    f"Bid must land on a valid increment (₹{BID_STEP_LOW_CR} Cr up to ₹{BID_HIGH_THRESHOLD_CR} Cr, "
                    f"then ₹{BID_STEP_HIGH_CR} Cr). Next standard bid is ₹{next_std} Cr"
                )
            raise HTTPException(status_code=400, detail=detail)

        cur.execute(
            "INSERT INTO bid_history (player_id, team_id, amount) VALUES (?, ?, ?)",
            (body.player_id, body.team_id, body.amount),
        )
        cur.execute(
            "UPDATE players SET current_bid_amount=?, current_bid_team_id=? WHERE id=?",
            (body.amount, body.team_id, body.player_id),
        )
        result = attach_auction_payload(cur, full_player(cur, body.player_id))

    await broadcaster.publish("bid_updated", result)
    return result


@router.post("/undo-bid")
async def undo_bid(request: Request, _=Depends(require_admin)):
    """Remove the latest bid on the current auction player and restore the prior lead."""
    with db_cursor() as cur:
        cur.execute("SELECT * FROM players WHERE status = 'auction' LIMIT 1")
        player = cur.fetchone()
        if not player:
            raise HTTPException(status_code=400, detail="No player is currently up for auction")

        history = get_bid_history(cur, player["id"])
        if not history:
            raise HTTPException(status_code=400, detail="No bids to undo")

        last = history[-1]
        cur.execute("DELETE FROM bid_history WHERE id = ?", (last["id"],))

        if len(history) >= 2:
            prev = history[-2]
            cur.execute(
                "UPDATE players SET current_bid_amount=?, current_bid_team_id=? WHERE id=?",
                (prev["amount"], prev["team_id"], player["id"]),
            )
        else:
            cur.execute(
                """
                UPDATE players
                SET current_bid_amount = base_price,
                    current_bid_team_id = NULL
                WHERE id = ?
                """,
                (player["id"],),
            )

        result = attach_auction_payload(cur, full_player(cur, player["id"]))

    await broadcaster.publish("bid_updated", result)
    return result


async def _publish_sale(player_result, team_result):
    await broadcaster.publish("player_sold", player_result)
    await broadcaster.publish("team_updated", team_result)


async def _publish_unsold(player_result):
    await broadcaster.publish("player_unsold", player_result)


def _try_assign(cur, player_id, team_id, sold_price):
    """Assign a player if purse/slots allow. Returns (player, team) or raises ValueError."""
    cur.execute("SELECT * FROM players WHERE id = ?", (player_id,))
    player = cur.fetchone()
    if not player:
        raise ValueError("Player not found")

    cur.execute("SELECT * FROM teams WHERE id = ?", (team_id,))
    team = cur.fetchone()
    if not team:
        raise ValueError("Team not found")

    cur.execute("SELECT COUNT(*) as c FROM players WHERE team_id = ?", (team_id,))
    filled = cur.fetchone()["c"]
    if filled >= team["slots_max"]:
        raise ValueError(f"{team['name']} already has {team['slots_max']} players")

    max_spend = max_spendable(team["purse_remaining"], team["slots_max"], filled)
    if sold_price > max_spend:
        raise ValueError(
            f"{team['name']} can spend at most ₹{max_spend} Cr on this player "
            f"(must keep ₹{PLAYER_BASE_PRICE_CR} Cr for each remaining squad slot)"
        )

    cur.execute(
        "UPDATE players SET status='sold', sold_price=?, team_id=?, auction_ends_at=NULL, unsold_at=NULL WHERE id=?",
        (sold_price, team_id, player_id),
    )
    cur.execute(
        "UPDATE teams SET purse_remaining = purse_remaining - ? WHERE id = ?",
        (sold_price, team_id),
    )
    clear_bid_state(cur, player_id)
    player_result = full_player(cur, player_id)
    cur.execute("SELECT * FROM teams WHERE id = ?", (team_id,))
    team_result = row_to_dict(cur.fetchone())
    return player_result, team_result


@router.post("/assign")
async def assign_player(body: AssignBody, request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        try:
            player_result, team_result = _try_assign(cur, body.player_id, body.team_id, body.sold_price)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    await _publish_sale(player_result, team_result)
    return player_result


@router.post("/unsold")
async def mark_unsold(body: PlayerIdBody, request: Request, _=Depends(require_admin)):
    with db_cursor() as cur:
        cur.execute("SELECT * FROM players WHERE id = ?", (body.player_id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Player not found")
        result = mark_player_unsold(cur, body.player_id)

    await _publish_unsold(result)
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

    with db_cursor() as cur:
        cur.execute("SELECT id, status, current_bid_team_id FROM players WHERE id = ?", (body.player_id,))
        player = cur.fetchone()
        if not player:
            raise HTTPException(status_code=404, detail="Player not found")
        if player["status"] != "auction":
            raise HTTPException(status_code=400, detail="This player is not currently up for auction")
        if not player["current_bid_team_id"]:
            raise HTTPException(status_code=400, detail="A team must be leading before calling going once / twice")

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

        cur.execute(
            "UPDATE players SET status='waiting', team_id=NULL, sold_price=NULL, auction_ends_at=NULL, unsold_at=NULL WHERE id=?",
            (body.player_id,),
        )
        clear_bid_state(cur, body.player_id)
        result = full_player(cur, body.player_id)

    await broadcaster.publish("player_reset", result)
    if refunded_team:
        await broadcaster.publish("team_updated", refunded_team)
    return result


async def expire_auction_if_needed():
    """If the live auction timer has elapsed, auto-sell to the leading bidder
    (or mark unsold when nobody has bid). Safe to call repeatedly."""
    expired = None
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT id, current_bid_team_id, current_bid_amount, base_price, auction_ends_at
            FROM players
            WHERE status = 'auction' AND auction_ends_at IS NOT NULL
            LIMIT 1
            """
        )
        row = cur.fetchone()
        if not row:
            return

        ends_at = parse_iso(row["auction_ends_at"])
        if not ends_at or ends_at > utc_now():
            return

        player_id = row["id"]
        team_id = row["current_bid_team_id"]
        sold_price = row["current_bid_amount"] or row["base_price"] or 0

        if team_id:
            try:
                player_result, team_result = _try_assign(cur, player_id, team_id, sold_price)
                expired = ("sold", player_result, team_result)
            except ValueError:
                player_result = mark_player_unsold(cur, player_id)
                expired = ("unsold", player_result, None)
        else:
            player_result = mark_player_unsold(cur, player_id)
            expired = ("unsold", player_result, None)

    if not expired:
        return
    kind, player_result, team_result = expired
    if kind == "sold":
        await _publish_sale(player_result, team_result)
    else:
        await _publish_unsold(player_result)


async def auction_timer_loop():
    """Background watcher: finalize auctions whose countdown has hit zero."""
    while True:
        try:
            await expire_auction_if_needed()
        except Exception:
            # Never let a transient DB/SSE blip kill the loop.
            pass
        await asyncio.sleep(0.5)
