Render deploy:
- Build: npm i
- Start: node server/server.js
- Env: RUNWAY_API_KEY=<your key>, NODE_VERSION=20 (optional)
- Test: https://<app>.onrender.com/healthz -> {"ok":true}
