# Visual Singer

Une interface web locale qui analyse le microphone en temps réel, transforme le son en une visualisation 3D interactive et **identifie qui fait le bruit** : espèce d'oiseau, animal, humain (parole, chant, rire, toux…), musique ou environnement. Tout tourne sur l'ordinateur, sans connexion Internet.

Le son devient un **terrain 3D** :

| Axe | Signification |
|-----|---------------|
| **X** | Temps (chaque nouvelle tranche d'analyse fait avancer le terrain) |
| **Y** | Fréquence (échelle logarithmique, des graves aux aigus) |
| **Z** | Intensité (hauteur du relief) |

L'interface adopte un style néomorphique sombre. Elle inclut aussi un panneau de supervision serveur (statut, joueurs, TPS, CPU, RAM) : il est simulé par défaut et prêt à être relié au vrai logiciel serveur.

## Lancement

Double-clic sur **`start.bat`** (Windows), ou :

```bash
python server.py
```

Le navigateur s'ouvre sur **http://localhost:8080**. Il faut seulement Python 3, sans aucun paquet à installer. Les navigateurs bloquent le micro en `file://`, d'où ce petit serveur local.

`server.py` sert l'application et **enregistre les données sur le Bureau**, dans le dossier `Visual Singer` (le Bureau OneDrive est détecté automatiquement) :

```text
Bureau/Visual Singer/
  config.json                    réglages + thèmes
  detections/2026-10-07.csv      journal des sons identifiés (s'ouvre dans Excel)
  detections/2026-10-07.jsonl    même journal au format JSON
  extraits/2026-10-07/*.wav      extrait audio de 3 s de chaque détection
```

Options : `python server.py --port 9000 --data "D:/Mes enregistrements"`.
Avec un simple `python -m http.server 8080`, l'application fonctionne aussi, mais les réglages restent alors dans le navigateur, sans sauvegarde sur le Bureau.

Tout est embarqué (Three.js, TensorFlow.js, modèles) : aucun service cloud. Il faut un navigateur récent compatible WebGL2 (Chrome, Edge ou Firefox).

## Deux applications

| Page | Lanceur | Usage |
|------|---------|-------|
| `index.html` — **Détecteur** | `start.bat` | visualisation 3D temps réel, identification des oiseaux, animaux, humains |
| `sommeil.html` — **Sommeil** | `start-sommeil.bat` | surveillance acoustique de la nuit, statistiques, interprétations, historique |

Les deux partagent le moteur audio, les modèles et la sauvegarde sur le Bureau. Un lien dans la barre du haut permet de passer de l'une à l'autre.

## Application Sommeil

Lancer `start-sommeil.bat`, cliquer sur **Démarrer la nuit** et laisser l'onglet ouvert, ordinateur branché. L'écran reste allumé ; le **Mode nuit** affiche un écran noir avec une horloge discrète. Le matin, cliquer sur **Terminer la nuit**.

Chaque seconde, le son est classé par YAMNet. Le moteur reconstitue ensuite les épisodes, le niveau sonore et le rythme respiratoire :

| Détection | Comment |
|-----------|---------|
| Sommeil / éveil, endormissement, réveil | « actigraphie acoustique » : activité par minute (mouvements, paroles, toux…) lissée sur les minutes voisines ; le ronflement sans agitation compte comme sommeil |
| Ronflements | nombre, épisodes, % du temps de sommeil, intensité, répartition heure par heure |
| Respiration | rythme (respirations/min) et régularité, estimés par autocorrélation de l'enveloppe sonore quand la respiration est audible |
| Pauses respiratoires suspectes | silence respiratoire ≥ 10 s pendant un ronflement ou une respiration audible, puis reprise (ronflement, halètement, reniflement) |
| Toux, éternuements, paroles, gémissements | épisodes horodatés et nombre d'occurrences |
| Mâchoire / grincement | bruits de mastication ou de claquement assez audibles |
| Mouvements dans le lit | froissements, grincements, chocs sourds |
| Environnement | portes, circulation, voix, animaux, télévision… avec le niveau ambiant L90 / L50 / L10 |

Onglets :
- **Nuit en cours** : compteurs en direct, niveau sonore, derniers événements, chronologie qui se construit.
- **Résumé** : durée de sommeil, indicateurs, hypnogramme, heure par heure et **interprétation** rédigée, comparée aux autres nuits.
- **Chronologie** : carte de la nuit, une ligne par type d'événement. Molette pour zoomer, glisser pour se déplacer, clic pour écouter.
- **Ronflements & respiration** : graphiques et liste des pauses avec leurs extraits.
- **Événements** : tableau filtrable avec lecture des extraits.
- **Environnement** : niveaux, types de bruits, bruits les plus forts, bruits suivis d'un réveil.
- **Historique** : toutes les nuits, évolution d'un indicateur, comparaison de deux nuits.

**Couleurs du rapport** : chaque indicateur reçoit un score de qualité. Il s'affiche sur une échelle continue, du **vert** (favorable) à l'**orange** puis au **rouge** (défavorable). Les couleurs sont interpolées en OKLCH, et la palette a été vérifiée sur le fond sombre. Chaque couleur est toujours accompagnée d'une valeur ou d'un mot (« favorable », « intermédiaire », « défavorable ») pour rester lisible par les personnes daltoniennes. Les seuils sont dans `js/sleep/quality.js`.

Seuls de courts extraits WAV des événements sont gardés (25 par type par défaut, réglable), jamais la nuit entière. Pour découvrir l'interface sans attendre une nuit : **Historique → Charger 7 nuits de démonstration** (données fictives, jamais sauvegardées).

```text
Bureau/Visual Singer/sommeil/
  2026-10-07_23h12/night.json        données complètes de la nuit
  2026-10-07_23h12/summary.json      résumé
  2026-10-07_23h12/extraits/*.wav    extraits des événements
  historique.csv                     une ligne par nuit (Excel)
  _corbeille/                        nuits supprimées depuis l'Historique
```

> Les mesures sont acoustiques et estimées : ce n'est pas une polysomnographie.

## Identification des sons

Toutes les 1,5 s, les 3 dernières secondes de son sont analysées par deux réseaux de neurones exécutés dans le navigateur :

| Modèle | Reconnaît | Détail |
|--------|-----------|--------|
| **YAMNet** (Google) | 521 types de sons | humains (parole d'homme, de femme ou d'enfant, chant, rire, pleurs, toux, ronflement, sifflement, pas…), animaux (chien, chat, cheval, vache, cochon, mouton, poule, canard, grenouille, grillon, abeille, chouette…), musique, nature (pluie, vent, orage), véhicules, objets |
| **BirdNET v2.4** (Cornell Lab / TU Chemnitz) | plus de 6 000 espèces d'oiseaux | noms français et scientifiques ; lancé dès que YAMNet entend un oiseau |

- Le panneau **IDENTIFICATION** affiche la source en cours (icône, nom, nom scientifique, confiance), les scores par catégorie (Oiseau, Animal, Humain, Musique, Nature, Environnement) et les autres candidats.
- Chaque détection apparaît aussi :
  - dans le journal **DÉTECTIONS** (cliquable pour revoir l'instant) ;
  - sur la **timeline** (bande colorée) ;
  - dans la **3D** (étiquette au-dessus du terrain) ;
  - dans le HUD (ligne SOURCE).
- **📂 Analyser un fichier audio** (ou glisser-déposer sur la vue 3D) : analyse un enregistrement existant (WAV, MP3, OGG, FLAC…).
- Réglages (SETTINGS → IDENTIFICATION DES SONS) :
  - confiance minimale ;
  - fréquence d'analyse ;
  - « toujours chercher l'espèce d'oiseau » ;
  - **filtre géographique** : avec ta position (bouton 📍) et la date, BirdNET écarte les espèces improbables dans ta région à cette saison, ce qui réduit fortement les erreurs.
- Les modèles (~95 Mo) se chargent au premier lancement de l'analyse, en environ 10 s.

> Limites : la reconnaissance est probabiliste. Vérifie les identifications importantes en réécoutant les extraits WAV. YAMNet dit *ce que* fait le bruit (une voix, un chien), mais ne reconnaît pas *quelle* personne parle.

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
js/recognizer.js        identification des sons (YAMNet + BirdNET, TensorFlow.js)
js/sound-labels.js      catégories et noms français des sons
js/identify-panel.js    panneau d'identification + journal des détections
js/capture-worklet.js   AudioWorklet : signal brut pour la reconnaissance
js/persist.js           sauvegarde sur le Bureau (via server.py), encodage WAV
server.py               serveur local + API de sauvegarde (Python, bibliothèque standard)
models/yamnet/          YAMNet TFJS + liste des 521 classes
models/birdnet/         BirdNET v2.4 TFJS, libellés FR/EN, modèle géographique (mdata)
js/settings.js          paramètres centralisés et persistés
js/utils.js             outils partagés
js/icons.js             icônes SVG « verre sombre » (tuile, forme givrée, accent lumineux)
sommeil.html            application Sommeil
css/sommeil.css         styles de l'application Sommeil
js/sleep/monitor.js     surveillance de la nuit (classification, épisodes, pauses, respiration)
js/sleep/analysis.js    sommeil/éveil, statistiques, interprétations, comparaisons
js/sleep/charts.js      graphiques (courbes lissées, barres pilules, jauges, calendrier, chronologie zoomable)
js/sleep/quality.js     échelle de qualité vert → rouge et seuils de chaque indicateur
js/sleep/app.js         interface et onglets
js/sleep/categories.js  catégories nocturnes ↔ classes YAMNet
js/sleep/store.js       nuits sur le Bureau (via server.py)
js/sleep/demo.js        générateur de nuits de démonstration
vendor/three.module.min.js   Three.js r169 (MIT)
vendor/tf.min.js             TensorFlow.js 4.22 (Apache 2.0)
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

Rien n'est envoyé sur Internet : l'analyse et la reconnaissance tournent sur l'ordinateur. Le son en continu n'est pas enregistré. Seuls les extraits de 3 s des détections sont écrits dans `Bureau/Visual Singer/extraits`, et cette option se désactive dans les réglages.

## Licences

- Code de l'application : celle du dépôt.
- **BirdNET v2.4** (`models/birdnet/`) : © K. Lisa Yang Center for Conservation Bioacoustics, Cornell Lab of Ornithology & Chemnitz University of Technology, licence **CC BY-NC-SA 4.0**. Usage **non commercial** uniquement, voir `models/birdnet/LICENSE.txt`.
- **YAMNet** (`models/yamnet/`) : © Google, Apache 2.0.
- Three.js (MIT), TensorFlow.js (Apache 2.0).
