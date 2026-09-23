# PaySplit

Split bills with friends. This first version has the account system: **sign up, log in, stay logged in, log out**.

Tech stack:
- **Frontend:** React 18 + Vite (`client/`)
- **Backend:** Node.js HTTP server with no npm dependencies (`server/`)
- **Database:** SQLite through Node's built-in `node:sqlite` module. The file is `data/paysplit.db` and is created automatically.

## Requirements

Node.js **22.13 or newer**. Check with `node --version`.

## Set up

```bash
git clone <your-repo-url> paysplit
cd paysplit
npm run install:client     # installs React + Vite inside client/
```

## Run in development (two terminals)

```bash
# Terminal 1: API server on http://localhost:3000
npm run dev:server

# Terminal 2: React app on http://localhost:5173
npm run dev:client
```

Open **http://localhost:5173**. Vite forwards every `/api` request to the Node server.

## Run in production

```bash
npm run build                        # builds React into client/dist
NODE_ENV=production npm start        # serves the app and API on :3000
```

In production the session cookie is marked `Secure`, so serve it over HTTPS.

## Project structure

```
paysplit/
├── server/
│   ├── index.js        HTTP server, auth routes, serves the React build
│   ├── auth.js         Password hashing (scrypt) and sessions
│   └── db.js           SQLite connection and tables
├── client/
│   ├── index.html
│   ├── vite.config.js  Dev proxy for /api
│   └── src/
│       ├── App.jsx     Chooses login / signup / dashboard
│       ├── api.js      fetch wrapper
│       ├── styles.css
│       └── pages/      Login, Signup, Dashboard, AuthLayout, Field
└── package.json        Root scripts
```

## Database tables

```sql
users    (id, name, email UNIQUE, password_hash, created_at)
sessions (token_hash, user_id, expires_at)
```

## API

| Method | Path               | Body                          | Result                          |
|--------|--------------------|-------------------------------|---------------------------------|
| POST   | /api/auth/signup   | `{ name, email, password }`   | Creates the user and logs in    |
| POST   | /api/auth/login    | `{ email, password }`         | Logs in and sets the cookie     |
| GET    | /api/auth/me       |                               | Returns the logged-in user      |
| POST   | /api/auth/logout   |                               | Ends the session                |

## Security notes

- Passwords are hashed with **scrypt** and a random salt per user. Plain passwords are never stored.
- The session token is random (32 bytes) and stored in an **HttpOnly** cookie. The database keeps only its SHA-256 hash.
- Sessions expire after 7 days.
- Login is limited to 10 failed attempts per email and IP address every 15 minutes.
- Emails are stored in lowercase and must be unique.

Node prints an `ExperimentalWarning` for SQLite on start-up. This is expected.

## Next steps

Groups, expenses, and balances: add tables in `server/db.js`, routes in `server/index.js`, and pages in `client/src/pages/`.
