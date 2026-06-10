/**
 * Shaders GLSL de la tornade.
 *
 * Approche hybride, AUCUN raymarching volumétrique :
 *  1. un cône-maillage dont les sommets sont déplacés en vertex shader par un
 *     bruit simplex 3D (paroi turbulente, rotation différentielle, méandre) ;
 *  2. des particules GPU analytiques (voir DUST_*) pour le debris ball au sol
 *     et les bandes de condensation hélicoïdales.
 */

/** Bruit simplex 3D — implémentation de référence Ashima/Stefan Gustavson. */
const SIMPLEX_NOISE_3D = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

/**
 * Vertex shader du cône : la géométrie source est un cylindre ouvert de rayon 1 ;
 * le profil d'entonnoir, la rotation différentielle de la paroi, la turbulence
 * (simplex 3D échantillonné en espace cylindrique, donc sans couture) et le
 * méandre de l'axe sont entièrement calculés sur GPU.
 */
export const TORNADO_VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform float uHeight;
uniform float uBottomRadius;
uniform float uTopRadius;
uniform float uProfileExponent;
uniform float uNoiseAmplitude;   // déplacement radial, fraction du rayon local
uniform float uNoiseFrequency;
uniform float uRotationSpeed;    // rad/s de la paroi au sol
uniform float uBendAmplitude;    // m — amplitude du méandre de la pointe

varying vec3 vWorldPosition;
varying vec3 vNormal;
varying float vHeight01;
varying float vTurbulence;

${SIMPLEX_NOISE_3D}

void main() {
  float h = clamp(position.y / uHeight, 0.0, 1.0);
  float angle = atan(position.z, position.x);

  // Profil d'entonnoir : pointe étroite au sol, évasement vers le wall cloud.
  float radius = mix(uBottomRadius, uTopRadius, pow(h, uProfileExponent));

  // Rotation différentielle : la paroi tourne plus vite près du sol
  // (étirement du moment angulaire dans la colonne).
  float spin = uTime * uRotationSpeed * mix(1.8, 0.6, h);
  float a = angle - spin;

  // Turbulence : bruit échantillonné sur le cylindre unité (cos a, sin a)
  // → continuité parfaite sur la couture, advection verticale avec le temps.
  vec3 np = vec3(cos(a), sin(a), h * 6.0 - uTime * 0.45) * uNoiseFrequency;
  float n1 = snoise(np);
  float n2 = snoise(np * 2.63 + vec3(13.1, 7.7, 3.9));
  float turbulence = n1 + 0.45 * n2;
  vTurbulence = turbulence;

  radius *= 1.0 + uNoiseAmplitude * turbulence * (0.5 + 0.9 * h);

  vec3 displaced = vec3(cos(angle) * radius, position.y, sin(angle) * radius);

  // Méandre grande échelle : la pointe danse, le sommet reste ancré au méso.
  float anchor = pow(1.0 - h, 1.6);
  displaced.x += uBendAmplitude * anchor * snoise(vec3(0.0, h * 1.2, uTime * 0.1));
  displaced.z += uBendAmplitude * anchor * snoise(vec3(9.4, h * 1.2, uTime * 0.1));

  // Normale de la surface de révolution : composante verticale = -dR/dy (pente moyenne).
  float slope = -(uTopRadius - uBottomRadius) / uHeight;
  vNormal = normalize(normalMatrix * normalize(vec3(cos(angle), slope, sin(angle))));
  vHeight01 = h;

  vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

/**
 * Fragment shader : modèle d'éclairage participatif simplifié.
 *  - Forward scattering (phase de Mie approchée par pow(cosθ, k)) : le soleil
 *    "perce" les bords optiquement fins de la paroi — liseré argenté.
 *  - Assombrissement central : la paroi épaisse au centre de la silhouette
 *    bloque la lumière ambiante vert-gris de la supercellule.
 */
export const TORNADO_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uSunDirection;   // direction normalisée VERS le soleil (monde)
uniform vec3 uSunColor;
uniform vec3 uAmbientSky;     // ambiance vert-gris supercellulaire
uniform vec3 uDustColor;      // teinte de la paroi (poussière + condensation)
uniform float uOpacity;

varying vec3 vWorldPosition;
varying vec3 vNormal;
varying float vHeight01;
varying float vTurbulence;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPosition);

  // Bord de silhouette = faible épaisseur optique ; centre = paroi épaisse.
  float rim = 1.0 - abs(dot(N, V));
  float thickness = 1.0 - rim;

  // ── Forward scattering : lumière du soleil traversant les bords fins ────
  // -uSunDirection = direction de propagation des rayons ; le pic de diffusion
  // avant survient quand cette propagation continue vers l'œil (alignée sur V).
  float phase = pow(max(dot(V, -uSunDirection), 0.0), 6.0);
  vec3 scatter = uSunColor * phase * rim * rim * 1.6;

  // ── Assombrissement du cœur : auto-occultation de la lumière du ciel ────
  float occlusion = mix(1.0, 0.12, thickness);
  occlusion *= mix(0.35, 1.0, vHeight01); // base chargée de débris = plus sombre
  vec3 ambient = uAmbientSky * occlusion;

  // Diffus enveloppant (wrap) côté soleil.
  float wrap = clamp((dot(N, uSunDirection) + 0.6) / 1.6, 0.0, 1.0);
  vec3 diffuse = uSunColor * wrap * 0.22;

  vec3 color = uDustColor * (ambient + diffuse) + scatter;
  color *= 0.92 + 0.10 * vTurbulence; // micro-variations de densité de la paroi

  float alpha = uOpacity * (0.5 + 0.5 * thickness);
  alpha *= clamp(0.8 + 0.3 * vTurbulence, 0.0, 1.0);

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
`;

/**
 * Particules GPU 100 % analytiques (THREE.Points) : la position de chaque
 * particule est une fonction fermée de (seed, temps) évaluée en vertex shader
 * — zéro upload CPU par frame, zéro simulation CPU.
 *  - bande 0 : debris ball — anneau de poussière au sol, profil de Rankine ;
 *  - bande 1 : filaments de condensation hélicoïdaux montant le long de la paroi.
 */
export const DUST_VERTEX_SHADER = /* glsl */ `
attribute float aSeed;

uniform float uTime;
uniform float uOmega;            // ω du vortex (rad/s)
uniform float uCoreRadius;
uniform float uHeight;
uniform float uBottomRadius;
uniform float uTopRadius;
uniform float uProfileExponent;
uniform float uPointSize;

varying float vFade;
varying float vBand;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  float s1 = hash(aSeed * 0.013 + 0.17);
  float s2 = hash(aSeed * 0.027 + 0.71);
  float s3 = hash(aSeed * 0.041 + 0.39);
  vBand = step(0.55, s3);

  vec3 p;
  float fade;

  if (vBand < 0.5) {
    // ── Debris ball : poussière au sol entraînée par la circulation ──────
    float radius = uCoreRadius * (0.35 + 2.0 * s2);
    radius *= 0.85 + 0.30 * sin(uTime * 0.55 + s1 * 6.2831853);
    // Vitesse angulaire de Rankine : ω constant dans le cœur, ω·R²/r² dehors.
    float w = (radius < uCoreRadius)
      ? uOmega
      : uOmega * uCoreRadius * uCoreRadius / (radius * radius);
    float ang = s1 * 6.2831853 + w * uTime;
    float yy = 0.5 + 14.0 * s2 * s2 + 3.0 * abs(sin(uTime * 1.2 + s2 * 9.0));
    p = vec3(cos(ang) * radius, yy, sin(ang) * radius);
    fade = 1.0 - smoothstep(1.4, 2.4, radius / uCoreRadius);
  } else {
    // ── Bandes de condensation : hélices montant sur la paroi du cône ────
    float h = fract(s2 + uTime * 0.025 * (0.5 + s1));
    float funnel = mix(uBottomRadius, uTopRadius, pow(h, uProfileExponent));
    float radius = funnel * (1.08 + 0.30 * s1);
    float w = uOmega * mix(1.8, 0.6, h);
    float ang = s1 * 6.2831853 + w * uTime + (1.0 - h) * 3.0;
    p = vec3(cos(ang) * radius, h * uHeight, sin(ang) * radius);
    fade = sin(3.14159 * h) * 0.8;
  }

  vFade = fade;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uPointSize * mix(1.0, 2.2, vBand) * (260.0 / max(-mvPosition.z, 1.0));
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const DUST_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uDustColor;
uniform vec3 uCondensationColor;

varying float vFade;
varying float vBand;

void main() {
  float d = length(gl_PointCoord - 0.5);
  float alpha = smoothstep(0.5, 0.08, d) * vFade * 0.28;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(mix(uDustColor, uCondensationColor, vBand), alpha);
}
`;
