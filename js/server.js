/**
 * server.js : Connexion (optionnelle) au logiciel serveur.
 *
 * Totalement indépendant de l'audio : la visualisation fonctionne sans serveur.
 *
 * Sources disponibles (paramètre "serverSource") :
 *   simulated  valeurs simulées (par défaut)
 *   websocket  flux JSON poussé par le serveur        ex. ws://localhost:8765
 *   http       API locale interrogée périodiquement   ex. http://localhost:8080/api/status
 *   json       fichier JSON écrit par le serveur      ex. ./server-status.json
 *   off        aucune connexion
 *
 * Format attendu (tous les champs sont optionnels, voir server-status.example.json) :
 * {
 *   "name": "Survie", "status": "online",            // online | offline | starting | stopping
 *   "players": { "online": 12, "max": 50, "list": ["Steve", "Alex"] },
 *   "tps": 20.0, "mspt": 18.4,
 *   "cpu": 32,                                          // %
 *   "ram": { "used": 4.2, "max": 8 },                   // Go
 *   "uptime": 3600, "version": "1.0.0", "motd": "..."
 * }
 *
 * Pour ajouter un protocole : créer une classe avec start(emit) / stop()
 * et l'enregistrer dans PROVIDERS.
 */
import { Emitter, clamp } from './utils.js';

/** Normalise un objet JSON quelconque vers le format interne. */
export function normalizeStatus(raw = {}) {
  const num = (v, d = null) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const players = raw.players ?? {};
  const ram = raw.ram ?? raw.memory ?? {};
  return {
    name: String(raw.name ?? raw.server ?? 'Serveur'),
    status: String(raw.status ?? (raw.online === false ? 'offline' : 'online')).toLowerCase(),
    players: {
      online: num(players.online ?? raw.playersOnline ?? raw.online_players, 0),
      max: num(players.max ?? raw.maxPlayers ?? raw.max_players, 0),
      list: Array.isArray(players.list) ? players.list.map(String) : [],
    },
    tps: num(raw.tps),
    mspt: num(raw.mspt),
    cpu: num(raw.cpu),
    ram: { used: num(typeof ram === 'object' ? ram.used : ram), max: num(typeof ram === 'object' ? ram.max : null) },
    uptime: num(raw.uptime),
    version: raw.version ? String(raw.version) : '',
    motd: raw.motd ? String(raw.motd) : '',
    receivedAt: Date.now(),
  };
}

/* ------------------------------- Fournisseurs ------------------------------ */

class SimulatedProvider {
  start(emit) {
    const names = ['nova', 'kai', 'lumen', 'echo', 'atlas', 'iris', 'orion', 'vega', 'milo', 'sora', 'juno', 'pixel'];
    const s = { players: 12, tps: 20, cpu: 32, ram: 4.2, uptime: 3 * 3600 + 17 * 60 };
    const tick = () => {
      s.players = clamp(Math.round(s.players + (Math.random() - 0.5) * 2.2), 3, 50);
      s.tps = clamp(19.95 - Math.random() ** 3 * 2.5, 15, 20);
      s.cpu = clamp(s.cpu + (Math.random() - 0.5) * 8, 12, 88);
      s.ram = clamp(s.ram + (Math.random() - 0.48) * 0.12, 3.1, 7.4);
      s.uptime += 2;
      emit(normalizeStatus({
        name: 'Serveur local', status: 'online', version: 'v1.0 (simulation)',
        motd: 'Simulation : connectez votre serveur dans Paramètres',
        players: { online: s.players, max: 50, list: names.slice(0, Math.min(names.length, s.players)) },
        tps: s.tps, mspt: (50 / 20) * (40 - s.tps) * 0.9, cpu: s.cpu, ram: { used: s.ram, max: 8 }, uptime: s.uptime,
      }));
    };
    tick();
    this.timer = setInterval(tick, 2000);
    return { connection: 'connected' };
  }
  stop() { clearInterval(this.timer); }
}

class WebSocketProvider {
  constructor(url) { this.url = url; }
  start(emit, status) {
    let retry = 1000;
    const open = () => {
      status('connecting');
      try { this.ws = new WebSocket(this.url); } catch (err) { status('error', err.message); return; }
      this.ws.onopen = () => { retry = 1000; status('connected'); };
      this.ws.onmessage = (ev) => {
        try { emit(normalizeStatus(JSON.parse(ev.data))); } catch { /* message non JSON ignoré */ }
      };
      this.ws.onclose = () => {
        if (this.stopped) return;
        status('error', `Connexion perdue, nouvel essai dans ${Math.round(retry / 1000)} s`);
        this.timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 15000);
      };
    };
    open();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.ws?.close(); }
}

class PollProvider {
  constructor(url, interval) { this.url = url; this.interval = Math.max(250, interval); }
  start(emit, status) {
    status('connecting');
    const poll = async () => {
      try {
        const res = await fetch(this.url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        emit(normalizeStatus(await res.json()));
        status('connected');
      } catch (err) {
        status('error', err.message || 'Requête impossible');
      }
      if (!this.stopped) this.timer = setTimeout(poll, this.interval);
    };
    poll();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}

const PROVIDERS = {
  simulated: () => new SimulatedProvider(),
  websocket: (s) => new WebSocketProvider(s.get('serverUrl')),
  http: (s) => new PollProvider(s.get('serverUrl'), s.get('serverInterval')),
  json: (s) => new PollProvider(s.get('serverUrl'), s.get('serverInterval')),
};

/* -------------------------------- Connecteur -------------------------------- */

export class ServerConnector extends Emitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.provider = null;
    this.data = null;
    this.connection = 'disconnected'; // connected | connecting | disconnected | error
    this.message = '';
    this.history = { players: [], tps: [], cpu: [], ram: [] }; // pour les mini-graphiques
  }

  get source() { return this.settings.get('serverSource'); }

  connect() {
    this.disconnect();
    const make = PROVIDERS[this.source];
    if (!make) { this._status('disconnected'); return; }
    this.provider = make(this.settings);
    const res = this.provider.start((d) => this._data(d), (c, msg) => this._status(c, msg));
    if (res?.connection) this._status(res.connection);
  }

  disconnect() {
    this.provider?.stop();
    this.provider = null;
    this._status('disconnected');
  }

  _status(connection, message = '') {
    this.connection = connection;
    this.message = message;
    this.emit('status', { connection, message, source: this.source });
  }

  _data(d) {
    this.data = d;
    const push = (k, v) => { if (v == null) return; const a = this.history[k]; a.push(v); if (a.length > 60) a.shift(); };
    push('players', d.players.online);
    push('tps', d.tps);
    push('cpu', d.cpu);
    push('ram', d.ram.used);
    this.emit('data', d);
  }
}
