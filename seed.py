"""Seed the database with 8 teams. Run once: python seed.py
Players can be added via the admin dashboard (one by one or CSV bulk upload).
"""
from backend.database import init_db, db_cursor

TEAMS = [
    ("Thunder FC", 1000),
    ("Royal Strikers", 1000),
    ("Falcon United", 1000),
    ("Titan Warriors", 1000),
    ("Storm Riders", 1000),
    ("Phoenix FC", 1000),
    ("Blaze United", 1000),
    ("Eagle Kings", 1000),
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
                "INSERT INTO teams (name, logo_url, purse_total, purse_remaining, slots_max) VALUES (?, '', ?, ?, 8)",
                (name, purse, purse),
            )
    print(f"Seeded {len(TEAMS)} teams.")


if __name__ == "__main__":
    seed()
