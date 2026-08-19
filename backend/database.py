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
    slots_max INTEGER NOT NULL DEFAULT 8,
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

# ZoLiga Season 4 — amounts are stored in crore (₹ Cr).
PLAYER_BASE_PRICE_CR = 30
TEAM_PURSE_CR = 1000
TEAM_SLOTS = 8
BID_STEP_LOW_CR = 5
BID_STEP_HIGH_CR = 10
BID_HIGH_THRESHOLD_CR = 200

# Player affiliation shown on cards (stored in players.stats).
PLAYER_AFFILIATIONS = (
    "Zoho Chennai",
    "Zoho Kottarakara",
    "Ex Zoho",
    "Ex ZoLiga",
)
_AFFILIATION_LOOKUP = {
    "zoho chennai": "Zoho Chennai",
    "zoho kottarakara": "Zoho Kottarakara",
    "zoho kottarakkara": "Zoho Kottarakara",
    "zoho - chennai": "Zoho Chennai",
    "zoho - kottarakkara": "Zoho Kottarakara",
    "non-zoho": "Ex Zoho",
    "ex zoho": "Ex Zoho",
    "ex zoliga": "Ex ZoLiga",
}


def normalize_affiliation(raw: str) -> str:
    """Map CSV/form input to a canonical affiliation label."""
    text = (raw or "").strip()
    if not text:
        return ""
    return _AFFILIATION_LOOKUP.get(text.lower(), text)


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

    # One-time Season 4 purse / slots / base-price alignment.
    if get_setting(cur, "season4_rules_v1", None) is None:
        _apply_season4_rules(cur)
        set_setting(cur, "season4_rules_v1", "1")
    if get_setting(cur, "season4_rules_v2", None) is None:
        _reset_demo_sales_to_crore(cur)
        set_setting(cur, "season4_rules_v2", "1")


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


def _apply_season4_rules(cur):
    """Align existing demo data with Season 4 purse, slots, and ₹30 Cr bases."""
    cur.execute(
        "UPDATE teams SET slots_max = ?, purse_total = ?",
        (TEAM_SLOTS, TEAM_PURSE_CR),
    )
    cur.execute("SELECT id FROM teams")
    for team in cur.fetchall():
        cur.execute(
            "SELECT COALESCE(SUM(sold_price), 0) AS spent FROM players WHERE team_id = ? AND status = 'sold'",
            (team["id"],),
        )
        spent = int(cur.fetchone()["spent"] or 0)
        if spent > TEAM_PURSE_CR:
            spent = 0
        cur.execute(
            "UPDATE teams SET purse_remaining = ? WHERE id = ?",
            (TEAM_PURSE_CR - spent, team["id"]),
        )
    cur.execute(
        "UPDATE players SET base_price = ? WHERE status IN ('waiting', 'unsold', 'auction')",
        (PLAYER_BASE_PRICE_CR,),
    )
    cur.execute(
        """
        SELECT id FROM players
        WHERE status = 'auction'
          AND COALESCE(current_bid_amount, 0) > ?
        """,
        (TEAM_PURSE_CR,),
    )
    for row in cur.fetchall():
        cur.execute("DELETE FROM bid_history WHERE player_id = ?", (row["id"],))
        cur.execute(
            """
            UPDATE players
            SET current_bid_amount = ?, current_bid_team_id = NULL
            WHERE id = ?
            """,
            (PLAYER_BASE_PRICE_CR, row["id"]),
        )


def _reset_demo_sales_to_crore(cur):
    """Old demo sales used rupee amounts. Clear them so Season 4 crore values are consistent."""
    cur.execute(
        """
        UPDATE players
        SET status = 'waiting',
            team_id = NULL,
            sold_price = NULL,
            current_bid_amount = NULL,
            current_bid_team_id = NULL,
            auction_ends_at = NULL,
            auction_timer_paused = 0,
            auction_remaining_seconds = NULL,
            auction_reveal_until = NULL,
            base_price = ?
        WHERE COALESCE(sold_price, 0) > ? OR COALESCE(base_price, 0) > ?
        """,
        (PLAYER_BASE_PRICE_CR, TEAM_PURSE_CR, TEAM_PURSE_CR),
    )
    cur.execute("UPDATE players SET base_price = ?", (PLAYER_BASE_PRICE_CR,))
    cur.execute("DELETE FROM bid_history")
    cur.execute(
        "UPDATE teams SET purse_total = ?, purse_remaining = ?, slots_max = ?",
        (TEAM_PURSE_CR, TEAM_PURSE_CR, TEAM_SLOTS),
    )


def squad_completion_reserve(slots_left):
    """₹30 Cr must be kept for each squad slot that will remain after this buy."""
    need = max(0, int(slots_left or 0) - 1)
    return need * PLAYER_BASE_PRICE_CR


def max_spendable(purse_remaining, slots_max, slots_filled):
    """Maximum bid = remaining purse − ₹30 Cr × slots left after this purchase."""
    slots_left = max(0, int(slots_max or 0) - int(slots_filled or 0))
    if slots_left <= 0:
        return 0
    reserve = squad_completion_reserve(slots_left)
    return max(0, int(purse_remaining or 0) - reserve)


def bid_increment(amount):
    amount = int(amount or 0)
    return BID_STEP_HIGH_CR if amount >= BID_HIGH_THRESHOLD_CR else BID_STEP_LOW_CR


def next_standard_bid(current_amount):
    current_amount = int(current_amount or 0)
    return current_amount + bid_increment(current_amount)


def add_bid_steps(amount, steps):
    amount = int(amount or 0)
    for _ in range(max(0, int(steps or 0))):
        amount = next_standard_bid(amount)
    return amount


def is_on_bid_grid(amount):
    amount = int(amount or 0)
    if amount < PLAYER_BASE_PRICE_CR:
        return False
    if amount <= BID_HIGH_THRESHOLD_CR:
        return (amount - PLAYER_BASE_PRICE_CR) % BID_STEP_LOW_CR == 0
    return (amount - BID_HIGH_THRESHOLD_CR) % BID_STEP_HIGH_CR == 0


def is_valid_bid_amount(amount, current_amount, max_spend, has_live_bid):
    """Season 4 bid validity: grid steps, plus all-in when max < next standard."""
    amount = int(amount or 0)
    current_amount = int(current_amount or 0)
    max_spend = int(max_spend or 0)
    if amount > max_spend:
        return False
    if has_live_bid:
        if amount <= current_amount:
            return False
        next_std = next_standard_bid(current_amount)
    else:
        if amount < current_amount:
            return False
        next_std = current_amount
    if max_spend < next_std and amount == max_spend:
        return True
    if amount < next_std:
        return False
    return is_on_bid_grid(amount)


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
