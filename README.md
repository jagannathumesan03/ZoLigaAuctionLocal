# Football Tournament Auction Website

Full-stack auction tracker for an 8-team, 56-player football tournament. The actual auction/bidding happens in person; this site is the live dashboard — the admin marks a player as "up for auction," then records the winning team and price once decided in the room. Every viewer's screen updates instantly (no refresh) via Server-Sent Events.

## Stack

- **Backend:** Python, FastAPI, SQLite (file-based, no separate DB server needed)
- **Frontend:** Vanilla HTML/CSS/JS, no build step
- **Real-time:** Server-Sent Events (SSE) — one-way push from server to all connected browsers
- **Auth:** Session cookies (via `SessionMiddleware`), two roles: `admin` and `viewer`

## Project structure

```
football-auction/
  backend/
    main.py            FastAPI app, routes, SSE endpoint, startup DB init
    database.py         SQLite connection + schema
    auth.py              Login checks + role guards
    sse.py               In-memory pub/sub broadcaster for SSE
    routers/
      auth_routes.py     /api/auth/*  (login, logout, me)
      players.py         /api/players/*  (CRUD, search, CSV bulk upload)
      teams.py           /api/teams/*  (CRUD, squad + purse view)
      auction.py         /api/auction/*  (set-current, bid, assign, unsold, undo)
  static/
    css/style.css        Dark sports theme, responsive
    js/{login,admin,viewer}.js
    uploads/{players,teams}/   uploaded photos/logos land here
  templates/
    login.html, admin.html, viewer.html
  seed.py                Seeds the 8 teams (run once)
  sample_players.csv     Example file for the bulk-CSV importer
  requirements.txt
  auction.db             created automatically on first run
```

## Setup

Requires Python 3.9+.

```bash
cd football-auction
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

python3 seed.py                 # creates auction.db and inserts the 8 teams

uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

Open `http://localhost:8000` — it redirects to the login page.

To let other devices on the same room/wifi view it, share `http://<your-computer's-LAN-IP>:8000` instead of localhost.

## Logins

Set via environment variables before starting `uvicorn`, or just use the defaults below for testing:

| Role   | Credential                          | Env var override                      |
|--------|--------------------------------------|-----------------------------------------|
| Admin  | username `admin`, password `admin123`| `ADMIN_USERNAME`, `ADMIN_PASSWORD`      |
| Viewer | password `viewer123` (shared)        | `VIEWER_PASSWORD`                       |

Example:
```bash
export ADMIN_USERNAME=organizer
export ADMIN_PASSWORD=change-this-please
export VIEWER_PASSWORD=share-this-with-everyone
export SESSION_SECRET=some-long-random-string   # optional, defaults to a dev secret
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

**Change these before your actual tournament** — the defaults are for local testing only.

## Using it on the day

1. **Before the auction:** log in as admin, go to *Players*, and either add all 56 players one by one or use *Bulk CSV Upload* (see `sample_players.csv` for the expected columns: `name, role, base_price, stats, stars`). `stars` is 2.0 to 5.0 in 0.5 steps (e.g., 3.5 for half star, top players are 5.0). Photos can be added by editing each player afterward. Go to *Teams* and confirm the 8 teams and purses are correct (edit purse/slots if needed — created via `seed.py`).
2. **During the auction:** on the *Auction Control* tab, search for the next player and click **Put Up for Auction** — this instantly appears on every viewer's screen, starting at the player's base price. As bidding happens in the room, use the **Live Bidding** panel to track it in real time (see below). Once bidding settles, click **Finalize Sale** — it pre-fills the winning team and price from the live bid, confirm to complete the sale. If nobody bids, click **Mark Unsold** instead.
3. **Live bidding panel:** click the button for whichever team is currently bidding (it highlights), then either click one of the quick-raise buttons (increments scale automatically with the bid size — bigger raises once the price gets higher) or type a custom amount (1 to 1,000,000) and click **+ Add to bid** to raise by that much. Every raise is recorded in the bid history log below, and the whole panel — bid amount, leading team, history — updates live on the viewer screen too, no reload needed.
4. **Mistakes happen:** if a player was assigned to the wrong team or at the wrong price, use **Undo** (on the Players tab) to send them back to the waiting pool — the team's purse is automatically refunded and any live bid state for that player is cleared.
5. **Viewers:** anyone with the viewer password sees a live "Now Auctioning" spotlight (with the current bid amount and leading team), a live bid history log, all 8 teams with their current squads and remaining purse, and a searchable list of all 56 players with their status (waiting / up for auction / sold / unsold). Updates appear with no page reload.

## Notes / things worth knowing

- The SQLite database is a single file, `auction.db`, created next to the project on first run — back it up periodically during the actual event (just copy the file).
- Purse and slot limits are enforced server-side: assigning a player that would exceed a team's remaining purse or its 7-player slot limit is rejected with an error. A team with a full roster also can't place live bids.
- Only one player can be "up for auction" at a time; marking a new one automatically resets any previous one back to "waiting," along with clearing its live bid state.
- Live bids must always raise the price — the app rejects a "bid" that's equal to or lower than the current one. The live bid amount and history are separate from the final sale; the admin can still edit the team/price on the finalize step before confirming.
- If you already had this app running before live bidding was added, no need to re-run `seed.py` — the app automatically adds the new database columns/table to your existing `auction.db` the next time it starts.
- Uploaded photos/logos are stored under `static/uploads/` and served directly — back these up along with `auction.db` if you want to preserve them.
- This app has no built-in HTTPS; for a local/LAN event that's normal, but if you expose it to the public internet, put it behind a reverse proxy with TLS.
