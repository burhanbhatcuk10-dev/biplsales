# Banday Impex ERP

React + Vite frontend, Express API, Neon Postgres database, Cloudinary product images. Role-based login: **Admin**, **Salesperson**, **Store Manager**.

## Roles
- **Admin**: everything; creates users and passwords, approves orders, edits catalog, credit limits and company profile.
- **Salesperson**: creates orders, customers, leads and payment receipts.
- **Store Manager**: dispatches and delivers orders, adjusts stock.

Permissions are enforced on the server, not just hidden in the screens.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → pick the repo (it reads `render.yaml`).
3. Fill in the environment variables when prompted:
   - `DATABASE_URL`: Neon → Connect → copy the **pooled** connection string.
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` (8+ chars): your first admin login. Used only on the first start.
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`: Cloudinary dashboard.
   - `JWT_SECRET` is generated for you.
4. Deploy. Tables are created automatically on first start.
5. Sign in, open **Admin & Audit**: set the real GSTIN under Company profile, then **Add user** for each salesperson and store manager and give them the email and password.

The admin login always follows `ADMIN_EMAIL` / `ADMIN_PASSWORD`: change them in Render and redeploy to reset the admin login (passwords changed inside the app are kept until you change those two values).

`SEED_DEMO=true` (first start only) loads demo customers and orders. Leave it `false` for real use.
Render's free plan sleeps when idle, so the first request after a pause takes ~30 s.

## Run locally
Node 20.6+. Copy `.env.example` to `.env` (Windows: `copy .env.example .env`) and fill it in.
```bash
npm install
npm run dev      # starts API (:3000) and web app (:5173) together, open http://localhost:5173
```
Single-server mode (same as production): `npm run local`, then open http://localhost:3000.

## Notes
- Passwords are stored as bcrypt hashes; sessions are HttpOnly cookies (12 h). Resetting or disabling a user signs them out immediately. Sign-in is rate limited.
- Product photos are resized in the browser, uploaded to Cloudinary, and only the URL is stored.
- Admin → Download backup exports all data as JSON.
- Screens refresh every 30 s and when the tab regains focus, so teammates see each other's changes.
