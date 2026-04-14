# Omada Voucher Status Checker

Node.js + Express app for checking TP-Link Omada hotspot voucher status from a browser page on the same local network as the OC200/controller. A customer enters one voucher code, and the app asks Omada OpenAPI for that voucher plus matching client usage history.

The dashboard can show:

- Voucher status: unused, in use, or expired
- Remaining time or traffic, depending on voucher type
- Live download/upload speed when Omada reports an active matched client
- Total data consumed from the matched client record
- Device name, SSID, IP address, AP name, signal, and band when available
- Embedded speed test panel
- Branded logo and favicon from `hotspotlogo/HOTSPOT LOGO.png`

Important: this app is read-only from the customer page. It does not disconnect clients, log out voucher sessions, block devices, unblock devices, or create/edit/delete vouchers.

## Requirements

- Node.js 18 or newer recommended
- An Omada Controller with OpenAPI enabled
- Omada OpenAPI app credentials
- Read permission for:
  - Sites
  - Hotspot voucher groups and voucher details
  - Client list/usage

Write/client-control permission is not required because the app no longer performs disconnect or logout actions.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from the example file:

```bash
copy .env.example .env
```

On PowerShell, you can also use:

```powershell
Copy-Item .env.example .env
```

3. Fill in `.env` with your Omada OpenAPI values.

Minimum required config for client-credentials mode:

```env
PORT=3000
HOST=0.0.0.0
OMADA_CONTROLLER_URL=https://YOUR_OC200_LAN_OPENAPI_ADDRESS
OMADA_ID=your-omada-id
OMADA_CLIENT_ID=your-client-id
OMADA_CLIENT_SECRET=your-client-secret
OMADA_AUTH_MODE=client_credentials
OMADA_INSECURE_TLS=true
```

Example for a local OC200:

```env
PORT=3000
HOST=0.0.0.0
OMADA_CONTROLLER_URL=https://192.168.1.50:443
OMADA_ID=your-omada-id
OMADA_CLIENT_ID=your-client-id
OMADA_CLIENT_SECRET=your-client-secret
OMADA_AUTH_MODE=client_credentials
OMADA_INSECURE_TLS=true
```

4. Start the app:

```bash
npm start
```

5. Open:

```text
http://localhost:3000
```

From a phone or other device on the same Wi-Fi/LAN, open the server computer's LAN IP:

```text
http://YOUR_SERVER_LAN_IP:3000
```

On Windows, run `ipconfig` on the server computer and use the IPv4 address from the active Wi-Fi/Ethernet adapter. Keep the server computer on, and allow port `3000` through Windows Firewall if another device cannot open the page.

For development with auto-restart:

```bash
npm run dev
```

## Local Network Setup

This setup is for an OC200/controller on your LAN, for example `https://192.168.1.50:443`.

Users can access the voucher checker when they are connected to the same Wi-Fi/LAN as the computer or mini-PC running this Node app. The browser connects to this app at `http://YOUR_SERVER_LAN_IP:3000`; this app then talks to the OC200 through `OMADA_CONTROLLER_URL`.

Vercel is not needed for this setup. If the controller URL is a private LAN IP like `192.168.x.x`, Vercel cannot reach it because Vercel runs outside your network. Use Vercel only when the controller API is reachable from Vercel through a public URL, VPN, or tunnel.

## Environment Variables

Required:

- `OMADA_CONTROLLER_URL`
  OpenAPI interface address from Omada. Example: `https://192.168.1.50:443`. Do not add a trailing slash.

- `OMADA_ID`
  Omada ID from the OpenAPI app details.

- `OMADA_CLIENT_ID`
  Client ID from the OpenAPI app details.

- `OMADA_CLIENT_SECRET`
  Client secret from the OpenAPI app details. Keep this private.

Common optional values:

- `PORT`
  Local server port. Default: `3000`.

- `HOST`
  Server bind address. Default: `0.0.0.0` so phones and other devices on the same LAN can open the app by using the server computer's LAN IP.

- `OMADA_AUTH_MODE`
  Default: `client_credentials`. Use `authorization_code` only if your Omada app is configured for that mode.

- `OMADA_USERNAME` and `OMADA_PASSWORD`
  Only needed for `OMADA_AUTH_MODE=authorization_code`.

- `OMADA_INSECURE_TLS`
  Default: `true`. Useful for local controllers with self-signed certificates. Use `false` only when your controller has a trusted TLS certificate.

- `OMADA_SITE_ID` or `OMADA_SITE_NAME`
  Optional narrowing to one Omada site. If blank, the app uses the primary site or the first accessible site.

- `OMADA_VOUCHER_GROUP_ID` or `OMADA_VOUCHER_GROUP_NAME`
  Optional narrowing to one voucher group. If blank, the app searches accessible voucher groups.

- `OMADA_PAGE_SIZE`
  Voucher group detail page size. Default: `50`. Max: `1000`.

- `OMADA_TIMEOUT_MS`
  Omada API request timeout. Default: `20000`.

- `SPEEDTEST_EMBED_URL`
  Speed test embed URL shown in the public page. Default: `https://fast.com/`.

## Project Structure

```text
.
|-- src/
|   |-- server.js          # Starts the Express server
|   |-- app.js             # Express routes and API handlers
|   |-- config.js          # .env parsing and required config checks
|   `-- omada-client.js    # Omada OpenAPI auth, voucher lookup, client usage summary
|-- public/
|   |-- index.html         # Public page
|   |-- app.js             # Frontend dashboard logic and live updates
|   `-- styles.css         # Frontend styling
|-- hotspotlogo/
|   `-- HOTSPOT LOGO.png   # Logo and favicon source
|-- test/
|   |-- app-routes.test.js
|   |-- config.test.js
|   `-- frontend-traffic.test.js
|-- .env.example
|-- package.json
|-- vercel.json          # Optional Vercel routing file; not needed for LAN-only OC200 setup
`-- README.md
```

## Public Endpoints

- `GET /`
  Public voucher checker page.

- `GET /favicon.ico`
  Serves `hotspotlogo/HOTSPOT LOGO.png` as the browser favicon.

- `GET /hotspotlogo/HOTSPOT%20LOGO.png`
  Serves the hotspot logo image.

- `GET /api/health`
  Health check.

- `GET /api/public-config`
  Public browser config, currently the speed-test URL.

- `GET /api/voucher-status?code=YOURCODE`
  Looks up one voucher code and returns voucher status plus matched usage summary.

- `GET /api/vouchers?code=YOURCODE`
  Alias for `/api/voucher-status`.

- `GET /api/voucher-status/stream?code=YOURCODE`
  Server-sent events stream for live voucher updates.

- `GET /api/vouchers/stream?code=YOURCODE`
  Alias for `/api/voucher-status/stream`.

There is no public API route for disconnecting clients or logging out vouchers.

Example:

```text
http://localhost:3000/api/voucher-status?code=ABC123
```

## Omada API Flow

Authentication:

- Client credentials mode:
  - `POST /openapi/authorize/token?grant_type=client_credentials`

- Authorization-code mode:
  - `POST /openapi/authorize/login`
  - `POST /openapi/authorize/code`
  - `POST /openapi/authorize/token?grant_type=authorization_code`

Voucher lookup:

- `GET /openapi/v1/{omadacId}/sites`
- `GET /openapi/v1/{omadacId}/sites/{siteId}/hotspot/voucher-groups`
- `GET /openapi/v1/{omadacId}/sites/{siteId}/hotspot/voucher-groups/{groupId}`

Client usage lookup:

- `POST /openapi/v2/{omadacId}/sites/{siteId}/clients`

The app sends API requests with:

```text
Authorization: AccessToken=<token>
```

## How Voucher Matching Works

1. The user enters a voucher code.
2. The server resolves the Omada site and voucher group.
3. The server searches voucher group details for the exact voucher code.
4. The server reads the client list and matches clients whose `authInfo` contains:
   - `authType = 3`
   - `info = voucher code`
5. The frontend displays the voucher and matched client usage.

If no client history is found, the app can still display voucher-level status and meter values when Omada provides them.

## Customization

Logo and favicon:

- Replace `hotspotlogo/HOTSPOT LOGO.png` with a new PNG using the same filename.
- Restart the server if it is running with `npm start`.
- Browsers may cache favicons. Hard refresh or clear browser cache if the old icon remains.

Speed test:

- Set `SPEEDTEST_EMBED_URL` in `.env`.
- Default is `https://fast.com/`.

Branding and layout:

- Main frontend markup is in `public/index.html`.
- Styles are in `public/styles.css`.
- Dashboard behavior is in `public/app.js`.

## Testing

Run:

```bash
npm test
```

The current test suite covers routing, local config behavior, and frontend voucher timer/traffic display logic.

## Troubleshooting

Phone or same-Wi-Fi device cannot open the page:

- Make sure the Node app is running with `npm start`.
- Use `http://YOUR_SERVER_LAN_IP:3000`, not `http://localhost:3000`, from the phone.
- Confirm the phone is on the same Wi-Fi/LAN as the server computer.
- Confirm `.env` has `HOST=0.0.0.0`.
- Allow Node.js or port `3000` in Windows Firewall.

API returns 502:

- Make sure the server computer can open the OC200/controller address in `OMADA_CONTROLLER_URL`.
- Make sure `OMADA_CONTROLLER_URL` points to the OC200 LAN OpenAPI address, for example `https://192.168.1.50:443`.
- Confirm the Omada OpenAPI app is in client mode and has permission for sites, voucher groups, and client list.

Configuration still needed:

- The server starts even if Omada config is missing, but `/api/voucher-status` will not work until required `.env` values are set.
- On startup, the server logs missing config names.

Voucher code not found:

- Check that the voucher code exists in the selected site and voucher group.
- If `OMADA_VOUCHER_GROUP_ID` or `OMADA_VOUCHER_GROUP_NAME` is set, make sure it points to the correct group.

No live speed or device details:

- Omada only returns live speed/device details when the voucher can be matched to a client record.
- If the device is offline, the app may show voucher status but no live speed.

TLS or certificate errors:

- Local Omada controllers often use self-signed certificates.
- Keep `OMADA_INSECURE_TLS=true` for local/self-signed controllers.
- Use `OMADA_INSECURE_TLS=false` only with a trusted certificate.

Favicon did not change:

- The app serves `/favicon.ico` from `hotspotlogo/HOTSPOT LOGO.png`.
- Browser favicon cache can be sticky. Try hard refresh, close/reopen the tab, or clear site data.

## Handoff Notes

- Do not commit or share `.env`; it contains the Omada client secret.
- `.env.example` is safe to share because it contains placeholders only.
- This is a status checker, not a voucher admin panel.
- The app intentionally does not expose disconnect/logout controls.
- After changing backend files under `src/`, restart `npm start`.
- During development, use `npm run dev` for auto-restart.
