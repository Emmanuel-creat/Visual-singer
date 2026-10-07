# Visual Singer

Une interface web locale qui analyse le microphone en temps réel et transforme le son en une visualisation 3D interactive : fréquences, intensité, temps, pics, traînées et couleurs personnalisables.

Le son devient un **terrain 3D** :

| Axe | Signification |
|-----|---------------|
| **X** | Temps (chaque nouvelle tranche d'analyse fait avancer le terrain) |
| **Y** | Fréquence (échelle logarithmique, des graves aux aigus) |
| **Z** | Intensité (hauteur du relief) |

L'interface adopte un style néomorphique sombre. Elle inclut aussi un panneau de supervision serveur (statut, joueurs, TPS, CPU, RAM) : il est simulé par défaut et prêt à être relié au vrai logiciel serveur.

## Lancement

Les navigateurs bloquent le microphone pour les pages ouvertes en `file://`. Il faut donc servir le dossier en local :

```bash
python -m http.server 8080
```

puis ouvrir **http://localhost:8080**.

Raccourcis : double-clic sur `start.bat` (Windows) ou `./start.sh` (macOS / Linux).

Rien à installer et aucun service cloud : Three.js est embarqué dans `vendor/`. Il faut un navigateur récent compatible WebGL2 (Chrome, Edge ou Firefox).

## Utilisation

1. Cliquer sur **🎙 CONNECT MICROPHONE** et autoriser l'accès. Pour tester sans micro, choisir **Lancer le signal de démonstration**.
2. Le terrain se construit en temps réel. Graves, médiums et aigus ont chacun leur couleur, et les pics sont marqués par des faisceaux lumineux.
3. Utiliser **Pause / Play / Live** dans la barre du bas, ou cliquer-glisser dans la **timeline** pour revenir en arrière. La 3D montre alors l'état à l'instant choisi.
4. **COLORS** : presets et couleurs personnalisées, sauvegardées dans le navigateur.
5. **SETTINGS** : FFT, zones de fréquences, qualité graphique, traînées, seuil des pics, durée de l'historique, serveur.

### Raccourcis clavier

| Touche | Action |
|--------|--------|
| `Espace` | Lecture / pause |
| `L` | Retour au direct |
| `←` / `→` | Reculer / avancer d'1 s (`Maj` : 5 s) |
| `J` / `K` | Retour arrière / avance rapide (plusieurs appuis pour accélérer) |
| `[` / `]` | Vitesse de lecture |
| `1` `2` `3` `4` / `R` | Caméra TOP · FRONT · SIDE · 3D / reset |
| `A` | Rotation automatique |
| `T` | Mode de traînée suivant |
| `H` · `B` · `C` · `S` | HUD · panneau latéral · couleurs · paramètres |
| `F` | Plein écran |

Caméra : glisser pour tourner, clic droit (ou `Maj` + glisser) pour déplacer, molette pour zoomer.
Timeline : molette pour le zoom temporel, `Maj` + molette pour défiler, double-clic pour revenir au direct.

## Fonctionnalités

- **Analyse** (Web Audio API : `AudioContext`, `AnalyserNode`)
  - FFT de 1024 à 16384, lissage et plage en dB réglables
  - 128 bandes logarithmiques
  - fréquence dominante (interpolation parabolique) avec le nom de la note
  - RMS, crête, détection de saturation
- **Zones** : graves 20–250 Hz, médiums 250 Hz–4 kHz, aigus 4–20 kHz, toutes modifiables. La zone dominante est mise en évidence dans la 3D, dans le HUD et dans le panneau.
- **Historique** : 30 s, 1 min, 5 min ou 10 min.
  - Seules les données d'analyse sont conservées : timestamp, bandes, bass, mid, treble, intensity, peak, dominantFrequency.
  - Elles sont stockées dans des buffers circulaires typés : environ 2,7 Mo pour 10 min.
- **Lecture** : direct, pause, lecture avant ou arrière (de −4× à 4×), sauts de ±1 s / 5 s, scrubber. La timeline et la fenêtre 3D (5 à 60 s) ont chacune leur zoom temporel.
- **Traînées** : 5 modes (aucune, faible, moyenne, forte, persistante) et une longueur réglable. Elles portent sur :
  - la ligne de la fréquence dominante
  - le maintien des crêtes
  - la persistance des marqueurs de pics
  - l'estompage de l'historique
- **Pics** : seuil réglable. Chaque pic produit :
  - une pulsation du terrain
  - un faisceau lumineux
  - une étiquette (dB · fréquence · horodatage)
  - un marqueur dans la timeline
  - une entrée cliquable dans la liste des pics
- **Qualité** : LOW, MEDIUM, HIGH ou ULTRA. Ce réglage agit sur la résolution du maillage, le filaire et la densité de pixels. La géométrie est allouée une seule fois, sans nouvel objet Three.js à chaque image.
- **Responsive** : 1080p, 1440p et 4K grâce à des tailles en `rem` adaptatives. Sur petit écran, le panneau latéral se replie pour laisser la place à la 3D.

## Architecture

```text
index.html              structure de l'interface
css/style.css           thème néomorphique (variables CSS pilotées par theme.js)
js/app.js               point d'entrée + boucle requestAnimationFrame
js/audio.js             capture micro, analyse FFT, détection de pics, synthé de démo
js/history.js           stockage circulaire de l'historique d'analyse
js/transport.js         état de lecture (live / pause / lecture, vitesse, curseur)
js/visualizer.js        moteur 3D Three.js (terrain, grille, traînées, pics, curseur)
js/orbit.js             caméra orbitale amortie + vues prédéfinies
js/timeline.js          timeline / scrubber (Canvas 2D)
js/controls.js          interface : panneaux, paramètres, couleurs, raccourcis
js/theme.js             couleurs, presets, thèmes sauvegardés (localStorage)
js/server.js            connexion serveur (simulation, WebSocket, HTTP, fichier JSON)
js/settings.js          paramètres centralisés et persistés
js/utils.js             outils partagés
vendor/three.module.min.js   Three.js r169 (MIT)
```

L'audio ne dépend pas du serveur : la visualisation fonctionne même sans connexion. Pour le débogage, tous les modules sont accessibles dans la console via `window.visualSinger`.

## Connexion au logiciel serveur

Choisir la source dans **SETTINGS → SERVEUR** :

| Source | Adresse (exemple) | Fonctionnement |
|--------|-------------------|----------------|
| Simulation | — | valeurs factices (par défaut) |
| WebSocket | `ws://localhost:8765` | le serveur envoie un message JSON à chaque mise à jour (reconnexion automatique) |
| API locale (HTTP) | `http://localhost:8080/api/status` | requête GET à intervalle régulier |
| Fichier JSON | `./server-status.example.json` | fichier écrit par le serveur et relu à intervalle régulier |

Format attendu (tous les champs sont optionnels ; voir `server-status.example.json`) :

```json
{
  "name": "Serveur local",
  "status": "online",
  "players": { "online": 12, "max": 50, "list": ["nova", "kai"] },
  "tps": 19.8,
  "mspt": 21.5,
  "cpu": 32,
  "ram": { "used": 4.2, "max": 8 },
  "uptime": 11820,
  "version": "1.0.0"
}
```

Pour ajouter un protocole : écrire une classe avec `start(emit, status)` et `stop()` dans `js/server.js`, puis l'ajouter à `PROVIDERS`.

> Si l'API HTTP tourne sur un autre port que l'interface, elle doit autoriser le CORS (`Access-Control-Allow-Origin`).

## Confidentialité

Le son n'est jamais enregistré ni envoyé. Seules les mesures d'analyse restent en mémoire, et uniquement pendant la durée d'historique choisie. Les préférences (paramètres, thèmes) sont stockées dans le `localStorage` du navigateur.
