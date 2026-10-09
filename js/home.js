/**
 * home.js : Page d'accueil : état des services locaux (serveur des pages, moteur Cours, Ollama).
 */
import { initShell, ENGINE } from './shell.js';
import { hydrateIcons } from './icons.js';

const $ = (s) => document.querySelector(s);

async function json(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function status() {
  const info = await json('api/info');
  if (info?.dataDir) $('#dataDir').textContent = info.dataDir;
  for (const id of ['#stDetect', '#stSleep']) {
    const el = $(id);
    el.classList.toggle('ok', !!info);
    el.textContent = info ? 'Sauvegarde sur le Bureau active' : 'Sauvegarde Bureau inactive (serveur local arrêté)';
  }
  const sys = await json(`${ENGINE}/api/system`);
  const st = $('#stCours');
  if (sys) {
    const hw = sys.hardware;
    $('#engineInfo').textContent = `En ligne : ${hw.gpu || 'CPU'}${hw.gpu ? ` (${hw.vram_gb} Go)` : ''}, ${hw.ram_gb} Go de RAM ; LLM ${sys.llm.running ? (sys.llm.quality_ready ? sys.llm.quality : sys.llm.models[0] || '-') : 'arrêté'}.`;
    st.className = 'app-status ok';
    st.textContent = sys.runner?.current ? 'Analyse en cours' : 'Moteur prêt';
    if (location.port !== '8091') $('#openCours').href = `${ENGINE}/cours.html`;
  } else {
    $('#engineInfo').textContent = 'Arrêté : il démarre automatiquement à l’ouverture de Cours.';
    st.className = 'app-status off';
    st.textContent = 'Moteur arrêté';
  }
}

hydrateIcons();
initShell();
status();
