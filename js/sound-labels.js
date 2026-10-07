/**
 * sound-labels.js — Catégories et noms français des classes YAMNet (AudioSet, 521 classes).
 *
 * Les indices suivent models/yamnet/yamnet_class_map.csv.
 * Les classes sans traduction gardent leur nom anglais.
 */

export const CATEGORIES = {
  bird:   { label: 'Oiseau',        icon: 'bird', color: '#7ee08a' },
  animal: { label: 'Animal',        icon: 'animal', color: '#c79bf2' },
  human:  { label: 'Humain',        icon: 'human', color: '#f2b45a' },
  music:  { label: 'Musique',       icon: 'music', color: '#7cc4ff' },
  nature: { label: 'Nature',        icon: 'nature', color: '#5ad2c0' },
  other:  { label: 'Environnement', icon: 'other', color: '#a3a4aa' },
};

/** Catégorie d'une classe YAMNet d'après son indice. */
export function yamnetCategory(i) {
  if (i <= 66) return 'human';
  if (i >= 106 && i <= 116) return 'bird';
  if (i <= 131) return 'animal';
  if (i <= 276) return 'music';
  if (i <= 293) return 'nature';
  return 'other';
}

/**
 * Classes trop générales ou décrivant l'environnement d'écoute plutôt que la source :
 * elles ne sont jamais proposées comme « source identifiée ».
 */
export const YAMNET_IGNORED = new Set([494, 500, 501, 502, 503, 504, 505, 506, 507, 508, 509, 512, 513, 514, 515, 520]);

/** Classes génériques remplacées par une plus précise quand elle existe (Animal, Oiseau, Musique…). */
export const YAMNET_GENERIC = new Set([67, 68, 81, 103, 106, 132, 133]);

export const YAMNET_FR = {
  0: 'Parole', 1: "Parole d'enfant", 2: 'Conversation', 3: 'Narration, monologue', 4: 'Babillage',
  5: 'Voix de synthèse', 6: 'Cri', 7: 'Beuglement', 8: 'Cri de joie', 9: 'Hurlement',
  10: "Cris d'enfants", 11: 'Hurlement de peur', 12: 'Chuchotement', 13: 'Rire', 14: 'Rire de bébé',
  15: 'Gloussement', 16: 'Ricanement', 17: 'Fou rire', 18: 'Petit rire', 19: 'Pleurs, sanglots',
  20: 'Pleurs de bébé', 21: 'Gémissement', 22: 'Plainte', 23: 'Soupir', 24: 'Chant',
  25: 'Chorale', 26: 'Yodel', 27: 'Chant scandé', 28: 'Mantra', 29: "Chant d'enfant",
  30: 'Chant synthétique', 31: 'Rap', 32: 'Fredonnement', 33: 'Grognement (plainte)', 34: 'Grognement',
  35: 'Sifflement (humain)', 36: 'Respiration', 37: 'Respiration sifflante', 38: 'Ronflement', 39: 'Halètement brusque',
  40: 'Halètement', 41: 'Reniflement fort', 42: 'Toux', 43: 'Raclement de gorge', 44: 'Éternuement',
  45: 'Reniflement', 46: 'Course', 47: 'Pas traînants', 48: 'Pas, marche', 49: 'Mastication',
  50: 'Morsure', 51: 'Gargarisme', 52: 'Gargouillement d’estomac', 53: 'Rot', 54: 'Hoquet',
  55: 'Pet', 56: 'Mains', 57: 'Claquement de doigts', 58: 'Applaudissement (mains)', 59: 'Battements de cœur',
  60: 'Souffle cardiaque', 61: 'Acclamations', 62: 'Applaudissements', 63: 'Bavardage', 64: 'Foule',
  65: 'Brouhaha', 66: "Enfants qui jouent",
  67: 'Animal', 68: 'Animaux domestiques', 69: 'Chien', 70: 'Aboiement', 71: 'Jappement',
  72: 'Hurlement (chien)', 73: 'Ouaf-ouaf', 74: 'Grondement', 75: 'Gémissement (chien)', 76: 'Chat',
  77: 'Ronronnement', 78: 'Miaulement', 79: 'Feulement', 80: 'Miaulement de chat en chaleur', 81: "Animaux d'élevage",
  82: 'Cheval', 83: 'Bruit de sabots', 84: 'Hennissement', 85: 'Bovin', 86: 'Meuglement',
  87: 'Cloche de vache', 88: 'Cochon', 89: 'Grouinement', 90: 'Chèvre', 91: 'Bêlement',
  92: 'Mouton', 93: 'Volaille', 94: 'Poule, coq', 95: 'Gloussement de poule', 96: 'Chant du coq',
  97: 'Dinde', 98: 'Glouglou de dindon', 99: 'Canard', 100: 'Coin-coin', 101: 'Oie',
  102: "Cri d'oie", 103: 'Animaux sauvages', 104: 'Grands félins (lion, tigre)', 105: 'Rugissement', 106: 'Oiseau',
  107: "Chant / cri d'oiseau", 108: 'Gazouillis', 109: 'Cri rauque (oiseau)', 110: 'Pigeon, tourterelle', 111: 'Roucoulement',
  112: 'Corneille, corbeau', 113: 'Croassement', 114: 'Chouette, hibou', 115: 'Hululement', 116: "Battements d'ailes",
  117: 'Canidé (chien, loup)', 118: 'Rongeur (rat, souris)', 119: 'Souris', 120: 'Trottinement', 121: 'Insecte',
  122: 'Grillon', 123: 'Moustique', 124: 'Mouche', 125: 'Bourdonnement', 126: 'Abeille, guêpe',
  127: 'Grenouille', 128: 'Coassement', 129: 'Serpent', 130: 'Crécelle (serpent)', 131: 'Chant de baleine',
  132: 'Musique', 133: 'Instrument de musique', 135: 'Guitare', 136: 'Guitare électrique', 137: 'Basse',
  138: 'Guitare acoustique', 147: 'Clavier', 148: 'Piano', 150: 'Orgue', 153: 'Synthétiseur',
  156: 'Percussions', 157: 'Batterie', 158: 'Boîte à rythmes', 159: 'Tambour', 166: 'Cymbale',
  179: 'Orchestre', 180: 'Cuivres', 182: 'Trompette', 186: 'Violon', 188: 'Violoncelle',
  191: 'Flûte', 192: 'Saxophone', 193: 'Clarinette', 194: 'Harpe', 195: 'Cloche',
  196: "Cloche d'église", 201: 'Carillon à vent', 203: 'Harmonica', 204: 'Accordéon', 211: 'Musique pop',
  212: 'Hip-hop', 214: 'Rock', 230: 'Jazz', 232: 'Musique classique', 233: 'Opéra',
  234: 'Musique électronique', 249: 'Musique vocale', 250: 'A cappella', 261: 'Chanson', 262: 'Musique de fond',
  277: 'Vent', 278: 'Bruissement de feuilles', 279: 'Vent dans le micro', 280: 'Orage', 281: 'Tonnerre',
  282: 'Eau', 283: 'Pluie', 284: 'Goutte de pluie', 285: 'Pluie sur une surface', 286: 'Ruisseau',
  287: 'Cascade', 288: 'Océan', 289: 'Vagues', 290: 'Vapeur', 291: 'Gargouillis', 292: 'Feu', 293: 'Crépitement',
  294: 'Véhicule', 295: 'Bateau', 300: 'Véhicule routier', 301: 'Voiture', 302: 'Klaxon',
  304: 'Alarme de voiture', 308: 'Voiture qui passe', 310: 'Camion', 315: 'Bus', 316: "Véhicule d'urgence",
  317: 'Sirène de police', 318: "Sirène d'ambulance", 319: 'Sirène de pompiers', 320: 'Moto', 321: 'Bruit de circulation',
  323: 'Train', 329: 'Avion', 333: 'Hélicoptère', 335: 'Vélo', 337: 'Moteur',
  340: 'Tondeuse', 341: 'Tronçonneuse', 348: 'Porte', 349: 'Sonnette', 352: 'Claquement de porte',
  353: 'On frappe', 354: 'Tapotement', 355: 'Grincement', 358: 'Vaisselle', 363: 'Mixeur',
  364: 'Robinet', 367: 'Sèche-cheveux', 368: 'Chasse d’eau', 371: 'Aspirateur', 373: 'Trousseau de clés',
  378: 'Frappe au clavier', 380: "Clavier d'ordinateur", 382: 'Alarme', 383: 'Téléphone', 385: 'Sonnerie',
  389: 'Réveil', 390: 'Sirène', 393: 'Détecteur de fumée', 396: 'Sifflet', 400: 'Horloge',
  401: 'Tic', 402: 'Tic-tac', 406: 'Ventilateur', 407: 'Climatisation', 409: 'Imprimante',
  412: 'Outils', 413: 'Marteau', 418: 'Outil électrique', 419: 'Perceuse', 420: 'Explosion',
  421: 'Coup de feu', 426: "Feux d'artifice", 435: 'Verre', 437: 'Verre brisé', 439: 'Éclaboussure',
  442: 'Goutte', 453: 'Souffle (whoosh)', 454: 'Bruit sourd', 460: 'Détonation', 475: 'Bip',
  480: 'Craquement', 481: 'Froissement', 485: 'Cliquetis', 487: 'Grondement sourd', 490: 'Ronronnement électrique',
  494: 'Silence', 495: 'Onde sinusoïdale', 507: 'Bruit', 510: 'Ronflement secteur', 518: 'Télévision', 519: 'Radio',
};

/** Classes non-oiseaux de BirdNET → catégorie et nom français. */
export const BIRDNET_SPECIAL = {
  'Dog': { category: 'animal', fr: 'Chien' },
  'Engine': { category: 'other', fr: 'Moteur' },
  'Environmental': { category: 'nature', fr: 'Bruit environnemental' },
  'Fireworks': { category: 'other', fr: "Feux d'artifice" },
  'Gun': { category: 'other', fr: 'Coup de feu' },
  'Human non-vocal': { category: 'human', fr: 'Bruit humain (non vocal)' },
  'Human vocal': { category: 'human', fr: 'Voix humaine' },
  'Human whistle': { category: 'human', fr: 'Sifflement humain' },
  'Noise': { category: 'other', fr: 'Bruit' },
  'Power tools': { category: 'other', fr: 'Outils électriques' },
  'Siren': { category: 'other', fr: 'Sirène' },
};
