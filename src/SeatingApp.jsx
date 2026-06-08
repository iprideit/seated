import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Plus, Trash2, Users, Grid3x3, LayoutGrid, QrCode, Camera,
  Download, Mail, Check, X, Upload, Circle, Square, RectangleHorizontal,
  Settings, Cloud, CloudOff, Search, RotateCcw
} from "lucide-react";

/* ============================================================
   Event Seating & Check-In
   - Tables: round / square / rectangle, configurable seats
   - Guests: manual entry or Excel/CSV import
   - QR codes: per guest (download PNG + mailto + PDF sheet)
   - Check-in: iPad camera QR scanner -> seat flips to "taken"
   - Views: floor plan + table grid
   - Storage: Supabase when configured, else in-memory session
   ============================================================ */

// ---------- tiny utilities ----------
const uid = () => Math.random().toString(36).slice(2, 10);
const cls = (...a) => a.filter(Boolean).join(" ");

// ---------- Data layer (Supabase-ready, memory fallback) ----------
// All reads/writes go through `db`. When a Supabase URL+key are saved,
// it talks to two tables: `tables` and `guests`. Otherwise it keeps
// everything in React state so the app is usable immediately.
//
// Supabase schema (run in SQL editor):
//   create table tables (
//     id text primary key, name text, shape text,
//     seats int, x float, y float, created_at timestamptz default now()
//   );
//   create table guests (
//     id text primary key, name text, email text,
//     table_id text, seat int, checked_in bool default false,
//     token text, created_at timestamptz default now()
//   );
//   alter table tables enable row level security;
//   alter table guests enable row level security;
//   create policy "all" on tables for all using (true) with check (true);
//   create policy "all" on guests for all using (true) with check (true);

function makeSupabase(url, key) {
  const h = {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
  const base = url.replace(/\/$/, "") + "/rest/v1";
  const req = async (path, opts = {}) => {
    const r = await fetch(base + path, { ...opts, headers: { ...h, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };
  return {
    listTables: () => req("/tables?select=*&order=created_at"),
    listGuests: () => req("/guests?select=*&order=created_at"),
    upsertTable: (t) => req("/tables", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(t) }),
    upsertGuest: (g) => req("/guests", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(g) }),
    delTable: (id) => req(`/tables?id=eq.${id}`, { method: "DELETE" }),
    delGuest: (id) => req(`/guests?id=eq.${id}`, { method: "DELETE" }),
  };
}

// ---------- QR code generation (no external lib) ----------
// Minimal QR encoder (byte mode, error-correction L, auto version 1-10).
// Adapted compact implementation; renders to a canvas.
// For brevity and reliability we use the well-known qrcode-generator
// algorithm inlined below.
import qrcode from "qrcode-generator";

function qrDataUrl(text, scale = 8, margin = 4) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + margin * 2) * scale;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#111111";
  for (let r = 0; r < n; r++)
    for (let col = 0; col < n; col++)
      if (qr.isDark(r, col))
        ctx.fillRect((col + margin) * scale, (r + margin) * scale, scale, scale);
  return c.toDataURL("image/png");
}

// ---------- Seat geometry ----------
function seatPositions(shape, seats, w, h) {
  const pts = [];
  if (shape === "round") {
    const cx = w / 2, cy = h / 2, rad = Math.min(w, h) / 2 + 26;
    for (let i = 0; i < seats; i++) {
      const a = (i / seats) * Math.PI * 2 - Math.PI / 2;
      pts.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
    }
    return pts;
  }
  // rectangle / square: distribute around perimeter
  const per = seats;
  const topN = Math.ceil(per * (w / (2 * (w + h))));
  const botN = topN;
  const sideN = Math.max(0, Math.floor((per - topN - botN) / 2));
  const layout = [];
  const place = (count, fn) => { for (let i = 0; i < count; i++) layout.push(fn(i, count)); };
  place(topN, (i, c) => ({ x: ((i + 1) / (c + 1)) * w, y: -26 }));
  place(sideN, (i, c) => ({ x: w + 26, y: ((i + 1) / (c + 1)) * h }));
  place(botN, (i, c) => ({ x: w - ((i + 1) / (c + 1)) * w, y: h + 26 }));
  place(per - layout.length, (i, c) => ({ x: -26, y: h - ((i + 1) / (c + 1)) * h }));
  return layout.slice(0, seats);
}

// ============================================================
//  Main App
// ============================================================
export default function App() {
  const [view, setView] = useState("floor"); // floor | grid | guests | qr | scan | settings
  const [tables, setTables] = useState([]);
  const [guests, setGuests] = useState([]);
  const [sb, setSb] = useState(null);
  // Load any previously-saved connection from this browser's local storage.
  const [sbInfo, setSbInfo] = useState(() => {
    try {
      const saved = window.localStorage.getItem("seated_supabase");
      if (saved) return JSON.parse(saved);
    } catch {}
    return { url: "", key: "" };
  });
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  const notify = (m) => { setToast(m); setTimeout(() => setToast(null), 2200); };

  // On first load, if we have saved credentials, reconnect automatically.
  useEffect(() => {
    if (sbInfo.url && sbInfo.key && !sb) {
      const client = makeSupabase(sbInfo.url, sbInfo.key);
      setSb(client);
      refresh(client);
    }
    // eslint-disable-next-line
  }, []);

  const refresh = useCallback(async (client) => {
    if (!client) return;
    setLoading(true);
    try {
      const [t, g] = await Promise.all([client.listTables(), client.listGuests()]);
      setTables(t.map(r => ({ id: r.id, name: r.name, shape: r.shape, seats: r.seats, x: r.x, y: r.y })));
      setGuests(g.map(r => ({ id: r.id, name: r.name, email: r.email, tableId: r.table_id, seat: r.seat, checkedIn: r.checked_in, token: r.token })));
    } catch (e) { notify("Sync failed: " + e.message); }
    setLoading(false);
  }, []);

  const connectSupabase = async (url, key) => {
    try {
      const client = makeSupabase(url, key);
      await client.listTables(); // probe
      setSbInfo({ url, key });
      // Remember this connection on this device so refreshing keeps you synced.
      try { window.localStorage.setItem("seated_supabase", JSON.stringify({ url, key })); } catch {}
      setSb(client);
      await refresh(client);
      notify("Connected to Supabase");
    } catch (e) { notify("Connect failed: " + e.message); }
  };

  const disconnectSupabase = () => {
    try { window.localStorage.removeItem("seated_supabase"); } catch {}
    setSb(null);
    setSbInfo({ url: "", key: "" });
    notify("Disconnected — connection cleared from this device");
  };

  // ---- table ops ----
  const addTable = async (shape) => {
    const t = { id: uid(), name: `Table ${tables.length + 1}`, shape, seats: shape === "round" ? 8 : 6, x: 120 + (tables.length % 4) * 220, y: 120 + Math.floor(tables.length / 4) * 240 };
    setTables(p => [...p, t]);
    if (sb) { try { await sb.upsertTable({ id: t.id, name: t.name, shape: t.shape, seats: t.seats, x: t.x, y: t.y }); } catch (e) { notify(e.message); } }
  };
  const updateTable = async (id, patch) => {
    setTables(p => p.map(t => t.id === id ? { ...t, ...patch } : t));
    if (sb) { const t = { ...tables.find(x => x.id === id), ...patch }; try { await sb.upsertTable({ id: t.id, name: t.name, shape: t.shape, seats: t.seats, x: t.x, y: t.y }); } catch (e) { notify(e.message); } }
  };
  const removeTable = async (id) => {
    setTables(p => p.filter(t => t.id !== id));
    setGuests(p => p.map(g => g.tableId === id ? { ...g, tableId: null, seat: null } : g));
    if (sb) { try { await sb.delTable(id); } catch (e) { notify(e.message); } }
  };

  // ---- guest ops ----
  const addGuest = async (g) => {
    const ng = { id: uid(), token: uid() + uid(), checkedIn: false, tableId: null, seat: null, ...g };
    setGuests(p => [...p, ng]);
    if (sb) { try { await sb.upsertGuest(toRow(ng)); } catch (e) { notify(e.message); } }
    return ng;
  };
  const updateGuest = async (id, patch) => {
    let next;
    setGuests(p => p.map(g => g.id === id ? (next = { ...g, ...patch }) : g));
    if (sb && next) { try { await sb.upsertGuest(toRow(next)); } catch (e) { notify(e.message); } }
  };
  const removeGuest = async (id) => {
    setGuests(p => p.filter(g => g.id !== id));
    if (sb) { try { await sb.delGuest(id); } catch (e) { notify(e.message); } }
  };
  const toRow = (g) => ({ id: g.id, name: g.name, email: g.email, table_id: g.tableId, seat: g.seat, checked_in: g.checkedIn, token: g.token });

  // assign guest to a table seat
  const assignSeat = async (guestId, tableId, seat) => {
    // free anyone in that seat
    const occupant = guests.find(g => g.tableId === tableId && g.seat === seat && g.id !== guestId);
    if (occupant) await updateGuest(occupant.id, { tableId: null, seat: null });
    await updateGuest(guestId, { tableId, seat });
  };

  // check in by token (scanner / manual)
  const checkInByToken = async (token) => {
    const g = guests.find(x => x.token === token);
    if (!g) { notify("Unknown code"); return null; }
    if (g.checkedIn) { notify(`${g.name} already checked in`); return g; }
    await updateGuest(g.id, { checkedIn: true });
    notify(`✓ ${g.name} checked in`);
    return g;
  };

  const stats = useMemo(() => ({
    total: guests.length,
    seated: guests.filter(g => g.tableId).length,
    checkedIn: guests.filter(g => g.checkedIn).length,
  }), [guests]);

  return (
    <div style={S.root}>
      <style>{CSSVARS}</style>
      <Header view={view} setView={setView} sb={sb} loading={loading} stats={stats} onRefresh={() => refresh(sb)} />
      <main style={S.main}>
        {view === "floor" && (
          <FloorPlan tables={tables} guests={guests} addTable={addTable} updateTable={updateTable}
            removeTable={removeTable} assignSeat={assignSeat} notify={notify} />
        )}
        {view === "grid" && <TableGrid tables={tables} guests={guests} />}
        {view === "guests" && (
          <GuestManager guests={guests} tables={tables} addGuest={addGuest} updateGuest={updateGuest}
            removeGuest={removeGuest} assignSeat={assignSeat} notify={notify} />
        )}
        {view === "qr" && <QrCenter guests={guests} tables={tables} notify={notify} />}
        {view === "scan" && <Scanner checkInByToken={checkInByToken} guests={guests} />}
        {view === "settings" && <SettingsPanel sb={sb} sbInfo={sbInfo} connect={connectSupabase} disconnect={disconnectSupabase} notify={notify} />}
      </main>
      {toast && <div style={S.toast}>{toast}</div>}
    </div>
  );
}

// ============================================================
//  Header / Nav
// ============================================================
function Header({ view, setView, sb, loading, stats, onRefresh }) {
  const items = [
    ["floor", "Floor Plan", LayoutGrid],
    ["grid", "Table Grid", Grid3x3],
    ["guests", "Guests", Users],
    ["qr", "QR Codes", QrCode],
    ["scan", "Check-In", Camera],
    ["settings", "Settings", Settings],
  ];
  return (
    <header style={S.header}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={S.logo}>◗ SEATED</div>
        <div style={S.statline}>
          <span>{stats.checkedIn}/{stats.total} in</span>
          <span style={{ opacity: .4 }}>·</span>
          <span>{stats.seated} seated</span>
        </div>
      </div>
      <nav style={S.nav}>
        {items.map(([k, label, Icon]) => (
          <button key={k} onClick={() => setView(k)} style={cls ? { ...S.navBtn, ...(view === k ? S.navBtnActive : {}) } : {}}>
            <Icon size={17} /> <span style={S.navLabel}>{label}</span>
          </button>
        ))}
      </nav>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {sb && <button onClick={onRefresh} style={S.iconBtn} title="Refresh"><RotateCcw size={16} /></button>}
        <div title={sb ? "Cloud synced" : "Local session only"} style={{ color: sb ? "var(--ok)" : "var(--dim)", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          {sb ? <Cloud size={16} /> : <CloudOff size={16} />} {loading ? "…" : sb ? "Synced" : "Local"}
        </div>
      </div>
    </header>
  );
}

// ============================================================
//  Floor Plan (drag tables, click seats to assign)
// ============================================================
function FloorPlan({ tables, guests, addTable, updateTable, removeTable, assignSeat, notify }) {
  const areaRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [picker, setPicker] = useState(null); // {tableId, seat}

  const onPointerDown = (e, t) => {
    const rect = areaRef.current.getBoundingClientRect();
    setDrag({ id: t.id, dx: e.clientX - rect.left - t.x, dy: e.clientY - rect.top - t.y });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e) => {
      const rect = areaRef.current.getBoundingClientRect();
      updateTable(drag.id, { x: Math.max(60, e.clientX - rect.left - drag.dx), y: Math.max(60, e.clientY - rect.top - drag.dy) });
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [drag]); // eslint-disable-line

  const unseated = guests.filter(g => !g.tableId);

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <div style={S.toolbar}>
        <div style={S.toolTitle}>ADD TABLE</div>
        <button style={S.toolBtn} onClick={() => addTable("round")}><Circle size={18} /> Round</button>
        <button style={S.toolBtn} onClick={() => addTable("square")}><Square size={18} /> Square</button>
        <button style={S.toolBtn} onClick={() => addTable("rectangle")}><RectangleHorizontal size={18} /> Rectangle</button>
        <div style={{ ...S.toolTitle, marginTop: 18 }}>UNSEATED ({unseated.length})</div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {unseated.map(g => <div key={g.id} style={S.unseatChip}>{g.name}</div>)}
          {unseated.length === 0 && <div style={S.muted}>Everyone seated</div>}
        </div>
        <div style={S.hint}>Drag tables to arrange · tap a seat to assign</div>
      </div>

      <div ref={areaRef} style={S.canvas}>
        {tables.length === 0 && <div style={S.empty}>Add a table to begin →</div>}
        {tables.map(t => (
          <TableNode key={t.id} t={t} guests={guests} onDown={onPointerDown}
            onSeat={(seat) => setPicker({ tableId: t.id, seat })}
            onRemove={() => removeTable(t.id)} onRename={(name) => updateTable(t.id, { name })}
            onSeats={(seats) => updateTable(t.id, { seats: Math.max(1, Math.min(20, seats)) })} />
        ))}
      </div>

      {picker && (
        <SeatPicker guests={guests} table={tables.find(t => t.id === picker.tableId)} seat={picker.seat}
          onPick={async (gid) => { await assignSeat(gid, picker.tableId, picker.seat); setPicker(null); }}
          onClear={async () => {
            const occ = guests.find(g => g.tableId === picker.tableId && g.seat === picker.seat);
            if (occ) await assignSeat(occ.id, null, null);
            setPicker(null);
          }}
          onClose={() => setPicker(null)} />
      )}
    </div>
  );
}

function TableNode({ t, guests, onDown, onSeat, onRemove, onRename, onSeats }) {
  const w = t.shape === "rectangle" ? 150 : 96;
  const h = t.shape === "rectangle" ? 80 : 96;
  const pts = seatPositions(t.shape, t.seats, w, h);
  const occ = guests.filter(g => g.tableId === t.id);
  const occBy = (i) => occ.find(g => g.seat === i);
  return (
    <div style={{ position: "absolute", left: t.x, top: t.y, transform: "translate(-50%,-50%)" }}>
      <div style={{ position: "relative", width: w, height: h }}>
        <div onPointerDown={(e) => onDown(e, t)} style={{
          width: w, height: h, cursor: "grab",
          borderRadius: t.shape === "round" ? "50%" : 14,
          background: "linear-gradient(145deg,var(--surface2),var(--surface))",
          border: "2px solid var(--line)", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
          display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", userSelect: "none",
        }}>
          <input value={t.name} onChange={e => onRename(e.target.value)} onPointerDown={e => e.stopPropagation()} style={S.tableName} />
          <div style={S.seatCount}>
            <button onPointerDown={e => e.stopPropagation()} onClick={() => onSeats(t.seats - 1)} style={S.tinyBtn}>−</button>
            {t.seats}
            <button onPointerDown={e => e.stopPropagation()} onClick={() => onSeats(t.seats + 1)} style={S.tinyBtn}>+</button>
          </div>
        </div>
        <button onClick={onRemove} style={S.delTable}><Trash2 size={12} /></button>
        {pts.map((p, i) => {
          const g = occBy(i);
          return (
            <button key={i} onClick={() => onSeat(i)} title={g ? g.name : "Empty"}
              style={{
                position: "absolute", left: p.x, top: p.y, transform: "translate(-50%,-50%)",
                width: 30, height: 30, borderRadius: "50%", cursor: "pointer", fontSize: 10, fontWeight: 700,
                border: "2px solid " + (g ? (g.checkedIn ? "var(--ok)" : "var(--accent)") : "var(--line)"),
                background: g ? (g.checkedIn ? "var(--ok)" : "var(--accent)") : "var(--surface)",
                color: g ? "#0a0a0a" : "var(--dim)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
              {g ? (g.checkedIn ? <Check size={13} /> : g.name.slice(0, 2).toUpperCase()) : i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SeatPicker({ guests, table, seat, onPick, onClear, onClose }) {
  const [q, setQ] = useState("");
  const current = guests.find(g => g.tableId === table.id && g.seat === seat);
  const avail = guests.filter(g => !g.tableId).filter(g => g.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={S.modalWrap} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.modalHead}>
          <div><b>{table.name}</b> · Seat {seat + 1}</div>
          <button onClick={onClose} style={S.iconBtn}><X size={18} /></button>
        </div>
        {current && (
          <div style={S.currentRow}>
            <span>Seated: <b>{current.name}</b></span>
            <button onClick={onClear} style={S.clearBtn}>Remove</button>
          </div>
        )}
        <div style={S.searchBox}><Search size={15} /><input autoFocus placeholder="Search unseated guests…" value={q} onChange={e => setQ(e.target.value)} style={S.searchInput} /></div>
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {avail.map(g => (
            <button key={g.id} onClick={() => onPick(g.id)} style={S.pickRow}>
              <span>{g.name}</span><span style={S.muted}>{g.email}</span>
            </button>
          ))}
          {avail.length === 0 && <div style={S.muted}>No unseated guests match</div>}
        </div>
      </div>
    </div>
  );
}

// ============================================================
//  Table Grid view
// ============================================================
function TableGrid({ tables, guests }) {
  return (
    <div style={S.gridWrap}>
      {tables.length === 0 && <div style={S.empty}>No tables yet</div>}
      {tables.map(t => {
        const occ = guests.filter(g => g.tableId === t.id).sort((a, b) => a.seat - b.seat);
        const inCount = occ.filter(g => g.checkedIn).length;
        return (
          <div key={t.id} style={S.gridCard}>
            <div style={S.gridCardHead}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {t.shape === "round" ? <Circle size={16} /> : t.shape === "rectangle" ? <RectangleHorizontal size={16} /> : <Square size={16} />}
                <b>{t.name}</b>
              </div>
              <span style={S.gridBadge}>{inCount}/{occ.length} in</span>
            </div>
            <div style={S.seatList}>
              {Array.from({ length: t.seats }).map((_, i) => {
                const g = occ.find(x => x.seat === i);
                return (
                  <div key={i} style={{ ...S.seatRow, borderColor: g ? (g.checkedIn ? "var(--ok)" : "var(--accent)") : "var(--line)" }}>
                    <span style={S.seatNum}>{i + 1}</span>
                    <span style={{ flex: 1 }}>{g ? g.name : <i style={S.muted}>empty</i>}</span>
                    {g && (g.checkedIn ? <Check size={15} color="var(--ok)" /> : <Circle size={9} color="var(--accent)" />)}
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
//  Guest Manager (manual + Excel/CSV import)
// ============================================================
function GuestManager({ guests, tables, addGuest, updateGuest, removeGuest, assignSeat, notify }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const fileRef = useRef(null);

  const importFile = async (file) => {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    let n = 0;
    for (const r of rows) {
      const nm = r.Name || r.name || r.NAME || Object.values(r)[0];
      const em = r.Email || r.email || r.EMAIL || "";
      if (nm) { await addGuest({ name: String(nm).trim(), email: String(em).trim() }); n++; }
    }
    notify(`Imported ${n} guests`);
  };

  return (
    <div style={{ padding: 24, height: "100%", overflowY: "auto" }}>
      <div style={S.addBar}>
        <input placeholder="Guest name" value={name} onChange={e => setName(e.target.value)} style={S.field} />
        <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} style={S.field} />
        <button style={S.primaryBtn} onClick={async () => { if (!name.trim()) return; await addGuest({ name: name.trim(), email: email.trim() }); setName(""); setEmail(""); }}>
          <Plus size={16} /> Add
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => e.target.files[0] && importFile(e.target.files[0])} />
        <button style={S.ghostBtn} onClick={() => fileRef.current.click()}><Upload size={16} /> Import Excel/CSV</button>
      </div>
      <div style={S.importHint}>Excel/CSV needs columns <b>Name</b> and <b>Email</b> (first column used if unnamed).</div>

      <table style={S.table}>
        <thead><tr><th style={S.th}>Name</th><th style={S.th}>Email</th><th style={S.th}>Table</th><th style={S.th}>Seat</th><th style={S.th}>Status</th><th style={S.th}></th></tr></thead>
        <tbody>
          {guests.map(g => {
            const t = tables.find(x => x.id === g.tableId);
            return (
              <tr key={g.id} style={S.tr}>
                <td style={S.td}>{g.name}</td>
                <td style={{ ...S.td, ...S.muted }}>{g.email || "—"}</td>
                <td style={S.td}>
                  <select value={g.tableId || ""} onChange={async e => {
                    const tid = e.target.value || null;
                    if (!tid) { await assignSeat(g.id, null, null); return; }
                    const occupied = guests.filter(x => x.tableId === tid).map(x => x.seat);
                    const tt = tables.find(x => x.id === tid);
                    let seat = 0; while (occupied.includes(seat) && seat < tt.seats) seat++;
                    await assignSeat(g.id, tid, seat);
                  }} style={S.select}>
                    <option value="">— none —</option>
                    {tables.map(tt => <option key={tt.id} value={tt.id}>{tt.name}</option>)}
                  </select>
                </td>
                <td style={S.td}>{t ? g.seat + 1 : "—"}</td>
                <td style={S.td}>
                  {g.checkedIn
                    ? <span style={S.tagOk}><Check size={12} /> In</span>
                    : <button style={S.tagBtn} onClick={() => updateGuest(g.id, { checkedIn: true })}>Mark in</button>}
                </td>
                <td style={S.td}><button onClick={() => removeGuest(g.id)} style={S.iconBtn}><Trash2 size={15} /></button></td>
              </tr>
            );
          })}
          {guests.length === 0 && <tr><td colSpan={6} style={{ ...S.td, ...S.muted, textAlign: "center", padding: 40 }}>No guests yet — add or import.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
//  QR Center — generate, download, email, PDF sheet
// ============================================================
function QrCenter({ guests, tables, notify }) {
  // payload encoded in QR = the guest token (what the scanner reads)
  const [previews, setPreviews] = useState({});
  useEffect(() => {
    const m = {};
    guests.forEach(g => { m[g.id] = qrDataUrl(g.token, 4, 2); });
    setPreviews(m);
  }, [guests]);

  const tableName = (id) => tables.find(t => t.id === id)?.name || "Unassigned";

  const downloadOne = (g) => {
    const a = document.createElement("a");
    a.href = qrDataUrl(g.token, 10, 4);
    a.download = `qr-${g.name.replace(/\s+/g, "_")}.png`;
    a.click();
  };

  const emailOne = (g) => {
    const t = tables.find(x => x.id === g.tableId);
    const body = `Hi ${g.name},\n\nYou're confirmed for the event.\n${t ? `Your seat: ${t.name}, Seat ${g.seat + 1}\n` : ""}\nPlease present your QR code at check-in. Your code ID: ${g.token}\n\nSee you there!`;
    window.location.href = `mailto:${encodeURIComponent(g.email || "")}?subject=${encodeURIComponent("Your Event Check-In QR Code")}&body=${encodeURIComponent(body)}`;
  };

  const buildPdf = async () => {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pw = doc.internal.pageSize.getWidth();
    const cols = 3, size = 130, gap = 24;
    const startX = (pw - (cols * size + (cols - 1) * gap)) / 2;
    let x = startX, y = 60, col = 0;
    doc.setFontSize(18); doc.text("Guest Check-In QR Codes", pw / 2, 36, { align: "center" });
    for (const g of guests) {
      doc.addImage(qrDataUrl(g.token, 8, 2), "PNG", x, y, size, size);
      doc.setFontSize(10);
      doc.text(g.name, x + size / 2, y + size + 14, { align: "center" });
      doc.setFontSize(8); doc.setTextColor(120);
      doc.text(tableName(g.tableId) + (g.tableId != null && g.seat != null ? ` · Seat ${g.seat + 1}` : ""), x + size / 2, y + size + 28, { align: "center" });
      doc.setTextColor(0);
      col++; x += size + gap;
      if (col === cols) { col = 0; x = startX; y += size + 50; }
      if (y > 700) { doc.addPage(); y = 60; x = startX; col = 0; }
    }
    doc.save("qr-codes.pdf");
    notify("PDF generated");
  };

  return (
    <div style={{ padding: 24, height: "100%", overflowY: "auto" }}>
      <div style={S.qrHeader}>
        <div>
          <h2 style={{ margin: 0 }}>QR Codes</h2>
          <div style={S.muted}>Each guest's code encodes a unique token scanned at check-in.</div>
        </div>
        <button style={S.primaryBtn} onClick={buildPdf}><Download size={16} /> PDF sheet (all)</button>
      </div>
      <div style={S.qrGrid}>
        {guests.map(g => (
          <div key={g.id} style={S.qrCard}>
            <img src={previews[g.id]} alt="" style={S.qrImg} />
            <div style={S.qrName}>{g.name}</div>
            <div style={S.muted}>{tableName(g.tableId)}{g.tableId != null && g.seat != null ? ` · S${g.seat + 1}` : ""}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button style={S.miniBtn} onClick={() => downloadOne(g)}><Download size={13} /> PNG</button>
              <button style={S.miniBtn} onClick={() => emailOne(g)}><Mail size={13} /> Email</button>
            </div>
          </div>
        ))}
        {guests.length === 0 && <div style={S.empty}>Add guests to generate codes</div>}
      </div>
    </div>
  );
}

// ============================================================
//  Scanner — iPad camera QR check-in
// ============================================================
function Scanner({ checkInByToken, guests }) {
  const videoRef = useRef(null);
  const [active, setActive] = useState(false);
  const [last, setLast] = useState(null);
  const [manual, setManual] = useState("");
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const detRef = useRef(null);
  const cooldown = useRef(0);

  const stop = useCallback(() => {
    setActive(false);
    cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setActive(true);
      // Prefer native BarcodeDetector (Safari 17+ / iPadOS), else fall back to jsQR
      if ("BarcodeDetector" in window) {
        detRef.current = new window.BarcodeDetector({ formats: ["qr_code"] });
        loopNative();
      } else {
        const jsQR = (await import("jsqr")).default;
        loopJsqr(jsQR);
      }
    } catch (e) { alert("Camera error: " + e.message); }
  };

  const handle = async (token) => {
    const now = Date.now();
    if (now - cooldown.current < 1500) return;
    cooldown.current = now;
    const g = await checkInByToken(token.trim());
    if (g) setLast({ name: g.name, t: now });
  };

  const loopNative = async () => {
    if (!videoRef.current) return;
    try {
      const codes = await detRef.current.detect(videoRef.current);
      if (codes[0]) handle(codes[0].rawValue);
    } catch {}
    rafRef.current = requestAnimationFrame(loopNative);
  };
  const loopJsqr = (jsQR) => {
    const v = videoRef.current; if (!v) return;
    const c = document.createElement("canvas");
    const tick = () => {
      if (v.readyState === v.HAVE_ENOUGH_DATA) {
        c.width = v.videoWidth; c.height = v.videoHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const code = jsQR(img.data, img.width, img.height);
        if (code) handle(code.data);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  useEffect(() => () => stop(), [stop]);

  return (
    <div style={S.scanWrap}>
      <div style={S.scanStage}>
        <video ref={videoRef} style={{ ...S.video, display: active ? "block" : "none" }} playsInline muted />
        {active && <div style={S.scanFrame} />}
        {!active && (
          <div style={S.scanIdle}>
            <Camera size={48} color="var(--accent)" />
            <p>Point the iPad camera at a guest's QR code</p>
            <button style={S.primaryBtn} onClick={start}><Camera size={16} /> Start camera</button>
          </div>
        )}
        {active && <button style={S.stopBtn} onClick={stop}>Stop</button>}
      </div>
      {last && <div style={S.scanResult}><Check size={20} /> {last.name} checked in</div>}
      <div style={S.manualBox}>
        <input placeholder="Or type/paste a code token…" value={manual} onChange={e => setManual(e.target.value)} style={S.field} />
        <button style={S.ghostBtn} onClick={() => { handle(manual); setManual(""); }}>Check in</button>
      </div>
    </div>
  );
}

// ============================================================
//  Settings — Supabase connection + schema
// ============================================================
function SettingsPanel({ sb, sbInfo, connect, disconnect, notify }) {
  const [url, setUrl] = useState(sbInfo.url);
  const [key, setKey] = useState(sbInfo.key);
  const schema = `-- Run in Supabase SQL editor
create table tables (
  id text primary key, name text, shape text,
  seats int, x float, y float, created_at timestamptz default now());
create table guests (
  id text primary key, name text, email text,
  table_id text, seat int, checked_in bool default false,
  token text, created_at timestamptz default now());
alter table tables enable row level security;
alter table guests enable row level security;
create policy "all" on tables for all using (true) with check (true);
create policy "all" on guests for all using (true) with check (true);`;
  return (
    <div style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h2>Cloud Sync (Supabase)</h2>
      <p style={S.muted}>Paste your project URL and anon public key to sync across devices. Your connection is remembered on this device, so you only enter it once here.</p>
      {sb && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderRadius: 12, background: "var(--surface)", border: "1px solid var(--ok)", marginTop: 8 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ok)", fontWeight: 600 }}>
            <Cloud size={16} /> Connected & saved on this device
          </span>
          <button style={{ ...S.ghostBtn, borderColor: "#3a2326", color: "#ff9a9a" }} onClick={disconnect}>Disconnect</button>
        </div>
      )}
      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <label style={S.lbl}>Project URL
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" style={S.field} />
        </label>
        <label style={S.lbl}>Anon public key
          <input value={key} onChange={e => setKey(e.target.value)} placeholder="eyJ..." style={S.field} />
        </label>
        <button style={S.primaryBtn} onClick={() => connect(url.trim(), key.trim())}>
          <Cloud size={16} /> {sb ? "Reconnect" : "Connect"}
        </button>
      </div>
      <h3 style={{ marginTop: 28 }}>1. Create the tables first</h3>
      <pre style={S.code}>{schema}</pre>
      <p style={S.muted}>The open RLS policy is fine for a single trusted event device. For public deployment, tighten policies or add auth.</p>
    </div>
  );
}

// ============================================================
//  Styles
// ============================================================
const CSSVARS = `
:root{
  --bg:#0d0f12; --surface:#161a1f; --surface2:#1d232b; --line:#2c343d;
  --text:#e8edf2; --dim:#8b97a5; --muted:#5d6873;
  --accent:#d4af6a; --accent2:#e9c889; --ok:#5ec98a;
}
*{box-sizing:border-box}
body{margin:0}
input,select,button{font-family:inherit}
input:focus,select:focus{outline:1px solid var(--accent)}
::placeholder{color:var(--muted)}
button{transition:.15s}
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Outfit:wght@300;400;500;600&display=swap');
`;
const FONT = "'Outfit',system-ui,sans-serif";
const DISPLAY = "'Fraunces',Georgia,serif";

const S = {
  root: { height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)", fontFamily: FONT, fontSize: 14 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", borderBottom: "1px solid var(--line)", background: "var(--surface)", gap: 12, flexWrap: "wrap" },
  logo: { fontFamily: DISPLAY, fontSize: 22, fontWeight: 600, letterSpacing: 1, color: "var(--accent)" },
  statline: { display: "flex", gap: 8, fontSize: 12, color: "var(--dim)" },
  nav: { display: "flex", gap: 4, background: "var(--bg)", padding: 4, borderRadius: 12, border: "1px solid var(--line)" },
  navBtn: { display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", border: "none", borderRadius: 9, background: "transparent", color: "var(--dim)", cursor: "pointer", fontWeight: 500 },
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

  modalWrap: { position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 },
  modal: { width: 420, maxWidth: "90vw", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,.5)" },
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
  select: { padding: "6px 9px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface2)", color: "var(--text)" },
  tagOk: { display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ok)", fontWeight: 600, fontSize: 13 },
  tagBtn: { padding: "5px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface2)", color: "var(--dim)", cursor: "pointer", fontSize: 12 },

  qrHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 },
  qrGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(170px,1fr))", gap: 16 },
  qrCard: { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, padding: 14, textAlign: "center" },
  qrImg: { width: "100%", borderRadius: 10, background: "#fff", padding: 8 },
  qrName: { fontWeight: 600, marginTop: 8 },
  miniBtn: { flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "7px 0", borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface2)", color: "var(--text)", cursor: "pointer", fontSize: 12 },

  scanWrap: { padding: 24, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 18, overflowY: "auto" },
  scanStage: { position: "relative", width: "min(560px,90vw)", aspectRatio: "1", background: "#000", borderRadius: 20, overflow: "hidden", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center" },
  video: { width: "100%", height: "100%", objectFit: "cover" },
  scanFrame: { position: "absolute", inset: "18%", border: "3px solid var(--accent)", borderRadius: 18, boxShadow: "0 0 0 9999px rgba(0,0,0,.35)" },
  scanIdle: { textAlign: "center", color: "var(--dim)", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: 24 },
  stopBtn: { position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", padding: "9px 22px", borderRadius: 20, border: "none", background: "rgba(0,0,0,.6)", color: "#fff", cursor: "pointer", backdropFilter: "blur(8px)" },
  scanResult: { display: "flex", alignItems: "center", gap: 8, padding: "12px 22px", borderRadius: 14, background: "var(--ok)", color: "#0a0a0a", fontWeight: 600, fontSize: 16 },
  manualBox: { display: "flex", gap: 10, width: "min(560px,90vw)" },

  lbl: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--dim)" },
  code: { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, padding: 16, fontSize: 12, color: "var(--accent2)", overflowX: "auto", lineHeight: 1.6 },

  muted: { color: "var(--muted)", fontSize: 12 },
  toast: { position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--surface2)", border: "1px solid var(--accent)", color: "var(--accent2)", padding: "12px 22px", borderRadius: 30, boxShadow: "0 12px 40px rgba(0,0,0,.5)", zIndex: 100, fontWeight: 500 },
};
