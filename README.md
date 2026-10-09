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

## Trois applications

| Page | Lanceur | Usage |
|------|---------|-------|
| `index.html` — **Accueil** | `start.bat` | présentation des trois outils, état des services locaux (sauvegarde Bureau, moteur Cours, GPU, LLM) |
| `detecteur.html` — **Détecteur** | depuis l'accueil | visualisation 3D temps réel, identification des oiseaux, animaux, humains |
| `sommeil.html` — **Sommeil** | `start-sommeil.bat` | surveillance acoustique de la nuit, statistiques, interprétations, historique |
| `cours.html` — **Cours** | `start-cours.bat` | transcription, résumés, notions et croisement d'un cours audio/vidéo avec son support |

Le détecteur et Sommeil partagent le moteur audio, les modèles et la sauvegarde sur le Bureau. `start-cours.bat` démarre aussi le serveur des pages (fenêtre réduite), pour que les trois applications soient accessibles en même temps.

### Navigation et ergonomie communes

- **Même en-tête partout** : logo → accueil, sélecteur Détecteur / Sommeil / Cours (page active indiquée), raccourcis clavier (touche `?`), bouton **Quitter**.
- **Quitter** ferme complètement le logiciel : arrêt du serveur des pages (8080) et du moteur Cours (8091), libération de la mémoire GPU, et en option arrêt d'Ollama. Une analyse de cours en cours reprend au prochain lancement.
- **Onglets dans l'adresse** (`#onglet=…`, `#cours=…`, `#nuit=…`) : le bouton Retour du navigateur revient à l'onglet ou au cours précédent, et une adresse peut être mise en favori. Fil d'Ariane sous l'en-tête.
- **Actions irréversibles confirmées**, suppression vers une corbeille avec **Annuler** (cours, nuits, thèmes) ; boutons désactivés pendant un traitement (pas de double envoi).
- **Accessibilité** : contrastes WCAG AA (texte ≥ 4,5:1, boutons d'accent en texte sombre), taille de base 15–18 px, focus visible, navigation au clavier (flèches dans les onglets), lien d'évitement, libellés de formulaires, régions annoncées aux lecteurs d'écran, sous-titres WebVTT générés pour les vidéos de cours, `prefers-reduced-motion` respecté, aucune information portée par la seule couleur (valeur chiffrée toujours affichée).
- **Méthode explicitée** : Sommeil détaille ses critères (actigraphie, pauses ≥ 10 s, autocorrélation respiratoire, L90/L50/L10, seuils de couleur) dans « Méthode et limites » ; tableaux exportables en CSV.

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

## Application Cours (analyse de cours audio/vidéo + support)

Troisième interface : `cours.html`. Un **moteur Python local** (`cours_engine/`) transcrit le cours, sépare les intervenants, lit le support (PDF, PowerPoint, Word), puis un LLM local produit les résumés, les notions, les questions de révision et le croisement entre l'oral et le support. Aucune donnée ne quitte l'ordinateur.

### Installation (une seule fois)

Double-clic sur **`install-cours.bat`**, ou bien :

```bash
cd cours_engine
uv venv --native-tls --python 3.12 .venv
uv pip install --native-tls -p .venv torch torchaudio --index-url https://download.pytorch.org/whl/cu128
uv pip install --native-tls -p .venv -r requirements.txt
.venv\Scripts\python prefetch.py
winget install --id Ollama.Ollama -e --source winget
ollama pull qwen3.5:35b-a3b
ollama pull qwen3.5:9b
```

Place nécessaire : ~11 Go (environnement + modèles audio/texte, dans `cours_engine/`, hors Git) + ~29 Go (modèles Ollama).
PyTorch **cu128** est indispensable pour les cartes RTX 50xx (Blackwell). LibreOffice (facultatif) sert aux miniatures des diapositives et à l'export PDF.

### Lancement

Double-clic sur **`start-cours.bat`** : il démarre Ollama et le moteur, puis ouvre **http://127.0.0.1:8091/cours.html**.
Le moteur sert aussi les deux autres applications sur ce port.

### Utilisation

1. **Nouveau cours**, puis glisser l'enregistrement (MP3, WAV, M4A, MP4, MKV…) et le support (PDF, PPTX, DOCX… plusieurs fichiers possibles).
2. Régler la langue, le nettoyage audio, le nombre d'intervenants et le profil du LLM, puis **Lancer l'analyse**. La progression s'affiche étape par étape, avec un journal.
3. Onglets :
   - **Lecture** : lecteur, transcription synchronisée (le mot prononcé est surligné, les mots incertains soulignés), intervenants renommables, sections. La diapositive affichée suit automatiquement la parole.
   - **Résumé** : résumé court, plan, résumé détaillé, synthèse finale audio + support, détail par section.
   - **Notions** : glossaire filtrable, formules, exemples, « à retenir ».
   - **Audio ↔ Support** : contradictions et différences, notions expliquées à l'oral mais absentes du support, couverture orale de chaque diapositive (vert = bien expliquée, rouge = pas abordée).
   - **Révision** : cartes questions/réponses avec suivi « je savais / à revoir ».
   - **Recherche** : recherche sémantique et par mots-clés. Chaque résultat mène au passage audio ou à la diapositive.
   - **Chat** : questions libres. La réponse s'affiche au fil de l'eau, avec des sources cliquables vers le moment de l'audio ou la diapositive.
   - **Export** : Markdown, Word ou PDF.

Tout horodatage affiché est cliquable et mène au passage correspondant.

### Pipeline et choix techniques

| Étape | Outil | Détail |
|-------|-------|--------|
| Extraction audio | FFmpeg (embarqué via imageio-ffmpeg) | mono 16 kHz. Nettoyage léger par défaut (passe-haut + normalisation) : un débruitage agressif peut dégrader la transcription |
| Support | PyMuPDF, python-pptx, python-docx, EasyOCR (GPU), LibreOffice | titres, puces, tableaux, notes de l'orateur ; OCR des pages qui ne sont qu'une image |
| Transcription | faster-whisper, **Whisper large-v3 affiné en français** (`bofenghuang/whisper-large-v3-french`) | float16 sur GPU, recherche en faisceau, VAD Silero, horodatage au mot, garde-fous anti-hallucination. Le vocabulaire du support guide l'orthographe des termes techniques |
| Intervenants | ECAPA-TDNN (SpeechBrain) + regroupement hiérarchique | nombre d'intervenants détecté automatiquement ou imposé |
| Index | **BGE-M3** + BM25 + **BGE-reranker-v2-m3** | recherche hybride multilingue avec réordonnancement |
| Rapprochement | programmation dynamique (Viterbi) | chaque paragraphe est rattaché à une diapositive ; la progression dans le support est favorisée |
| Analyse | **Ollama + qwen3.5:35b-a3b** (MoE, réparti entre VRAM et RAM) ; `qwen3.5:9b` en mode rapide | analyse section par section en JSON contraint, puis synthèse du cours entier |

Le profil est choisi automatiquement selon le matériel détecté (onglet système en haut à droite). Avec moins de mémoire, le modèle 9B est utilisé.

### Robustesse

- Les fichiers d'origine sont copiés dans `originals/` et ne sont jamais modifiés.
- Chaque étape a une clé de cache, calculée à partir de ses entrées et de ses paramètres. Si rien n'a changé, l'étape est sautée ; si un paramètre change, seules les étapes concernées sont recalculées.
- La transcription est enregistrée par tranches de ~10 min et l'analyse section par section. Après une coupure ou un redémarrage, le traitement reprend tout seul là où il s'était arrêté.
- Un seul traitement lourd à la fois. Les modèles sont déchargés du GPU entre deux étapes, ce qui permet de traiter des cours de plusieurs heures.

```text
Bureau/Visual Singer/cours/<cours>/
  project.json, state.json, job.log
  originals/   fichiers importés (intacts)
  work/        audio 16 kHz, version de lecture
  cache/       résultats de chaque étape (JSON)
  docs/        pages extraites + miniatures
  index/       vecteurs + passages
  exports/     rapports Markdown / Word / PDF
```

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
index.html              accueil (présentation, état des services)
detecteur.html          structure de l'interface du détecteur
404.html                page d'erreur (liens vers les applications)
css/ux.css              règles communes : espacements 8 px, boutons et états, focus, dialogues, notifications, responsive
js/shell.js             en-tête commun : dialogues, notifications avec Annuler, onglets accessibles + URL, raccourcis, Quitter
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
