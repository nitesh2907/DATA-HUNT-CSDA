/* =====================================================================
   DATA HUNT — host backend, 3-LEVEL EDITION (Cloudflare Worker + D1)

   What it does
     • /host                 the organiser console (level clocks, checkpoint, board)
     • GET  /?mode=config    the game asks: which level is open, when does it end,
                             and (with &team=KEY) has THIS team qualified?
     • POST /                the game sends live heartbeats and per-level results
     • /api/host/*           console actions (needs your HOST_PIN)

   Setup (once): bind a D1 database as  DB  and add a secret  HOST_PIN.
   Tables are created automatically on first request (new *_3l tables —
   the old 10-island tables are left untouched).
   ===================================================================== */

const HOST_PAGE_URL = 'https://data-hunt-csda.pages.dev/host/console.html';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Host-Pin',
  'Access-Control-Max-Age': '86400'
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS event_3l ( id INTEGER PRIMARY KEY CHECK (id = 1), round INTEGER NOT NULL DEFAULT 1, level INTEGER NOT NULL DEFAULT 0, open INTEGER NOT NULL DEFAULT 0, start_at INTEGER, end_at INTEGER, run_minutes INTEGER NOT NULL DEFAULT 25, paused INTEGER NOT NULL DEFAULT 0, paused_left INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)`),
    db.prepare(`INSERT OR IGNORE INTO event_3l (id) VALUES (1)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS teams_3l ( round INTEGER NOT NULL, team_key TEXT NOT NULL, team TEXT, members TEXT, emails TEXT, sets TEXT, status TEXT, cur_level INTEGER DEFAULT 0, score INTEGER DEFAULT 0, solved INTEGER DEFAULT 0, attempted INTEGER DEFAULT 0, hints INTEGER DEFAULT 0, seconds_left INTEGER, allowed_level INTEGER NOT NULL DEFAULT 1, first_seen INTEGER, last_seen INTEGER, PRIMARY KEY (round, team_key))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS levels_3l ( round INTEGER NOT NULL, team_key TEXT NOT NULL, level INTEGER NOT NULL, set_code TEXT, score INTEGER, solved INTEGER, attempted INTEGER, hints INTEGER, wrong INTEGER, skipped INTEGER, unanswered INTEGER, time_sec INTEGER, time_used TEXT, outcome TEXT, secs TEXT, pastes INTEGER, finished_at INTEGER, PRIMARY KEY (round, team_key, level))`)
  ]);
  schemaReady = true;
}

const getEvent = db => db.prepare('SELECT * FROM event_3l WHERE id = 1').first();

function publicConfig(ev, now) {
  return {
    ok: true,
    open: !!ev.open,
    level: ev.level | 0,
    startAt: ev.start_at ? new Date(ev.start_at).toISOString() : null,
    endAt: ev.end_at ? new Date(ev.end_at).toISOString() : null,
    runMinutes: ev.run_minutes,
    paused: !!ev.paused,
    pausedLeft: Math.round((ev.paused_left || 0) / 1000),
    round: ev.round,
    serverNow: now
  };
}

const str = (v, n = 200) => (v == null ? '' : String(v)).slice(0, n);
const int = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };
const keyOf = d => str(d.teamKey || ((d.team || '') + '|' + (d.emails || d.email || '')), 300).toLowerCase();

async function upsertLive(db, ev, key, d, status, now) {
  await db.prepare(`INSERT INTO teams_3l (round, team_key, team, members, emails, sets, status, cur_level, score, solved, attempted, hints, seconds_left, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (round, team_key) DO UPDATE SET team=excluded.team, members=excluded.members, emails=excluded.emails, sets=excluded.sets, status=excluded.status, cur_level=excluded.cur_level, score=excluded.score, solved=excluded.solved, attempted=excluded.attempted, hints=excluded.hints, seconds_left=excluded.seconds_left, last_seen=excluded.last_seen`)
    .bind(ev.round, key, str(d.team, 60), str(d.members, 300), str(d.emails || d.email, 400), str(d.sets, 8),
      status, int(d.level), int(d.score != null ? d.score : d.total), int(d.solved), int(d.attempted), int(d.hints), int(d.secondsLeft), now, now)
    .run();
}

async function handlePlayerPost(db, d, now) {
  const ev = await getEvent(db);
  const key = keyOf(d);
  if (!key || key === '|') return json({ ok: false, error: 'missing team' }, 400);

  if (d.kind === 'leave') {
    await db.prepare("DELETE FROM teams_3l WHERE round=? AND team_key=? AND status='registered'").bind(ev.round, key).run();
    return json({ ok: true });
  }

  if (d.kind === 'live') {
    const ok = ['registered', 'playing', 'waiting', 'out', 'done'];
    await upsertLive(db, ev, key, d, ok.includes(d.status) ? d.status : 'playing', now);
    return json({ ok: true });
  }

  if (d.kind === 'level') {
    const lvl = Math.max(1, Math.min(3, int(d.level)));
    await db.prepare(`INSERT INTO levels_3l (round, team_key, level, set_code, score, solved, attempted, hints, wrong, skipped, unanswered, time_sec, time_used, outcome, secs, pastes, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (round, team_key, level) DO UPDATE SET set_code=excluded.set_code, score=excluded.score, solved=excluded.solved, attempted=excluded.attempted, hints=excluded.hints, wrong=excluded.wrong, skipped=excluded.skipped, unanswered=excluded.unanswered, time_sec=excluded.time_sec, time_used=excluded.time_used, outcome=excluded.outcome, secs=excluded.secs, pastes=excluded.pastes, finished_at=excluded.finished_at`)
      .bind(ev.round, key, lvl, str(d.set, 2), Math.max(0, int(d.score)), int(d.solved), int(d.attempted), int(d.hints), int(d.wrong),
        int(d.skipped), int(d.unanswered), int(d.timeSec), str(d.time, 12), str(d.outcome, 60),
        JSON.stringify(Array.isArray(d.secs) ? d.secs.slice(0, 5) : []), int(d.pastes), now)
      .run();
    await upsertLive(db, ev, key, Object.assign({}, d, { score: d.total, secondsLeft: 0 }), lvl === 3 ? 'done' : 'waiting', now);
    return json({ ok: true });
  }
  return json({ ok: false, error: 'unknown kind' }, 400);
}

async function handleHostAction(db, body, now) {
  const ev = await getEvent(db);
  let s = null;
  const running = ev.open && (ev.paused || (ev.end_at && ev.end_at > now));
  switch (body.action) {
    case 'start': {
      const lvl = int(body.level);
      if (lvl < 1 || lvl > 3) return json({ ok: false, error: 'Level must be 1, 2 or 3.' });
      if (running) return json({ ok: false, error: 'Level ' + ev.level + ' is still running. End it first.' });
      if (lvl !== (ev.level | 0) + 1) return json({ ok: false, error: 'The next level to start is Level ' + ((ev.level | 0) + 1) + '.' });
      const mins = Math.max(1, Math.min(600, int(body.minutes) || 25));
      const stmts = [];
      if (lvl >= 2) {
        const q = Array.isArray(body.qualified) ? body.qualified.map(k => str(k, 300)).filter(Boolean) : [];
        if (!q.length) return json({ ok: false, error: 'No team is marked as qualified.' });
        for (const k of q) stmts.push(db.prepare('UPDATE teams_3l SET allowed_level=? WHERE round=? AND team_key=? AND allowed_level>=?').bind(lvl, ev.round, k, lvl - 1));
      }
      stmts.push(db.prepare('UPDATE event_3l SET level=?, open=1, paused=0, paused_left=0, start_at=?, end_at=?, run_minutes=?, updated_at=? WHERE id=1')
        .bind(lvl, now, now + mins * 60000, mins, now));
      await db.batch(stmts);
      return json({ ok: true, config: publicConfig(await getEvent(db), Date.now()) });
    }
    case 'pause':
      if (ev.paused || !ev.end_at || ev.end_at <= now) return json({ ok: false, error: 'Nothing is running to pause.' });
      s = db.prepare('UPDATE event_3l SET paused=1, paused_left=?, end_at=NULL, updated_at=? WHERE id=1').bind(ev.end_at - now, now);
      break;
    case 'resume':
      if (!ev.paused) return json({ ok: false, error: 'The clock is not paused.' });
      s = db.prepare('UPDATE event_3l SET paused=0, end_at=?, paused_left=0, updated_at=? WHERE id=1').bind(now + ev.paused_left, now);
      break;
    case 'add': {
      const delta = Math.max(-600, Math.min(600, int(body.minutes))) * 60000;
      if (ev.paused) s = db.prepare('UPDATE event_3l SET paused_left=?, updated_at=? WHERE id=1').bind(Math.max(0, ev.paused_left + delta), now);
      else if (ev.end_at && ev.end_at > now) s = db.prepare('UPDATE event_3l SET end_at=?, updated_at=? WHERE id=1').bind(Math.max(now, ev.end_at + delta), now);
      else return json({ ok: false, error: 'Start a level first.' });
      break;
    }
    case 'end':
      if (!ev.open || !running) return json({ ok: false, error: 'No level is running.' });
      s = db.prepare('UPDATE event_3l SET paused=0, paused_left=0, end_at=?, updated_at=? WHERE id=1').bind(now, now);
      break;
    case 'reset':
      s = db.prepare('UPDATE event_3l SET round=round+1, level=0, open=0, paused=0, paused_left=0, start_at=NULL, end_at=NULL, updated_at=? WHERE id=1').bind(now);
      break;
    case 'remove':
      await db.batch([
        db.prepare('DELETE FROM teams_3l WHERE round=? AND team_key=?').bind(ev.round, str(body.teamKey, 300)),
        db.prepare('DELETE FROM levels_3l WHERE round=? AND team_key=?').bind(ev.round, str(body.teamKey, 300))
      ]);
      return json({ ok: true });
    default:
      return json({ ok: false, error: 'Unknown action' }, 400);
  }
  await s.run();
  return json({ ok: true, config: publicConfig(await getEvent(db), Date.now()) });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (path === '/host') {
      const page = await fetch(HOST_PAGE_URL + '?v=' + Date.now(), { cf: { cacheTtl: 0 } });
      return new Response(await page.text(), { status: page.ok ? 200 : 502, headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (!env.DB) return json({ ok: false, error: 'No D1 database bound. Add a D1 binding named DB in the Worker settings.' }, 500);
    const db = env.DB;
    await ensureSchema(db);
    const now = Date.now();

    try {
      if (path.startsWith('/api/host/')) {
        if (!env.HOST_PIN) return json({ ok: false, error: 'HOST_PIN is not set. Add it under Worker → Settings → Variables and Secrets.' }, 500);
        if (req.headers.get('X-Host-Pin') !== String(env.HOST_PIN)) return json({ ok: false, error: 'Wrong host PIN.' }, 401);
        if (path === '/api/host/board') {
          const ev = await getEvent(db);
          const round = url.searchParams.get('round') ? int(url.searchParams.get('round')) : ev.round;
          const t = await db.prepare('SELECT * FROM teams_3l WHERE round=? ORDER BY first_seen').bind(round).all();
          const l = await db.prepare('SELECT * FROM levels_3l WHERE round=?').bind(round).all();
          return json({ ok: true, config: publicConfig(ev, now), round, teams: t.results, levels: l.results });
        }
        if (path === '/api/host/action' && req.method === 'POST') {
          return handleHostAction(db, await req.json().catch(() => ({})), now);
        }
        return json({ ok: false, error: 'Not found' }, 404);
      }

      if (req.method === 'GET') {
        const ev = await getEvent(db);
        const cfg = publicConfig(ev, now);
        const tk = url.searchParams.get('team');
        if (tk) {
          const row = await db.prepare('SELECT allowed_level FROM teams_3l WHERE round=? AND team_key=?').bind(ev.round, str(tk, 300).toLowerCase()).first();
          cfg.me = row ? { known: true, allowed: row.allowed_level | 0 } : { known: false, allowed: 0 };
        }
        return json(cfg);
      }
      if (req.method === 'POST' && path === '/') {
        let d; try { d = JSON.parse(await req.text()); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
        return handlePlayerPost(db, d || {}, now);
      }
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500);
    }
  }
};
