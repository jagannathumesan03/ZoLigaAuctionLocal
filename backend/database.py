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
    slots_max INTEGER NOT NULL DEFAULT 7
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
"""


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
    for stat in CARD_STAT_FIELDS:
        if stat not in cols:
            cur.execute(f"ALTER TABLE players ADD COLUMN {stat} INTEGER NOT NULL DEFAULT 50")


def init_db():
    with db_cursor() as cur:
        cur.executescript(SCHEMA)
        _migrate(cur)


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(r) for r in rows]


# ---------------------------------------------------------- FIFA-style cards ----
# Every player carries 6 sub-stats (0-99, like FIFA Ultimate Team); "overall" and
# "card_tier" are derived from those rather than stored separately, so there's
# only one source of truth. Used by players.py, teams.py, and auction.py to
# enrich any player dict before it goes back to the frontend.

CARD_STAT_FIELDS = ["pace", "shooting", "passing", "dribbling", "defending", "physical"]


def clamp_stat(value, default=50):
    try:
        value = int(value)
    except (TypeError, ValueError):
        return default
    return max(0, min(99, value))


def compute_overall(player):
    values = [clamp_stat(player.get(f)) for f in CARD_STAT_FIELDS]
    return round(sum(values) / len(values))


def card_tier(overall):
    if overall >= 75:
        return "gold"
    if overall >= 65:
        return "silver"
    return "bronze"


def enrich_player(player):
    """Add derived FIFA-card fields (overall rating, tier) to a player dict."""
    if player is None:
        return None
    player = dict(player)
    overall = compute_overall(player)
    player["overall"] = overall
    player["card_tier"] = card_tier(overall)
    return player


def enrich_players(players):
    return [enrich_player(p) for p in players]
