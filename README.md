# Tornado Chaser

Jeu de chasseur de tornades première personne dans le navigateur — WebGL 2,
Three.js, TypeScript, shaders GLSL.

- Vortex de Rankine modifié comme champ de force 3D (rotation, inflow/outflow, updraft)
- Cône de tornade déformé sur GPU (bruit simplex 3D) + particules analytiques (debris ball, condensation)
- Destruction de bâtiments par pression dynamique, débris entraînés par la traînée aérodynamique (object pooling strict)
- Ordinateur de bord météo : radar de réflectivité (hook echo) et vitesse radiale (couplet SRV) générés en shader

```bash
npm install
npm run dev
```

Cliquer pour verrouiller la souris (tourelle de toit), ZQSD/WASD pour conduire.

Architecture détaillée et équations : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
