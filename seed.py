"""Seed the database with 8 teams. Run once: python seed.py
Players can be added via the admin dashboard (one by one or CSV bulk upload).
"""
from backend.database import init_db, db_cursor

TEAMS = [
    ("Thunder FC", 10_000_000),
    ("Royal Strikers", 10_000_000),
    ("Falcon United", 10_000_000),
    ("Titan Warriors", 10_000_000),
    ("Storm Riders", 10_000_000),
    ("Phoenix FC", 10_000_000),
    ("Blaze United", 10_000_000),
    ("Eagle Kings", 10_000_000),
]


def seed():
    init_db()
    with db_cursor() as cur:
        cur.execute("SELECT COUNT(*) as c FROM teams")
        if cur.fetchone()["c"] > 0:
            print("Teams already exist, skipping seed.")
            return
        for name, purse in TEAMS:
            cur.execute(
                "INSERT INTO teams (name, logo_url, purse_total, purse_remaining, slots_max) VALUES (?, '', ?, ?, 7)",
                (name, purse, purse),
            )
    print(f"Seeded {len(TEAMS)} teams.")


if __name__ == "__main__":
    seed()
