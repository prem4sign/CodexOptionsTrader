# Options Desk

Options Desk is a local-first NIFTY and Bank NIFTY options charting and paper-trading workspace. It uses FYERS API v3 for quotes, option-chain data, and historical candles. Paper orders are simulated in the browser and are never sent to FYERS as real orders.

## Features

- An index selector for NIFTY and Bank NIFTY, with matching spot, nearest CE/PE option, and historical charts.
- Four vertically stacked charts: intraday spot, nearest CE, nearest PE, and daily spot for the selected index.
- Per-chart intervals, including intraday and calendar intervals where available.
- Per-chart configurable EMA periods, colors, and visibility; chart panning, zoom, price-scale adjustment, and trend lines.
- Named browser-local workspaces that save the selected index, chart intervals, view state, indicators, trend lines, option expiry, and selected contracts.
- Paper market buys using the current FYERS option quote, with configurable lot count, stop loss, and profit target.
- Paper positions, manual exit, realized and unrealized P&L, and realized P&L added to saved trading capital.

Paper orders and settings are stored in the browser's local storage. While the app is open and connected to FYERS, open paper orders are checked against quotes every 15 seconds. This is a paper-trading aid, not an exchange order-management service.

## Run locally

1. Create a non-trading FYERS API app with market-data permissions.
2. Copy `.env.example` to `.env` and set the App ID, Secret ID, and redirect URL. Keep `.env` private; it is ignored by Git.
3. Set the FYERS app's Redirect URL to exactly:

   ```text
   http://localhost:8001/fyers/callback
   ```

4. From this directory, run:

   ```powershell
   python server.py
   ```

5. Open <http://localhost:8001> and connect to FYERS.

The server keeps the access token in memory only. Restarting the server clears the active session, and the app must be connected again. The FYERS app's callback URL and `FYERS_REDIRECT_URI` must match exactly.

## Cloud deployment

The Vercel deployment uses a separate Python Function in `api/index.py`; the local `python server.py` path is unchanged. Vercel rewrites the existing `/api/*`, `/auth/login`, and `/fyers/callback` URLs to that function.

Set these variables in the Vercel project's Production environment:

- `FYERS_APP_ID`: App ID from the deployed FYERS non-trading app.
- `FYERS_APP_SECRET`: its Secret ID.
- `FYERS_REDIRECT_URI`: `https://codexoptionstrader.vercel.app/fyers/callback` (must exactly match the redirect URL in that FYERS app).
- `FYERS_SESSION_KEY`: a Fernet key used to encrypt the OAuth state and FYERS access token in Secure, HttpOnly cookies. Generate it locally with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`; add the output directly to Vercel and do not commit or share it.

Vercel installs the Python dependency from `requirements.txt`. After setting the variables, redeploy. The cloud function keeps no FYERS token in process memory; its encrypted session cookie works across serverless invocations. The local server continues to read its existing ignored `.env` and use the localhost callback. Never deploy `.env` or expose the App Secret or session key in browser code.

The Vercel deployment currently exposes the app publicly. Before using it beyond personal testing, enable access protection for the deployment. Paper trades remain in each browser's local storage and do not sync between devices.
