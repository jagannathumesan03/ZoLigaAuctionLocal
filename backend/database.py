"""SQLite database setup and helpers."""
import sqlite3
import os
from contextlib import contextmanager

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "auction.db")
DB_PATH = os.path.abspath(DB_PATH)

SCHEMA = """
CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    logo_url TEXT DEFAULT '',
    purse_total INTEGER NOT NULL DEFAULT 0,
    purse_remaining INTEGER NOT NULL DEFAULT 0,
    slots_max INTEGER NOT NULL DEFAULT 7,
    owner_password TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo_url TEXT DEFAULT '',
    role TEXT DEFAULT '',
    base_price INTEGER NOT NULL DEFAULT 0,
    sold_price INTEGER,
    stats TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'waiting',  -- waiting | auction | sold | unsold
    team_id INTEGER,
    current_bid_amount INTEGER,
    current_bid_team_id INTEGER,
    auction_ends_at TEXT,
    auction_timer_paused INTEGER NOT NULL DEFAULT 0,
    auction_remaining_seconds INTEGER,
    auction_reveal_until TEXT,
    stars REAL NOT NULL DEFAULT 3.0,
    pace INTEGER NOT NULL DEFAULT 50,
    shooting INTEGER NOT NULL DEFAULT 50,
    passing INTEGER NOT NULL DEFAULT 50,
    dribbling INTEGER NOT NULL DEFAULT 50,
    defending INTEGER NOT NULL DEFAULT 50,
    physical INTEGER NOT NULL DEFAULT 50,
    FOREIGN KEY (team_id) REFERENCES teams(id),
    FOREIGN KEY (current_bid_team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS bid_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (player_id) REFERENCES players(id),
    FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_AUCTION_TIMER_SECONDS = 120


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db_cursor():
    conn = get_conn()
    try:
        cur = conn.cursor()
        yield cur
        conn.commit()
    finally:
        conn.close()


def _migrate(cur):
    """Add columns to pre-existing databases that were created before live bidding
    or FIFA-card player stats existed."""
    cur.execute("PRAGMA table_info(players)")
    cols = {row[1] for row in cur.fetchall()}
    if "current_bid_amount" not in cols:
        cur.execute("ALTER TABLE players ADD COLUMN current_bid_amount INTEGER")
    if "current_bid_team_id" not in cols:
        cur.execute("ALTER TABLE players ADD COLUMN current_bid_team_id INTEGER")
    if "auction_ends_at" not in cols:
        cur.execute("ALTER TABLE players ADD COLUMN auction_ends_at TEXT")
    if "auction_timer_paused" not in cols:
        cur.execute("ALTER TABLE players ADD COLUMN auction_timer_paused INTEGER NOT NULL DEFAULT 0")
    if "auction_remaining_seconds" not in cols:
        cur.execute("ALTER TABLE players ADD COLUMN auction_remaining_seconds INTEGER")
    if "auction_reveal_until" not in cols:
        cur.execute("ALTER TABLE players ADD COLUMN auction_reveal_until TEXT")
    for stat in CARD_STAT_FIELDS:
        if stat not in cols:
            cur.execute(f"ALTER TABLE players ADD COLUMN {stat} INTEGER NOT NULL DEFAULT 50")
    if "stars" not in cols:
        cur.execute("ALTER TABLE players ADD COLUMN stars REAL NOT NULL DEFAULT 3.0")
        cur.execute(
            "SELECT id, pace, shooting, passing, dribbling, defending, physical FROM players"
        )
        for row in cur.fetchall():
            cur.execute(
                "UPDATE players SET stars=? WHERE id=?",
                (stars_from_legacy_stats(dict(row)), row["id"]),
            )

    # One-time fix: the first stars backfill mapped untouched FIFA defaults
    # (overall 50) to 2 stars. Mid-level is 3.
    if get_setting(cur, "stars_default_fix_v1", None) is None:
        cur.execute(
            """
            UPDATE players SET stars = 3.0
            WHERE stars = 2
              AND COALESCE(pace, 50) = 50
              AND COALESCE(shooting, 50) = 50
              AND COALESCE(passing, 50) = 50
              AND COALESCE(dribbling, 50) = 50
              AND COALESCE(defending, 50) = 50
              AND COALESCE(physical, 50) = 50
            """
        )
        set_setting(cur, "stars_default_fix_v1", "1")

    cur.execute("PRAGMA table_info(teams)")
    team_cols = {row[1] for row in cur.fetchall()}
    if "owner_password" not in team_cols:
        cur.execute("ALTER TABLE teams ADD COLUMN owner_password TEXT DEFAULT ''")

    cur.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
        ("auction_timer_seconds", str(DEFAULT_AUCTION_TIMER_SECONDS)),
    )
    cur.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
        ("auction_timer_enabled", "1"),
    )


def init_db():
    with db_cursor() as cur:
        cur.executescript(SCHEMA)
        _migrate(cur)


def get_setting(cur, key, default=None):
    cur.execute("SELECT value FROM settings WHERE key = ?", (key,))
    row = cur.fetchone()
    return row["value"] if row else default


def set_setting(cur, key, value):
    cur.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


def get_auction_timer_seconds(cur):
    raw = get_setting(cur, "auction_timer_seconds", str(DEFAULT_AUCTION_TIMER_SECONDS))
    try:
        seconds = int(raw)
    except (TypeError, ValueError):
        seconds = DEFAULT_AUCTION_TIMER_SECONDS
    return max(5, min(seconds, 60 * 60))


def is_auction_timer_enabled(cur):
    raw = get_setting(cur, "auction_timer_enabled", "1")
    return str(raw).lower() not in ("0", "false", "off", "no", "")


def remaining_player_base_prices(cur):
    """Base prices of players still available to buy, cheapest first.

    The player currently up for auction is excluded — that purchase is the
    spend being decided. Waiting and unsold players can still fill later slots.
    """
    cur.execute(
        """
        SELECT COALESCE(base_price, 0)
        FROM players
        WHERE status IN ('waiting', 'unsold')
        ORDER BY base_price ASC
        """
    )
    return [int(row[0] or 0) for row in cur.fetchall()]


def squad_completion_reserve(slots_left, remaining_prices):
    """Points that must be kept to fill the *other* empty slots at the
    cheapest remaining base prices. 2 slots left and 16 players left → keep
    the single cheapest remaining base (not a fixed league minimum)."""
    need = max(0, int(slots_left or 0) - 1)
    if need <= 0:
        return 0
    prices = list(remaining_prices or [])
    return sum(int(p or 0) for p in prices[:need])


def max_spendable(purse_remaining, slots_max, slots_filled, remaining_prices):
    slots_left = max(0, int(slots_max or 0) - int(slots_filled or 0))
    if slots_left <= 0:
        return 0
    reserve = squad_completion_reserve(slots_left, remaining_prices)
    return max(0, int(purse_remaining or 0) - reserve)


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(r) for r in rows]


# ---------------------------------------------------------- Player cards ----
# Organizers set a 1–5 star level (top players are 5). Card gold/silver/bronze
# is derived from that so the existing card chrome still works. The six FIFA
# skill columns remain in older databases but are no longer used in the UI.

CARD_STAT_FIELDS = ["pace", "shooting", "passing", "dribbling", "defending", "physical"]


def clamp_stat(value, default=50):
    try:
        value = int(value)
    except (TypeError, ValueError):
        return default
    return max(0, min(99, value))


def clamp_stars(value, default=3.0):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return default
    value = int(value * 2 + 0.5) / 2
    return max(2.0, min(5.0, value))


def compute_overall(player):
    values = [clamp_stat(player.get(f)) for f in CARD_STAT_FIELDS]
    return round(sum(values) / len(values))


def stars_from_legacy_stats(player):
    overall = compute_overall(player)
    # Unset FIFA defaults average to 50 — treat that as a mid (3-star) player,
    # not a 2-star, so existing rosters don't all drop a level.
    if overall == 50:
        return 3.0
    if overall >= 80:
        return 5.0
    if overall >= 70:
        return 4.0
    if overall >= 60:
        return 3.0
    if overall >= 50:
        return 2.0
    return 2.0


def card_tier(stars):
    if stars >= 5:
        return "elite"
    if stars >= 4:
        return "gold"
    if stars >= 3:
        return "silver"
    return "bronze"


def enrich_player(player):
    """Add derived card-tier from the organizer-set star rating."""
    if player is None:
        return None
    player = dict(player)
    stars = clamp_stars(player.get("stars"), 3.0)
    player["stars"] = stars
    player["card_tier"] = card_tier(stars)
    return player


def enrich_players(players):
    return [enrich_player(p) for p in players]
