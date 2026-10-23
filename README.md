# SatTrakR server

A small backend for the SatTrakR app. No packages to install, only Node 18 or newer.

## Try it on your PC
1. Install Node.js LTS from nodejs.org.
2. Open `cmd` in this folder and run:  `node server.js`
3. Open http://localhost:8787/api/stats in a browser. You should see counters.
4. Open http://localhost:8787/api/tle. It downloads the keps from PE0SAT and CelesTrak the first time.

## Put it on the internet
Any host that runs Node 18+ and keeps a disk between restarts works: a small VPS, Railway or Fly.io with a volume, or the server you already have.
Free hosts that erase their disk on restart lose the stats and the station map (the keps come back by themselves).
Run `node server.js` (or `npm start`) and make the host send traffic to the PORT it gives you.
Use HTTPS. The Windows web app and phones need an https:// address.

## Settings (environment variables, all optional)
- PORT          port to listen on (default 8787)
- DATA_DIR      where db.json and tle.json are kept (default ./data). Point it at your persistent disk.
- ALLOW_ORIGIN  who may call it from a browser (default *). Use https://sattrakr.netlify.app to lock it to the web app.
- PE0SAT_URL, CELESTRAK_URL  change the keps sources

## Endpoints (work with or without the /api prefix)
- GET  /tle                  merged keps as plain text (PE0SAT first, CelesTrak fills the gaps), refreshed every 6 hours
- POST /tle/refresh          {"source":"pe0sat" | "celestrak" | "all"}  (one refresh per source per minute)
- GET  /stats                devices, active_24h, active_30d, stations, launches, pings, events
- POST /stats/ping           {"device_id","callsign","grid"}
- POST /stats/event          {"kind","device_id"}  any kind made of letters, numbers and _ . : -
- GET  /stats/map            {"count", "stations":[{"callsign","grid","lat","lon","last_seen"}]}

## Privacy
The map only shows each station's 4-character grid square (about 100 x 200 km) and callsign, for stations seen in the last 30 days.
Device IDs are never shown. The full 6-character grid is stored on the server but is not published.

## Backups
Copy the DATA_DIR folder now and then. db.json holds all stats and stations.
