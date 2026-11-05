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

Cloud hosting is not configured yet. Deployment will require updating the OAuth callback handling and setting the exact public HTTPS redirect URL in both the FYERS dashboard and the server environment. Do not deploy the local `.env` file or expose the App Secret or access token to browser code.
