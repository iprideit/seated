import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Plus, Trash2, Users, Grid3x3, LayoutGrid, QrCode, Camera,
  Download, Mail, Check, X, Upload, Circle, Square, RectangleHorizontal,
  Settings, Cloud, CloudOff, Search, RotateCcw, Calendar, ChevronDown, UserPlus
} from "lucide-react";
import qrcode from "qrcode-generator";

/* ============================================================
   Event Seating & Check-In — Multi-event edition
   - Master PEOPLE list (one permanent QR per person)
   - Multiple EVENTS, each "seated" or "general" admission
   - Each seated event has its own TABLES (floor plan)
   - ATTENDANCE links a person to an event (seat + checked_in)
   - Smart door scan: pre-seated -> check in + seat green;
     unseated at a seated event -> prompt staff to seat;
     general event -> just check in. Walk-ups added at door.
   - Storage: Supabase (persisted per device), memory fallback
   ============================================================ */

const uid = () => Math.random().toString(36).slice(2, 10);
const initials = (name) => {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// ---------- Supabase data layer ----------
function makeSupabase(url, key) {
  const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" };
  const base = url.replace(/\/$/, "") + "/rest/v1";
  const req = async (path, opts = {}) => {
    const r = await fetch(base + path, { ...opts, headers: { ...h, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };
  const merge = { Prefer: "resolution=merge-duplicates,return=representation" };
  return {
    listEvents: () => req("/events?select=*&order=created_at").then(norm),
    listPeople: () => req("/people?select=*&order=created_at").then(norm),
    listTables: () => req("/tables?select=*&order=created_at").then(norm),
    listAttendance: () => req("/attendance?select=*&order=created_at").then(norm),
    upsertEvent: (e) => req("/events", { method: "POST", headers: merge, body: JSON.stringify(stamp(e)) }),
    upsertPerson: (p) => req("/people", { method: "POST", headers: merge, body: JSON.stringify(stamp(p)) }),
    upsertTable: (t) => req("/tables", { method: "POST", headers: merge, body: JSON.stringify(stamp(t)) }),
    upsertAttendance: (a) => req("/attendance", { method: "POST", headers: merge, body: JSON.stringify(stamp(a)) }),
    delEvent: (id) => req(`/events?id=eq.${id}`, { method: "DELETE" }),
    delPerson: (id) => req(`/people?id=eq.${id}`, { method: "DELETE" }),
    delTable: (id) => req(`/tables?id=eq.${id}`, { method: "DELETE" }),
    delAttendance: (id) => req(`/attendance?id=eq.${id}`, { method: "DELETE" }),
  };
}
// Add/refresh the updated_at stamp on any row we write. Strip client-only _ts.
function stamp(row) { const { _ts, ...rest } = row; return { ...rest, updated_at: Date.now() }; }
// Normalize server rows: expose updated_at as _ts for the merge logic.
function norm(rows) { return (rows || []).map(r => ({ ...r, _ts: Number(r.updated_at) || 0 })); }

// ---------- QR ----------
function qrDataUrl(text, scale = 8, margin = 4) {
  const qr = qrcode(0, "M"); qr.addData(text); qr.make();
  const n = qr.getModuleCount(); const size = (n + margin * 2) * scale;
  const c = document.createElement("canvas"); c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size); ctx.fillStyle = "#111";
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++)
    if (qr.isDark(r, col)) ctx.fillRect((col + margin) * scale, (r + margin) * scale, scale, scale);
  return c.toDataURL("image/png");
}

// ---------- seat geometry ----------
function seatPositions(shape, seats, w, h) {
  const pts = [];
  if (shape === "round") {
    const cx = w / 2, cy = h / 2, rad = Math.min(w, h) / 2 + 26;
    for (let i = 0; i < seats; i++) { const a = (i / seats) * Math.PI * 2 - Math.PI / 2; pts.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) }); }
    return pts;
  }
  const topN = Math.ceil(seats * (w / (2 * (w + h)))), botN = topN;
  const sideN = Math.max(0, Math.floor((seats - topN - botN) / 2));
  const layout = [];
  const place = (count, fn) => { for (let i = 0; i < count; i++) layout.push(fn(i, count)); };
  place(topN, (i, c) => ({ x: ((i + 1) / (c + 1)) * w, y: -26 }));
  place(sideN, (i, c) => ({ x: w + 26, y: ((i + 1) / (c + 1)) * h }));
  place(botN, (i, c) => ({ x: w - ((i + 1) / (c + 1)) * w, y: h + 26 }));
  place(seats - layout.length, (i, c) => ({ x: -26, y: h - ((i + 1) / (c + 1)) * h }));
  return layout.slice(0, seats);
}

// ============================================================
//  App
// ============================================================
export default function App() {
  const [view, setView] = useState("floor");
  const [events, setEvents] = useState([]);
  const [people, setPeople] = useState([]);
  const [tables, setTables] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [activeEventId, setActiveEventId] = useState(null);
  const [sb, setSb] = useState(null);
  const [sbInfo, setSbInfo] = useState(() => {
    try { const s = window.localStorage.getItem("seated_supabase"); if (s) return JSON.parse(s); } catch {}
    return { url: "", key: "" };
  });
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  // Per-row edit tracking: rows we changed in the last few seconds are protected
  // from being overwritten by an incoming refresh. Keyed by `${table}:${id}`.
  const recentEdits = useRef(new Map());
  const markEdit = (kind, id) => { recentEdits.current.set(`${kind}:${id}`, Date.now()); };
  const isProtected = (kind, id) => {
    const t = recentEdits.current.get(`${kind}:${id}`);
    return t && (Date.now() - t < 8000);
  };
  // Merge helper: for each row, keep whichever version (local or server) has the
  // newer `_ts` timestamp. This makes conflict resolution device-independent — a
  // stale echo from another device can never overwrite a newer local edit, and a
  // newer edit from another device flows in correctly. Rows we edited in the last
  // few seconds are also hard-protected as a belt-and-suspenders measure.
  const mergeRows = (kind, local, server) => {
    const serverById = new Map(server.map(r => [r.id, r]));
    const localById = new Map(local.map(r => [r.id, r]));
    const out = [];
    const seen = new Set();
    for (const r of local) {
      seen.add(r.id);
      const s = serverById.get(r.id);
      if (isProtected(kind, r.id)) { out.push(r); continue; }   // recent local edit wins
      if (!s) {
        // Not on server. Keep it only if it's a very fresh local row (server hasn't
        // caught up yet); otherwise it was deleted elsewhere -> drop.
        if ((Date.now() - (r._ts || 0)) < 8000) out.push(r);
        continue;
      }
      // Both exist: newer timestamp wins.
      const lt = r._ts || 0, st = s._ts || 0;
      out.push(st >= lt ? s : r);
    }
    for (const r of server) if (!seen.has(r.id)) out.push(r);    // new rows from others
    return out;
  };

  const notify = (m) => { setToast(m); setTimeout(() => setToast(null), 2400); };

  const refresh = useCallback(async (client, { force = false } = {}) => {
    if (!client) return;
    setLoading(true);
    try {
      const [ev, pe, tb, at] = await Promise.all([client.listEvents(), client.listPeople(), client.listTables(), client.listAttendance()]);
      if (force) {
        setEvents(ev); setPeople(pe); setTables(tb); setAttendance(at);
      } else {
        setEvents(prev => mergeRows("event", prev, ev));
        setPeople(prev => mergeRows("person", prev, pe));
        setTables(prev => mergeRows("table", prev, tb));
        setAttendance(prev => mergeRows("att", prev, at));
      }
      setActiveEventId(prev => prev || (ev[0]?.id ?? null));
    } catch (e) { notify("Sync failed: " + e.message); }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (sbInfo.url && sbInfo.key && !sb) { const client = makeSupabase(sbInfo.url, sbInfo.key); setSb(client); refresh(client, { force: true }); }
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    if (!sb) return;
    const iv = setInterval(() => { refresh(sb); }, 4000);
    return () => clearInterval(iv);
  }, [sb, refresh]);

  const connectSupabase = async (url, key) => {
    try {
      const client = makeSupabase(url, key); await client.listEvents();
      setSbInfo({ url, key });
      try { window.localStorage.setItem("seated_supabase", JSON.stringify({ url, key })); } catch {}
      setSb(client); await refresh(client); notify("Connected to Supabase");
    } catch (e) { notify("Connect failed: " + e.message); }
  };
  const disconnectSupabase = () => {
    try { window.localStorage.removeItem("seated_supabase"); } catch {}
    setSb(null); setSbInfo({ url: "", key: "" }); notify("Disconnected from this device");
  };

  const activeEvent = events.find(e => e.id === activeEventId) || null;

  // ---- EVENT ops ----
  const addEvent = async (name, kind) => {
    const e = { id: uid(), name, kind, _ts: Date.now() };
    markEdit('event', e.id);
    setEvents(p => [...p, e]); setActiveEventId(e.id);
    if (sb) try { await sb.upsertEvent(e); } catch (err) { notify(err.message); }
    return e;
  };
  const removeEvent = async (id) => {
    markEdit('event', id);
    setEvents(p => p.filter(e => e.id !== id));
    setTables(p => p.filter(t => t.event_id !== id));
    setAttendance(p => p.filter(a => a.event_id !== id));
    if (activeEventId === id) setActiveEventId(events.find(e => e.id !== id)?.id ?? null);
    if (sb) try { await sb.delEvent(id); } catch (err) { notify(err.message); }
  };

  // ---- PERSON ops ----
  const addPerson = async (data) => {
    const p = { id: uid(), token: uid() + uid(), name: data.name, email: data.email || "", _ts: Date.now() };
    markEdit('person', p.id);
    setPeople(prev => [...prev, p]);
    if (sb) try { await sb.upsertPerson(p); } catch (e) { notify(e.message); }
    return p;
  };
  const updatePerson = async (id, patch) => {
    markEdit('person', id);
    let next; setPeople(prev => prev.map(p => p.id === id ? (next = { ...p, ...patch, _ts: Date.now() }) : p));
    if (sb && next) try { await sb.upsertPerson({ id: next.id, token: next.token, name: next.name, email: next.email }); } catch (e) { notify(e.message); }
  };
  const removePerson = async (id) => {
    markEdit('person', id);
    setPeople(prev => prev.filter(p => p.id !== id));
    setAttendance(prev => prev.filter(a => a.person_id !== id));
    if (sb) try { await sb.delPerson(id); } catch (e) { notify(e.message); }
  };

  // ---- ATTENDANCE ----
  const attFor = (personId, eventId = activeEventId) => attendance.find(a => a.person_id === personId && a.event_id === eventId);
  const addToEvent = async (personId, eventId = activeEventId) => {
    if (!eventId) { notify("Create/select an event first"); return null; }
    const existing = attFor(personId, eventId); if (existing) return existing;
    const a = { id: uid(), event_id: eventId, person_id: personId, table_id: null, seat: null, checked_in: false, _ts: Date.now() };
    markEdit('att', a.id);
    setAttendance(p => [...p, a]);
    if (sb) try { await sb.upsertAttendance(a); } catch (e) { notify(e.message); }
    return a;
  };
  const updateAttendance = async (id, patch) => {
    markEdit('att', id);
    // Build the updated row deterministically from current state so the DB
    // write always reflects the intended change (no reliance on updater timing).
    const current = attendance.find(a => a.id === id);
    const next = current ? { ...current, ...patch, _ts: Date.now() } : null;
    setAttendance(p => p.map(a => a.id === id ? { ...a, ...patch, _ts: Date.now() } : a));
    if (sb && next) try { await sb.upsertAttendance(next); } catch (e) { notify(e.message); }
    return next;
  };
  const removeFromEvent = async (id) => {
    markEdit('att', id);
    setAttendance(p => p.filter(a => a.id !== id));
    if (sb) try { await sb.delAttendance(id); } catch (e) { notify(e.message); }
  };
  const assignSeat = async (personId, tableId, seat) => {
    // Find or create the attendance row for this person in the active event.
    let a = attFor(personId);
    if (!a) {
      a = { id: uid(), event_id: activeEventId, person_id: personId, table_id: null, seat: null, checked_in: false, _ts: Date.now() };
      markEdit('att', a.id);
      setAttendance(p => [...p, a]);
      if (sb) try { await sb.upsertAttendance(a); } catch (e) { notify(e.message); }
    }
    // Free any existing occupant of the target seat (in this event).
    if (tableId != null && seat != null) {
      const occ = attendance.find(x => x.event_id === activeEventId && x.table_id === tableId && x.seat === seat && x.person_id !== personId);
      if (occ) {
        markEdit('att', occ.id);
        const freed = { ...occ, table_id: null, seat: null, _ts: Date.now() };
        setAttendance(p => p.map(x => x.id === occ.id ? freed : x));
        if (sb) try { await sb.upsertAttendance(freed); } catch (e) { notify(e.message); }
      }
    }
    // Write the assignment directly from the row we hold, not from stale state.
    markEdit('att', a.id);
    const updated = { ...a, table_id: tableId, seat, _ts: Date.now() };
    setAttendance(p => p.map(x => x.id === a.id ? { ...x, table_id: tableId, seat, _ts: Date.now() } : x));
    if (sb) try { await sb.upsertAttendance(updated); } catch (e) { notify(e.message); }
  };

  // ---- TABLE ops ----
  const addTable = async (shape) => {
    if (!activeEventId) { notify("Create/select an event first"); return; }
    const evTables = tables.filter(t => t.event_id === activeEventId);
    const t = { id: uid(), event_id: activeEventId, name: `Table ${evTables.length + 1}`, shape, seats: shape === "round" ? 8 : 6, x: 120 + (evTables.length % 4) * 220, y: 120 + Math.floor(evTables.length / 4) * 240, _ts: Date.now() };
    markEdit('table', t.id);
    setTables(p => [...p, t]);
    if (sb) try { await sb.upsertTable(t); } catch (e) { notify(e.message); }
  };
  const updateTable = async (id, patch) => {
    markEdit('table', id);
    let next; setTables(p => p.map(t => t.id === id ? (next = { ...t, ...patch, _ts: Date.now() }) : t));
    if (sb && next) try { await sb.upsertTable(next); } catch (e) { notify(e.message); }
  };
  const removeTable = async (id) => {
    markEdit('table', id);
    setTables(p => p.filter(t => t.id !== id));
    setAttendance(p => p.map(a => a.table_id === id ? { ...a, table_id: null, seat: null } : a));
    if (sb) try { await sb.delTable(id); } catch (e) { notify(e.message); }
  };

  // ---- DOOR check-in ----
  const checkInByToken = async (token) => {
    if (!activeEventId) return { status: "no_event" };
    const person = people.find(p => p.token === token.trim());
    if (!person) return { status: "unknown" };
    let a = attFor(person.id); if (!a) a = await addToEvent(person.id);
    if (a.checked_in) return { status: "already", person, att: a };
    const updated = await updateAttendance(a.id, { checked_in: true });
    const seated = updated.table_id != null && updated.seat != null;
    const needsSeat = activeEvent?.kind === "seated" && !seated;
    return { status: "ok", person, att: updated, needsSeat };
  };

  const evTables = tables.filter(t => t.event_id === activeEventId);
  const evAttendance = attendance.filter(a => a.event_id === activeEventId);
  const roster = evAttendance.map(a => ({ ...a, person: people.find(p => p.id === a.person_id) })).filter(r => r.person);
  const stats = { total: roster.length, seated: roster.filter(r => r.table_id != null).length, checkedIn: roster.filter(r => r.checked_in).length };

  return (
    <div style={S.root}>
      <style>{CSSVARS}</style>
      <Header view={view} setView={setView} sb={sb} loading={loading} stats={stats}
        events={events} activeEvent={activeEvent} setActiveEventId={setActiveEventId} onRefresh={() => refresh(sb)} />
      <main style={S.main}>
        {!activeEvent && view !== "settings" && view !== "people" && view !== "events" && <NoEvent onCreate={addEvent} />}
        {activeEvent && view === "floor" && activeEvent.kind === "seated" && (
          <FloorPlan tables={evTables} roster={roster} people={people} addTable={addTable} updateTable={updateTable} removeTable={removeTable} assignSeat={assignSeat} notify={notify} />
        )}
        {activeEvent && view === "grid" && activeEvent.kind === "seated" && <TableGrid tables={evTables} roster={roster} />}
        {view === "people" && (
          <PeopleManager people={people} events={events} attendance={attendance} activeEvent={activeEvent} addPerson={addPerson} removePerson={removePerson} addToEvent={addToEvent} removeFromEvent={removeFromEvent} notify={notify} />
        )}
        {activeEvent && view === "roster" && (
          <Roster event={activeEvent} roster={roster} tables={evTables} assignSeat={assignSeat} updateAttendance={updateAttendance} removeFromEvent={removeFromEvent} />
        )}
        {activeEvent && view === "qr" && <QrCenter roster={roster} tables={evTables} event={activeEvent} notify={notify} />}
        {activeEvent && view === "scan" && (
          <Scanner event={activeEvent} checkInByToken={checkInByToken} roster={roster} tables={evTables} addPerson={addPerson} addToEvent={addToEvent} assignSeat={assignSeat} updateAttendance={updateAttendance} attFor={attFor} notify={notify} />
        )}
        {view === "events" && <EventsManager events={events} addEvent={addEvent} removeEvent={removeEvent} activeEventId={activeEventId} setActiveEventId={setActiveEventId} attendance={attendance} />}
        {view === "settings" && <SettingsPanel sb={sb} sbInfo={sbInfo} connect={connectSupabase} disconnect={disconnectSupabase} />}
      </main>
      {toast && <div style={S.toast}>{toast}</div>}
    </div>
  );
}

// ============================================================
//  Header
// ============================================================
function Header({ view, setView, sb, loading, stats, events, activeEvent, setActiveEventId, onRefresh }) {
  const [open, setOpen] = useState(false);
  const seated = activeEvent?.kind === "seated";
  const items = [
    seated && ["floor", "Floor Plan", LayoutGrid],
    seated && ["grid", "Table Grid", Grid3x3],
    ["people", "People", Users],
    activeEvent && ["roster", "Roster", Grid3x3],
    activeEvent && ["qr", "QR Codes", QrCode],
    activeEvent && ["scan", "Check-In", Camera],
    ["events", "Events", Calendar],
    ["settings", "Settings", Settings],
  ].filter(Boolean);
  return (
    <header style={S.header}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={S.logo}>◗ SEATED</div>
        <div style={{ position: "relative" }}>
          <button style={S.eventPick} onClick={() => setOpen(o => !o)}>
            <Calendar size={14} />{activeEvent ? activeEvent.name : "No event"}
            {activeEvent && <span style={S.eventKind}>{activeEvent.kind}</span>}<ChevronDown size={14} />
          </button>
          {open && (
            <div style={S.eventMenu} onMouseLeave={() => setOpen(false)}>
              {events.length === 0 && <div style={{ ...S.muted, padding: 10 }}>No events yet</div>}
              {events.map(e => (
                <button key={e.id} style={S.eventMenuItem} onClick={() => { setActiveEventId(e.id); setOpen(false); }}>{e.name} <span style={S.eventKind}>{e.kind}</span></button>
              ))}
              <button style={{ ...S.eventMenuItem, color: "var(--accent2)" }} onClick={() => { setView("events"); setOpen(false); }}>+ Manage events</button>
            </div>
          )}
        </div>
        {activeEvent && <div style={S.statline}><span>{stats.checkedIn}/{stats.total} in</span>{seated && <><span style={{ opacity: .4 }}>·</span><span>{stats.seated} seated</span></>}</div>}
      </div>
      <nav style={S.nav}>
        {items.map(([k, label, Icon]) => (
          <button key={k} onClick={() => setView(k)} style={{ ...S.navBtn, ...(view === k ? S.navBtnActive : {}) }}><Icon size={16} /> <span style={S.navLabel}>{label}</span></button>
        ))}
      </nav>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {sb && <button onClick={onRefresh} style={S.iconBtn} title="Refresh"><RotateCcw size={16} /></button>}
        <div title={sb ? "Live cloud sync" : "Local only"} style={{ color: sb ? "var(--ok)" : "var(--dim)", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>{sb ? <Cloud size={16} /> : <CloudOff size={16} />}{loading ? "…" : sb ? "Synced" : "Local"}</div>
      </div>
    </header>
  );
}

function NoEvent({ onCreate }) {
  const [name, setName] = useState(""); const [kind, setKind] = useState("seated");
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 16 }}>
      <Calendar size={44} color="var(--accent)" />
      <h2 style={{ margin: 0, fontFamily: DISPLAY }}>Create your first event</h2>
      <p style={S.muted}>Seated dinner (with tables) or general admission (cocktail hour, awards).</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        <input placeholder="Event name (e.g. Gala Dinner)" value={name} onChange={e => setName(e.target.value)} style={{ ...S.field, width: 260 }} />
        <select value={kind} onChange={e => setKind(e.target.value)} style={S.select}><option value="seated">Seated (has tables)</option><option value="general">General admission (no seats)</option></select>
        <button style={S.primaryBtn} onClick={() => name.trim() && onCreate(name.trim(), kind)}><Plus size={16} /> Create</button>
      </div>
    </div>
  );
}

// ============================================================
//  Events manager
// ============================================================
function EventsManager({ events, addEvent, removeEvent, activeEventId, setActiveEventId, attendance }) {
  const [name, setName] = useState(""); const [kind, setKind] = useState("seated");
  return (
    <div style={{ padding: 24, maxWidth: 760, margin: "0 auto" }}>
      <h2 style={{ fontFamily: DISPLAY }}>Events</h2>
      <div style={S.addBar}>
        <input placeholder="New event name" value={name} onChange={e => setName(e.target.value)} style={S.field} />
        <select value={kind} onChange={e => setKind(e.target.value)} style={S.select}><option value="seated">Seated (tables)</option><option value="general">General admission</option></select>
        <button style={S.primaryBtn} onClick={() => { if (name.trim()) { addEvent(name.trim(), kind); setName(""); } }}><Plus size={16} /> Add event</button>
      </div>
      <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
        {events.map(e => {
          const count = attendance.filter(a => a.event_id === e.id).length;
          const ins = attendance.filter(a => a.event_id === e.id && a.checked_in).length;
          return (
            <div key={e.id} style={{ ...S.gridCard, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}><b>{e.name}</b><span style={S.eventKind}>{e.kind}</span>{e.id === activeEventId && <span style={{ ...S.gridBadge, background: "var(--accent)", color: "#1a1407" }}>active</span>}</div>
                <div style={S.muted}>{count} invited · {ins} checked in</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {e.id !== activeEventId && <button style={S.ghostBtn} onClick={() => setActiveEventId(e.id)}>Make active</button>}
                <button style={S.iconBtn} onClick={() => { if (confirm(`Delete "${e.name}"? Its tables and check-ins are removed (people stay in the master list).`)) removeEvent(e.id); }}><Trash2 size={15} /></button>
              </div>
            </div>
          );
        })}
        {events.length === 0 && <div style={S.muted}>No events yet — add one above.</div>}
      </div>
    </div>
  );
}

// ============================================================
//  Floor Plan
// ============================================================
function FloorPlan({ tables, roster, people, addTable, updateTable, removeTable, assignSeat, notify }) {
  const areaRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [picker, setPicker] = useState(null);
  const onPointerDown = (e, t) => { const rect = areaRef.current.getBoundingClientRect(); setDrag({ id: t.id, dx: e.clientX - rect.left - t.x, dy: e.clientY - rect.top - t.y }); };
  useEffect(() => {
    if (!drag) return;
    const move = (e) => { const rect = areaRef.current.getBoundingClientRect(); updateTable(drag.id, { x: Math.max(60, e.clientX - rect.left - drag.dx), y: Math.max(60, e.clientY - rect.top - drag.dy) }); };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [drag]); // eslint-disable-line
  const unseated = roster.filter(r => r.table_id == null);
  return (
    <div style={{ display: "flex", height: "100%" }}>
      <div style={S.toolbar}>
        <div style={S.toolTitle}>ADD TABLE</div>
        <button style={S.toolBtn} onClick={() => addTable("round")}><Circle size={18} /> Round</button>
        <button style={S.toolBtn} onClick={() => addTable("square")}><Square size={18} /> Square</button>
        <button style={S.toolBtn} onClick={() => addTable("rectangle")}><RectangleHorizontal size={18} /> Rectangle</button>
        <div style={{ ...S.toolTitle, marginTop: 18 }}>UNSEATED ({unseated.length})</div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {unseated.map(r => <div key={r.id} style={{ ...S.unseatChip, borderColor: r.checked_in ? "var(--ok)" : "var(--line)" }}>{r.person.name}{r.checked_in ? " ✓" : ""}</div>)}
          {unseated.length === 0 && <div style={S.muted}>Everyone seated</div>}
        </div>
        <div style={S.hint}>Green = checked in · amber = seated, not yet in · drag tables to arrange</div>
      </div>
      <div ref={areaRef} style={S.canvas}>
        {tables.length === 0 && <div style={S.empty}>Add a table to begin →</div>}
        {tables.map(t => (
          <TableNode key={t.id} t={t} roster={roster} onDown={onPointerDown} onSeat={(seat) => setPicker({ tableId: t.id, seat })} onRemove={() => removeTable(t.id)} onRename={(name) => updateTable(t.id, { name })} onSeats={(seats) => updateTable(t.id, { seats: Math.max(1, Math.min(20, seats)) })} />
        ))}
      </div>
      {picker && (
        <SeatPicker roster={roster} people={people} table={tables.find(t => t.id === picker.tableId)} seat={picker.seat}
          onPick={async (pid) => { await assignSeat(pid, picker.tableId, picker.seat); setPicker(null); }}
          onClear={async () => { const occ = roster.find(r => r.table_id === picker.tableId && r.seat === picker.seat); if (occ) await assignSeat(occ.person_id, null, null); setPicker(null); }}
          onClose={() => setPicker(null)} />
      )}
    </div>
  );
}

function TableNode({ t, roster, onDown, onSeat, onRemove, onRename, onSeats }) {
  const w = t.shape === "rectangle" ? 150 : 96, h = t.shape === "rectangle" ? 80 : 96;
  const pts = seatPositions(t.shape, t.seats, w, h);
  const occBy = (i) => roster.find(r => r.table_id === t.id && r.seat === i);
  const [nameEdit, setNameEdit] = useState(t.name);
  const [editing, setEditing] = useState(false);
  // Keep local field in sync with server value when we're NOT actively editing.
  useEffect(() => { if (!editing) setNameEdit(t.name); }, [t.name, editing]);
  const commitName = () => { setEditing(false); if (nameEdit !== t.name) onRename(nameEdit); };
  return (
    <div style={{ position: "absolute", left: t.x, top: t.y, transform: "translate(-50%,-50%)" }}>
      <div style={{ position: "relative", width: w, height: h }}>
        <div onPointerDown={(e) => onDown(e, t)} style={{ width: w, height: h, cursor: "grab", borderRadius: t.shape === "round" ? "50%" : 14, background: "linear-gradient(145deg,var(--surface2),var(--surface))", border: "2px solid var(--line)", boxShadow: "0 8px 24px rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", userSelect: "none" }}>
          <input value={nameEdit}
            onFocus={() => setEditing(true)}
            onChange={e => setNameEdit(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
            onPointerDown={e => e.stopPropagation()} style={S.tableName} />
          <div style={S.seatCount}><button onPointerDown={e => e.stopPropagation()} onClick={() => onSeats(t.seats - 1)} style={S.tinyBtn}>−</button>{t.seats}<button onPointerDown={e => e.stopPropagation()} onClick={() => onSeats(t.seats + 1)} style={S.tinyBtn}>+</button></div>
        </div>
        <button onClick={onRemove} style={S.delTable}><Trash2 size={12} /></button>
        {pts.map((p, i) => {
          const r = occBy(i); const color = r ? (r.checked_in ? "var(--ok)" : "var(--accent)") : "var(--line)";
          return (
            <button key={i} onClick={() => onSeat(i)} title={r ? r.person.name : "Empty"} style={{ position: "absolute", left: p.x, top: p.y, transform: "translate(-50%,-50%)", width: 30, height: 30, borderRadius: "50%", cursor: "pointer", fontSize: 10, fontWeight: 700, border: "2px solid " + color, background: r ? color : "var(--surface)", color: r ? "#0a0a0a" : "var(--dim)", display: "flex", alignItems: "center", justifyContent: "center" }}>{r ? (r.checked_in ? <Check size={13} /> : initials(r.person.name)) : i + 1}</button>
          );
        })}
      </div>
    </div>
  );
}

function SeatPicker({ roster, people, table, seat, onPick, onClear, onClose }) {
  const [q, setQ] = useState("");
  const current = roster.find(r => r.table_id === table.id && r.seat === seat);
  const seatedIds = new Set(roster.filter(r => r.table_id != null).map(r => r.person_id));
  const avail = people.filter(p => !seatedIds.has(p.id)).filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={S.modalWrap} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.modalHead}><div><b>{table.name}</b> · Seat {seat + 1}</div><button onClick={onClose} style={S.iconBtn}><X size={18} /></button></div>
        {current && <div style={S.currentRow}><span>Seated: <b>{current.person.name}</b></span><button onClick={onClear} style={S.clearBtn}>Remove</button></div>}
        <div style={S.searchBox}><Search size={15} /><input autoFocus placeholder="Search people…" value={q} onChange={e => setQ(e.target.value)} style={S.searchInput} /></div>
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {avail.map(p => (<button key={p.id} onClick={() => onPick(p.id)} style={S.pickRow}><span>{p.name}</span><span style={S.muted}>{p.email}</span></button>))}
          {avail.length === 0 && <div style={S.muted}>No people match</div>}
        </div>
      </div>
    </div>
  );
}

// ============================================================
//  Table Grid
// ============================================================
function TableGrid({ tables, roster }) {
  return (
    <div style={S.gridWrap}>
      {tables.length === 0 && <div style={S.empty}>No tables yet</div>}
      {tables.map(t => {
        const occ = roster.filter(r => r.table_id === t.id).sort((a, b) => a.seat - b.seat);
        const inCount = occ.filter(r => r.checked_in).length;
        return (
          <div key={t.id} style={S.gridCard}>
            <div style={S.gridCardHead}><div style={{ display: "flex", alignItems: "center", gap: 8 }}>{t.shape === "round" ? <Circle size={16} /> : t.shape === "rectangle" ? <RectangleHorizontal size={16} /> : <Square size={16} />}<b>{t.name}</b></div><span style={S.gridBadge}>{inCount}/{occ.length} in</span></div>
            <div style={S.seatList}>
              {Array.from({ length: t.seats }).map((_, i) => {
                const r = occ.find(x => x.seat === i);
                return (
                  <div key={i} style={{ ...S.seatRow, borderColor: r ? (r.checked_in ? "var(--ok)" : "var(--accent)") : "var(--line)" }}>
                    <span style={S.seatNum}>{i + 1}</span><span style={{ flex: 1 }}>{r ? r.person.name : <i style={S.muted}>empty</i>}</span>
                    {r && (r.checked_in ? <Check size={15} color="var(--ok)" /> : <Circle size={9} color="var(--accent)" />)}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
//  People manager
// ============================================================
function PeopleManager({ people, events, attendance, activeEvent, addPerson, removePerson, addToEvent, removeFromEvent, notify }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState("");
  const fileRef = useRef(null);
  const importFile = async (file) => {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    let n = 0;
    for (const r of rows) {
      const nm = r.Name || r.name || r.NAME || Object.values(r)[0];
      const em = r.Email || r.email || r.EMAIL || "";
      if (nm) { const p = await addPerson({ name: String(nm).trim(), email: String(em).trim() }); if (activeEvent) await addToEvent(p.id, activeEvent.id); n++; }
    }
    notify(`Imported ${n} people${activeEvent ? ` into ${activeEvent.name}` : ""}`);
  };
  return (
    <div style={{ padding: 24, height: "100%", overflowY: "auto" }}>
      <div style={S.addBar}>
        <input placeholder="Person name" value={name} onChange={e => setName(e.target.value)} style={S.field} />
        <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} style={S.field} />
        <button style={S.primaryBtn} onClick={async () => { if (!name.trim()) return; const p = await addPerson({ name: name.trim(), email: email.trim() }); if (activeEvent) await addToEvent(p.id, activeEvent.id); setName(""); setEmail(""); }}><Plus size={16} /> Add</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => e.target.files[0] && importFile(e.target.files[0])} />
        <button style={S.ghostBtn} onClick={() => fileRef.current.click()}><Upload size={16} /> Import Excel/CSV</button>
      </div>
      <div style={S.importHint}>New people join the master list{activeEvent ? <> and are invited to <b>{activeEvent.name}</b></> : <> (select an event to also invite them)</>}. Check the box under an event to invite/uninvite. Columns: <b>Name</b>, <b>Email</b>.</div>
      <table style={S.table}>
        <thead><tr><th style={S.th}>Name</th><th style={S.th}>Email</th>{events.map(e => <th key={e.id} style={S.th}>{e.name}</th>)}<th style={S.th}></th></tr></thead>
        <tbody>
          {people.map(p => (
            <tr key={p.id} style={S.tr}>
              <td style={S.td}>{p.name}</td>
              <td style={{ ...S.td, ...S.muted }}>{p.email || "—"}</td>
              {events.map(e => {
                const a = attendance.find(x => x.person_id === p.id && x.event_id === e.id);
                return (<td key={e.id} style={S.td}><input type="checkbox" checked={!!a} onChange={async () => { if (a) await removeFromEvent(a.id); else await addToEvent(p.id, e.id); }} />{a?.checked_in && <span style={{ color: "var(--ok)", marginLeft: 6, fontSize: 11 }}>in</span>}</td>);
              })}
              <td style={S.td}><button onClick={() => removePerson(p.id)} style={S.iconBtn}><Trash2 size={15} /></button></td>
            </tr>
          ))}
          {people.length === 0 && <tr><td colSpan={3 + events.length} style={{ ...S.td, ...S.muted, textAlign: "center", padding: 40 }}>No people yet — add or import.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
//  Roster
// ============================================================
function Roster({ event, roster, tables, assignSeat, updateAttendance, removeFromEvent }) {
  const seated = event.kind === "seated";
  return (
    <div style={{ padding: 24, height: "100%", overflowY: "auto" }}>
      <h2 style={{ fontFamily: DISPLAY, marginTop: 0 }}>{event.name} <span style={S.eventKind}>{event.kind}</span></h2>
      <table style={S.table}>
        <thead><tr><th style={S.th}>Name</th><th style={S.th}>Email</th>{seated && <th style={S.th}>Table</th>}{seated && <th style={S.th}>Seat</th>}<th style={S.th}>Status</th><th style={S.th}></th></tr></thead>
        <tbody>
          {roster.map(r => {
            const t = tables.find(x => x.id === r.table_id);
            return (
              <tr key={r.id} style={S.tr}>
                <td style={S.td}>{r.person.name}</td>
                <td style={{ ...S.td, ...S.muted }}>{r.person.email || "—"}</td>
                {seated && <td style={S.td}>
                  <select value={r.table_id || ""} onChange={async e => { const tid = e.target.value || null; if (!tid) { await assignSeat(r.person_id, null, null); return; } const occupied = roster.filter(x => x.table_id === tid).map(x => x.seat); const tt = tables.find(x => x.id === tid); let s = 0; while (occupied.includes(s) && s < tt.seats) s++; await assignSeat(r.person_id, tid, s); }} style={S.select}>
                    <option value="">— none —</option>{tables.map(tt => <option key={tt.id} value={tt.id}>{tt.name}</option>)}
                  </select>
                </td>}
                {seated && <td style={S.td}>{t ? r.seat + 1 : "—"}</td>}
                <td style={S.td}>{r.checked_in ? <span style={S.tagOk}><Check size={12} /> In</span> : <button style={S.tagBtn} onClick={() => updateAttendance(r.id, { checked_in: true })}>Check-In</button>}</td>
                <td style={S.td}><button onClick={() => removeFromEvent(r.id)} style={S.iconBtn} title="Remove from event"><X size={15} /></button></td>
              </tr>
            );
          })}
          {roster.length === 0 && <tr><td colSpan={seated ? 6 : 4} style={{ ...S.td, ...S.muted, textAlign: "center", padding: 40 }}>No one invited yet. Invite people on the People tab.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
//  QR center
// ============================================================
function QrCenter({ roster, tables, event, notify }) {
  const [previews, setPreviews] = useState({});
  const [sending, setSending] = useState(null);
  const invited = roster.map(r => ({ ...r.person, _att: r }));
  useEffect(() => { const m = {}; invited.forEach(p => { m[p.id] = qrDataUrl(p.token, 4, 2); }); setPreviews(m); /* eslint-disable-next-line */ }, [roster.length]);
  const tableName = (id) => tables.find(t => t.id === id)?.name || null;
  const downloadOne = (p) => { const a = document.createElement("a"); a.href = qrDataUrl(p.token, 10, 4); a.download = `qr-${p.name.replace(/\s+/g, "_")}.png`; a.click(); };
  const mailtoFallback = (p) => { const body = `Hi ${p.name},\n\nYou're confirmed for ${event.name}.\nPlease present your QR code at check-in. Code ID: ${p.token}\n\nSee you there!`; window.location.href = `mailto:${encodeURIComponent(p.email || "")}?subject=${encodeURIComponent(event.name + " — Check-In QR Code")}&body=${encodeURIComponent(body)}`; };
  const emailOne = async (p) => {
    if (!p.email) { notify("No email for " + p.name); return; }
    setSending(p.id); const tn = tableName(p._att?.table_id);
    try {
      const res = await fetch("/api/send-qr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: p.email, name: p.name, token: p.token, qrPng: qrDataUrl(p.token, 8, 4), event: event.name, table: tn, seat: tn ? p._att.seat + 1 : null }) });
      if (!res.ok) { if (res.status === 404 || res.status === 501) { notify("Email service not set up — opening Mail"); mailtoFallback(p); } else notify("Send failed: " + await res.text()); }
      else notify(`Sent to ${p.name}`);
    } catch { notify("Email service unreachable — opening Mail"); mailtoFallback(p); }
    setSending(null);
  };
  const emailAll = async () => { const w = invited.filter(p => p.email); if (!w.length) { notify("No emails on file"); return; } notify(`Sending ${w.length}…`); for (const p of w) await emailOne(p); notify("Done"); };
  const buildPdf = async () => {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "pt", format: "a4" }); const pw = doc.internal.pageSize.getWidth();
    const cols = 3, size = 130, gap = 24; const startX = (pw - (cols * size + (cols - 1) * gap)) / 2;
    let x = startX, y = 60, col = 0;
    doc.setFontSize(18); doc.text(`${event.name} — Check-In QR Codes`, pw / 2, 36, { align: "center" });
    for (const p of invited) {
      doc.addImage(qrDataUrl(p.token, 8, 2), "PNG", x, y, size, size);
      doc.setFontSize(10); doc.text(p.name, x + size / 2, y + size + 14, { align: "center" });
      const tn = tableName(p._att?.table_id);
      doc.setFontSize(8); doc.setTextColor(120); doc.text(tn ? `${tn} · Seat ${p._att.seat + 1}` : "General", x + size / 2, y + size + 28, { align: "center" }); doc.setTextColor(0);
      col++; x += size + gap; if (col === cols) { col = 0; x = startX; y += size + 50; } if (y > 700) { doc.addPage(); y = 60; x = startX; col = 0; }
    }
    doc.save(`${event.name}-qr-codes.pdf`); notify("PDF generated");
  };
  return (
    <div style={{ padding: 24, height: "100%", overflowY: "auto" }}>
      <div style={S.qrHeader}>
        <div><h2 style={{ margin: 0, fontFamily: DISPLAY }}>QR Codes — {event.name}</h2><div style={S.muted}>One permanent code per person. The same code works for every event they're invited to.</div></div>
        <div style={{ display: "flex", gap: 10 }}><button style={S.ghostBtn} onClick={emailAll}><Mail size={16} /> Email all</button><button style={S.primaryBtn} onClick={buildPdf}><Download size={16} /> PDF sheet (all)</button></div>
      </div>
      <div style={S.qrGrid}>
        {invited.map(p => {
          const tn = tableName(p._att?.table_id);
          return (
            <div key={p.id} style={S.qrCard}>
              <img src={previews[p.id]} alt="" style={S.qrImg} />
              <div style={S.qrName}>{p.name}</div>
              <div style={S.muted}>{tn ? `${tn} · S${p._att.seat + 1}` : "General admission"}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button style={S.miniBtn} onClick={() => downloadOne(p)}><Download size={13} /> PNG</button>
                <button style={S.miniBtn} disabled={sending === p.id} onClick={() => emailOne(p)}><Mail size={13} /> {sending === p.id ? "…" : "Email"}</button>
              </div>
            </div>
          );
        })}
        {invited.length === 0 && <div style={S.empty}>No one invited to this event yet</div>}
      </div>
    </div>
  );
}

// ============================================================
//  Scanner
// ============================================================
function Scanner({ event, checkInByToken, roster, tables, addPerson, addToEvent, assignSeat, updateAttendance, attFor, notify }) {
  const videoRef = useRef(null);
  const [active, setActive] = useState(false);
  const [last, setLast] = useState(null);
  const [manual, setManual] = useState("");
  const [seatPrompt, setSeatPrompt] = useState(null);
  const [walkup, setWalkup] = useState(false);
  const streamRef = useRef(null); const rafRef = useRef(null); const detRef = useRef(null); const cooldown = useRef(0);
  const stop = useCallback(() => { setActive(false); cancelAnimationFrame(rafRef.current); if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }, []);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream; videoRef.current.srcObject = stream; await videoRef.current.play(); setActive(true);
      if ("BarcodeDetector" in window) { detRef.current = new window.BarcodeDetector({ formats: ["qr_code"] }); loopNative(); }
      else { const jsQR = (await import("jsqr")).default; loopJsqr(jsQR); }
    } catch (e) { alert("Camera error: " + e.message); }
  };
  const handle = async (token) => {
    const now = Date.now(); if (now - cooldown.current < 1600) return; cooldown.current = now;
    const res = await checkInByToken(token);
    if (res.status === "unknown") { notify("Unknown code"); return; }
    if (res.status === "no_event") { notify("Select an event first"); return; }
    if (res.status === "already") { setLast({ name: res.person.name, note: "already checked in" }); return; }
    setLast({ name: res.person.name, note: "checked in" });
    if (res.needsSeat) setSeatPrompt({ person: res.person });
  };
  const loopNative = async () => { if (!videoRef.current) return; try { const c = await detRef.current.detect(videoRef.current); if (c[0]) handle(c[0].rawValue); } catch {} rafRef.current = requestAnimationFrame(loopNative); };
  const loopJsqr = (jsQR) => { const v = videoRef.current; if (!v) return; const c = document.createElement("canvas"); const tick = () => { if (v.readyState === v.HAVE_ENOUGH_DATA) { c.width = v.videoWidth; c.height = v.videoHeight; const ctx = c.getContext("2d"); ctx.drawImage(v, 0, 0, c.width, c.height); const img = ctx.getImageData(0, 0, c.width, c.height); const code = jsQR(img.data, img.width, img.height); if (code) handle(code.data); } rafRef.current = requestAnimationFrame(tick); }; tick(); };
  useEffect(() => () => stop(), [stop]);
  return (
    <div style={S.scanWrap}>
      <div style={{ fontSize: 13, color: "var(--dim)" }}>Checking in to: <b style={{ color: "var(--accent2)" }}>{event.name}</b> <span style={S.eventKind}>{event.kind}</span></div>
      <div style={S.scanStage}>
        <video ref={videoRef} style={{ ...S.video, display: active ? "block" : "none" }} playsInline muted />
        {active && <div style={S.scanFrame} />}
        {!active && <div style={S.scanIdle}><Camera size={48} color="var(--accent)" /><p>Point the camera at a guest's QR code</p><button style={S.primaryBtn} onClick={start}><Camera size={16} /> Start camera</button></div>}
        {active && <button style={S.stopBtn} onClick={stop}>Stop</button>}
      </div>
      {last && <div style={{ ...S.scanResult, background: last.note === "checked in" ? "var(--ok)" : "var(--accent)" }}><Check size={20} /> {last.name} — {last.note}</div>}
      <div style={S.manualBox}><input placeholder="Or type/paste a code token…" value={manual} onChange={e => setManual(e.target.value)} style={S.field} /><button style={S.ghostBtn} onClick={() => { handle(manual); setManual(""); }}>Check in</button></div>
      <button style={{ ...S.ghostBtn, marginTop: 4 }} onClick={() => setWalkup(true)}><UserPlus size={16} /> Add walk-up guest</button>
      {seatPrompt && (
        <DoorSeatPrompt roster={roster} tables={tables} person={seatPrompt.person} onClose={() => setSeatPrompt(null)} onSeat={async (tid, seat) => { await assignSeat(seatPrompt.person.id, tid, seat); notify(`${seatPrompt.person.name} seated`); setSeatPrompt(null); }} />
      )}
      {walkup && (
        <WalkupModal event={event} tables={tables} roster={roster} onClose={() => setWalkup(false)}
          onAdd={async ({ name, email, tid, seat }) => {
            const p = await addPerson({ name, email });
            const a = await addToEvent(p.id, event.id);
            await updateAttendance(a.id, { checked_in: true, table_id: tid ?? null, seat: tid ? seat : null });
            setWalkup(false); setLast({ name, note: "checked in" }); notify(`${name} added & checked in`);
          }} />
      )}
    </div>
  );
}

function DoorSeatPrompt({ roster, tables, person, onClose, onSeat }) {
  const [tid, setTid] = useState(tables[0]?.id || "");
  const t = tables.find(x => x.id === tid);
  const taken = new Set(roster.filter(r => r.table_id === tid).map(r => r.seat));
  return (
    <div style={S.modalWrap} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.modalHead}><div>Seat <b>{person.name}</b></div><button onClick={onClose} style={S.iconBtn}><X size={18} /></button></div>
        <p style={S.muted}>They're checked in. Pick a table and an open seat.</p>
        <select value={tid} onChange={e => setTid(e.target.value)} style={{ ...S.select, width: "100%", marginBottom: 12 }}>{tables.map(tt => <option key={tt.id} value={tt.id}>{tt.name}</option>)}</select>
        {t && <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{Array.from({ length: t.seats }).map((_, i) => (<button key={i} disabled={taken.has(i)} onClick={() => onSeat(tid, i)} style={{ width: 44, height: 44, borderRadius: 10, border: "1px solid var(--line)", background: taken.has(i) ? "var(--surface)" : "var(--surface2)", color: taken.has(i) ? "var(--muted)" : "var(--text)", cursor: taken.has(i) ? "not-allowed" : "pointer", fontWeight: 600 }}>{i + 1}</button>))}</div>}
        <button style={{ ...S.ghostBtn, marginTop: 14 }} onClick={onClose}>Skip — leave unseated</button>
      </div>
    </div>
  );
}

function WalkupModal({ event, tables, roster, onClose, onAdd }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState("");
  const seated = event.kind === "seated";
  const [tid, setTid] = useState("");
  const [seat, setSeat] = useState(null);
  const t = tables.find(x => x.id === tid);
  const taken = new Set(roster.filter(r => r.table_id === tid).map(r => r.seat));
  return (
    <div style={S.modalWrap} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.modalHead}><div>Add walk-up to <b>{event.name}</b></div><button onClick={onClose} style={S.iconBtn}><X size={18} /></button></div>
        <div style={{ display: "grid", gap: 10 }}>
          <input autoFocus placeholder="Name" value={name} onChange={e => setName(e.target.value)} style={S.field} />
          <input placeholder="Email (optional)" value={email} onChange={e => setEmail(e.target.value)} style={S.field} />
          {seated && <>
            <select value={tid} onChange={e => { setTid(e.target.value); setSeat(null); }} style={S.select}><option value="">— no seat —</option>{tables.map(tt => <option key={tt.id} value={tt.id}>{tt.name}</option>)}</select>
            {t && <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{Array.from({ length: t.seats }).map((_, i) => (<button key={i} disabled={taken.has(i)} onClick={() => setSeat(i)} style={{ width: 40, height: 40, borderRadius: 9, border: "2px solid " + (seat === i ? "var(--accent)" : "var(--line)"), background: taken.has(i) ? "var(--surface)" : "var(--surface2)", color: taken.has(i) ? "var(--muted)" : "var(--text)", cursor: taken.has(i) ? "not-allowed" : "pointer", fontWeight: 600 }}>{i + 1}</button>))}</div>}
          </>}
          <button style={S.primaryBtn} onClick={() => { if (!name.trim()) return; onAdd({ name: name.trim(), email: email.trim(), tid: tid || null, seat: tid ? seat : null }); }}><UserPlus size={16} /> Add & check in</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
//  Settings
// ============================================================
function SettingsPanel({ sb, sbInfo, connect, disconnect }) {
  const [url, setUrl] = useState(sbInfo.url); const [key, setKey] = useState(sbInfo.key);
  const schema = `-- Run in Supabase SQL editor (multi-event schema)
create table events (
  id text primary key, name text, kind text default 'seated',
  created_at timestamptz default now(), updated_at bigint);
create table people (
  id text primary key, name text, email text, token text,
  created_at timestamptz default now(), updated_at bigint);
create table tables (
  id text primary key, event_id text, name text, shape text,
  seats int, x float, y float, created_at timestamptz default now(), updated_at bigint);
create table attendance (
  id text primary key, event_id text, person_id text,
  table_id text, seat int, checked_in bool default false,
  created_at timestamptz default now(), updated_at bigint);
alter table events enable row level security;
alter table people enable row level security;
alter table tables enable row level security;
alter table attendance enable row level security;
create policy "all" on events for all using (true) with check (true);
create policy "all" on people for all using (true) with check (true);
create policy "all" on tables for all using (true) with check (true);
create policy "all" on attendance for all using (true) with check (true);`;
  return (
    <div style={{ padding: 24, maxWidth: 760, margin: "0 auto" }}>
      <h2 style={{ fontFamily: DISPLAY }}>Cloud Sync (Supabase)</h2>
      <p style={S.muted}>Connection is saved on this device. Devices auto-refresh every few seconds for near-live updates across iPads.</p>
      {sb && <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderRadius: 12, background: "var(--surface)", border: "1px solid var(--ok)", marginTop: 8 }}><span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ok)", fontWeight: 600 }}><Cloud size={16} /> Connected & saved on this device</span><button style={{ ...S.ghostBtn, borderColor: "#3a2326", color: "#ff9a9a" }} onClick={disconnect}>Disconnect</button></div>}
      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <label style={S.lbl}>Project URL<input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" style={S.field} /></label>
        <label style={S.lbl}>Anon public key<input value={key} onChange={e => setKey(e.target.value)} placeholder="eyJ..." style={S.field} /></label>
        <button style={S.primaryBtn} onClick={() => connect(url.trim(), key.trim())}><Cloud size={16} /> {sb ? "Reconnect" : "Connect"}</button>
      </div>
      <h3 style={{ marginTop: 28 }}>Database schema (run once)</h3>
      <p style={S.muted}>This multi-event version uses new tables. Run this in the Supabase SQL editor before using the app.</p>
      <pre style={S.code}>{schema}</pre>
    </div>
  );
}

// ============================================================
//  Styles
// ============================================================
const CSSVARS = `
:root{--bg:#0d0f12;--surface:#161a1f;--surface2:#1d232b;--line:#2c343d;--text:#e8edf2;--dim:#8b97a5;--muted:#5d6873;--accent:#d4af6a;--accent2:#e9c889;--ok:#5ec98a;}
*{box-sizing:border-box}body{margin:0}
input,select,button{font-family:inherit}
input:focus,select:focus{outline:1px solid var(--accent)}
::placeholder{color:var(--muted)}button{transition:.15s}
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Outfit:wght@300;400;500;600&display=swap');
`;
const FONT = "'Outfit',system-ui,sans-serif"; const DISPLAY = "'Fraunces',Georgia,serif";
const S = {
  root: { height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)", fontFamily: FONT, fontSize: 14 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", borderBottom: "1px solid var(--line)", background: "var(--surface)", gap: 12, flexWrap: "wrap" },
  logo: { fontFamily: DISPLAY, fontSize: 22, fontWeight: 600, letterSpacing: 1, color: "var(--accent)" },
  eventPick: { display: "flex", alignItems: "center", gap: 7, padding: "7px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontWeight: 500 },
  eventKind: { fontSize: 10, padding: "2px 7px", borderRadius: 20, background: "var(--surface2)", color: "var(--dim)", textTransform: "uppercase", letterSpacing: .5 },
  eventMenu: { position: "absolute", top: "110%", left: 0, minWidth: 220, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, padding: 6, zIndex: 60, boxShadow: "0 16px 40px rgba(0,0,0,.5)" },
  eventMenuItem: { display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", width: "100%", padding: "9px 11px", border: "none", background: "transparent", color: "var(--text)", cursor: "pointer", borderRadius: 8, textAlign: "left" },
  statline: { display: "flex", gap: 8, fontSize: 12, color: "var(--dim)" },
  nav: { display: "flex", gap: 4, background: "var(--bg)", padding: 4, borderRadius: 12, border: "1px solid var(--line)", flexWrap: "wrap" },
  navBtn: { display: "flex", alignItems: "center", gap: 6, padding: "8px 11px", border: "none", borderRadius: 9, background: "transparent", color: "var(--dim)", cursor: "pointer", fontWeight: 500 },
  navBtnActive: { background: "var(--surface2)", color: "var(--accent2)" },
  navLabel: { fontSize: 13 },
  iconBtn: { background: "transparent", border: "none", color: "var(--dim)", cursor: "pointer", padding: 6, borderRadius: 8, display: "inline-flex" },
  main: { flex: 1, overflow: "hidden" },
  toolbar: { width: 230, borderRight: "1px solid var(--line)", padding: 16, display: "flex", flexDirection: "column", gap: 8, background: "var(--surface)" },
  toolTitle: { fontSize: 11, letterSpacing: 1.5, color: "var(--muted)", fontWeight: 600 },
  toolBtn: { display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderRadius: 11, border: "1px solid var(--line)", background: "var(--surface2)", color: "var(--text)", cursor: "pointer", fontWeight: 500 },
  unseatChip: { padding: "7px 11px", borderRadius: 9, background: "var(--surface2)", border: "1px solid var(--line)", marginBottom: 6, fontSize: 13 },
  hint: { fontSize: 11, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 },
  canvas: { flex: 1, position: "relative", overflow: "auto", background: "radial-gradient(circle at 25% 25%, #14181d, #0d0f12)", backgroundImage: "linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px)", backgroundSize: "40px 40px" },
  empty: { position: "absolute", top: "45%", left: 0, right: 0, textAlign: "center", color: "var(--muted)", fontFamily: DISPLAY, fontSize: 20 },
  tableName: { width: 70, background: "transparent", border: "none", color: "var(--text)", textAlign: "center", fontWeight: 600, fontSize: 12 },
  seatCount: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dim)", marginTop: 2 },
  tinyBtn: { width: 18, height: 18, borderRadius: 5, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", lineHeight: 1 },
  delTable: { position: "absolute", top: -10, right: -10, width: 22, height: 22, borderRadius: "50%", border: "none", background: "#3a2326", color: "#ff9a9a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  modalWrap: { position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 80 },
  modal: { width: 420, maxWidth: "92vw", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,.5)" },
  modalHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  currentRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--surface2)", borderRadius: 10, marginBottom: 12 },
  clearBtn: { background: "#3a2326", color: "#ff9a9a", border: "none", borderRadius: 8, padding: "5px 10px", cursor: "pointer" },
  searchBox: { display: "flex", alignItems: "center", gap: 8, padding: "0 12px", background: "var(--surface2)", borderRadius: 10, marginBottom: 10, color: "var(--dim)" },
  searchInput: { flex: 1, background: "transparent", border: "none", padding: "11px 0", color: "var(--text)", fontSize: 14 },
  pickRow: { display: "flex", justifyContent: "space-between", width: "100%", padding: "11px 12px", background: "transparent", border: "none", borderBottom: "1px solid var(--line)", color: "var(--text)", cursor: "pointer", textAlign: "left" },
  gridWrap: { padding: 24, height: "100%", overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 18, alignContent: "start" },
  gridCard: { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, padding: 16 },
  gridCardHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  gridBadge: { fontSize: 11, padding: "3px 9px", borderRadius: 20, background: "var(--surface2)", color: "var(--accent2)", fontWeight: 600 },
  seatList: { display: "flex", flexDirection: "column", gap: 5 },
  seatRow: { display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 9, border: "1px solid var(--line)", background: "var(--surface2)", fontSize: 13 },
  seatNum: { width: 20, color: "var(--muted)", fontSize: 11, fontWeight: 600 },
  addBar: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 8 },
  field: { padding: "10px 13px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface2)", color: "var(--text)", fontSize: 14 },
  primaryBtn: { display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 16px", borderRadius: 10, border: "none", background: "linear-gradient(135deg,var(--accent),var(--accent2))", color: "#1a1407", fontWeight: 600, cursor: "pointer" },
  ghostBtn: { display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 16px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface2)", color: "var(--text)", cursor: "pointer", fontWeight: 500 },
  importHint: { fontSize: 12, color: "var(--muted)", marginBottom: 18 },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "10px 12px", fontSize: 11, letterSpacing: 1, color: "var(--muted)", borderBottom: "1px solid var(--line)", textTransform: "uppercase" },
  tr: { borderBottom: "1px solid var(--line)" },
  td: { padding: "11px 12px" },
  select: { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface2)", color: "var(--text)" },
  tagOk: { display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ok)", fontWeight: 600, fontSize: 13 },
  tagBtn: { padding: "5px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface2)", color: "var(--dim)", cursor: "pointer", fontSize: 12 },
  qrHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 },
  qrGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(170px,1fr))", gap: 16 },
  qrCard: { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, padding: 14, textAlign: "center" },
  qrImg: { width: "100%", borderRadius: 10, background: "#fff", padding: 8 },
  qrName: { fontWeight: 600, marginTop: 8 },
  miniBtn: { flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "7px 0", borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface2)", color: "var(--text)", cursor: "pointer", fontSize: 12 },
  scanWrap: { padding: 24, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, overflowY: "auto" },
  scanStage: { position: "relative", width: "min(560px,90vw)", aspectRatio: "1", background: "#000", borderRadius: 20, overflow: "hidden", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center" },
  video: { width: "100%", height: "100%", objectFit: "cover" },
  scanFrame: { position: "absolute", inset: "18%", border: "3px solid var(--accent)", borderRadius: 18, boxShadow: "0 0 0 9999px rgba(0,0,0,.35)" },
  scanIdle: { textAlign: "center", color: "var(--dim)", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: 24 },
  stopBtn: { position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", padding: "9px 22px", borderRadius: 20, border: "none", background: "rgba(0,0,0,.6)", color: "#fff", cursor: "pointer", backdropFilter: "blur(8px)" },
  scanResult: { display: "flex", alignItems: "center", gap: 8, padding: "12px 22px", borderRadius: 14, color: "#0a0a0a", fontWeight: 600, fontSize: 16 },
  manualBox: { display: "flex", gap: 10, width: "min(560px,90vw)" },
  lbl: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--dim)" },
  code: { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, padding: 16, fontSize: 12, color: "var(--accent2)", overflowX: "auto", lineHeight: 1.6, whiteSpace: "pre" },
  muted: { color: "var(--muted)", fontSize: 12 },
  toast: { position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--surface2)", border: "1px solid var(--accent)", color: "var(--accent2)", padding: "12px 22px", borderRadius: 30, boxShadow: "0 12px 40px rgba(0,0,0,.5)", zIndex: 100, fontWeight: 500 },
};
