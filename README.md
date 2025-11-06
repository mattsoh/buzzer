# Buzzer — simple real-time quiz buzzer

A minimal Node.js + Express + Socket.IO app for running a buzzer game (admin + player UIs).

Features
- Admin panel (password or token) to approve players, start rounds, and see leaderboard and buzz order.
- Player panel: join, wait for approval, large buzzer, synchronized start, per-round times.
- In-memory state (no database).
- Admin password can be provided via environment variable `ADMIN_PASSWORD` for deployments.

Quick start (local)

1. Install dependencies

```bash
npm install
```

2. Start server

```bash
# optionally set ADMIN_PASSWORD
ADMIN_PASSWORD=letmein npm start
```

3. Open pages
- Player: http://localhost:3000/
- Admin: http://localhost:3000/admin.html (password: the value of `ADMIN_PASSWORD`, default `letmein`)

Notes for Render deployment
- Set the `start` command to `node server.js` (already provided in `package.json`).
- Add an environment variable `ADMIN_PASSWORD` in Render for your admin login.
- Render will set the `PORT` environment variable; the server reads `process.env.PORT` automatically.

Security
- This is a simple demo. The admin password is a basic protection only. For production use, add proper auth and HTTPS.

