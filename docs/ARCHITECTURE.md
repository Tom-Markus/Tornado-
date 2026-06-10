# Tornado Chaser — Architecture technique

Jeu de chasse à la tornade première personne, WebGL 2 / Three.js / TypeScript.
Quatre sous-systèmes découplés, chacun dans son module.

```
src/
├── physics/
│   ├── VortexField.ts        # Étape 1 — champ de force F(x,y,z), Rankine modifié
│   └── DestructionSystem.ts  # Étape 3 — rupture structurelle + débris poolés
├── rendering/
│   ├── tornadoShaders.ts     # Étape 2 — GLSL : cône turbulent + particules GPU
│   └── Tornado.ts            #            assemblage Three.js (mesh + points)
├── hud/
│   └── DopplerRadar.ts       # Étape 4 — réflectivité (hook echo) + SRV sur GPU
└── main.ts                   # scène, véhicule/tourelle, HUD, boucle de jeu
```

## 1. Champ de vent — vortex de Rankine modifié (`VortexField.ts`)

Décomposition cylindrique autour de l'axe vertical, `r` = distance horizontale
à l'axe, `y` = altitude :

**Rotation (Rankine)**

```
r <  R_core :  V_θ(r) = ω·r              (corps solide)
r >= R_core :  V_θ(r) = ω·R_core² / r    (vortex potentiel)
```

`V_max = ω·R_core` au rayon des vents maximaux. Preset EF4 : ω = 1.8 rad/s,
R_core = 45 m → V_max ≈ 81 m/s (292 km/h).

**Aspiration (inflow/outflow)**

```
|V_rad|(r)   = S · R_core² / max(r², R_core²)        (∝ 1/r², borné dans le cœur)
V_rad(r, y)  = |V_rad| · [0.6·smoothstep(0.7H, H, y) − e^(−y/H_in)]
```

Convergent vers l'axe dans la couche limite (e^(−y/H_in)), divergent au sommet
de la colonne — le circuit de masse est qualitativement fermé.

**Updraft**

```
V_up(r, y) = W · (y/H)^0.7 · e^(−r²/R_core²)
```

Maximal dans le cœur, croissant avec l'altitude (étirement vertical du
mésocyclone).

L'API est sans allocation (`out` vectors) : la fonction est appelée pour chaque
débris, chaque frame. La force sur un corps en découle :

```
F_drag = ½ · ρ · |v_rel|² · C_d · A,    v_rel = v_vent − v_objet
```

## 2. Rendu — hybride mesh + particules, zéro raymarching (`tornadoShaders.ts`)

- **Cône** : cylindre unité ouvert (128×96 segments) ; profil d'entonnoir,
  rotation différentielle de la paroi (plus rapide au sol), turbulence par
  bruit simplex 3D échantillonné en espace cylindrique `(cos a, sin a, h)`
  (continuité parfaite sur la couture) et méandre de l'axe — tout en vertex
  shader.
- **Fragment** : éclairage participatif simplifié — *forward scattering*
  (phase de Mie ≈ `pow(cosθ, 6)` pondérée par la finesse du bord) pour le
  liseré argenté en contre-jour, plus assombrissement du cœur (la paroi
  épaisse au centre de la silhouette occulte l'ambiante vert-gris
  supercellulaire).
- **Particules** : `THREE.Points`, position en *closed-form* `f(seed, t)`
  évaluée en vertex shader — debris ball au sol (vitesse angulaire de Rankine)
  et hélices de condensation sur la paroi. Aucun upload CPU par frame.

## 3. Destruction hybride (`DestructionSystem.ts`)

- Bâtiments = sous-maillages pré-découpés (toit, mur_nord, …) **dormants** :
  zéro coût tant que `q·C_d·A < Seuil_Structure`, avec `q = ½ρ|v|²`.
  Seuils : toit ≈ 0.9 kPa (~38 m/s, EF1), murs ≈ 1.9 kPa (~55 m/s).
- Pièce arrachée → corps libre intégré en Euler semi-implicite sous
  `F_drag + m·g` ; la trajectoire hélicoïdale **émerge** de la traînée dans le
  champ tournant, rien n'est scripté.
- Budget constant : tests structurels en round-robin (4 bâtiments/frame) avec
  culling de distance ; éclats génériques dans un `InstancedMesh` unique de
  512 instances avec free-list (object pooling strict — aucune géométrie créée
  en cours de partie) ; retraits en swap-pop O(1) ; accélération bornée pour
  la stabilité numérique.

## 4. Radar Doppler (`DopplerRadar.ts`)

Deux textures 256² rendues sur GPU (triangle plein-écran → render targets),
rafraîchies à ~3 Hz (cadence de balayage) :

- **Base Reflectivity** : le champ de précipitation (noyau gaussien anisotrope
  + rideau avant, texturé fbm) est **advecté cycloniquement** autour du
  mésocyclone (`rotation ∝ e^(−r²/σ)`), ce qui enroule le bord arrière du
  noyau et dessine physiquement le *hook echo* ; une encoche d'alimentation
  (WER) creuse l'écho derrière le crochet. Palette NWS 5–70+ dBZ.
- **Storm Relative Velocity** : projection du profil de Rankine sur l'axe du
  faisceau (`v_r = v⃗·beam`), radar mobile au centre de l'écran → couplet
  vert (inbound) / rouge (outbound) juxtaposé sur le méso, masqué là où la
  réflectivité est insuffisante, bruité façon mesure réelle.

## Boucle de jeu (`main.ts`)

Vortex (trajectoire + méandre) → tornade (uniforms GPU) → destruction
(round-robin) → débris (intégration) → véhicule (poussée du vent ½ρv²C_dA,
secousses caméra) → HUD (radar à 3 Hz, panneau météo à 4 Hz) → rendu scène
puis rendu HUD (`clearDepth` entre les deux).

```bash
npm install
npm run dev    # http://localhost:5173
npm run build  # tsc --noEmit + vite build
```
