import * as THREE from 'three';

/**
 * Ordinateur de bord radar : génère deux textures dynamiques sur GPU
 * (rendu d'un triangle plein-écran vers WebGLRenderTarget) :
 *  - mode 0 : Base Reflectivity — écho en crochet (hook echo) dessiné par
 *    advection cyclonique du champ de précipitation autour du mésocyclone ;
 *  - mode 1 : Storm Relative Velocity — couplet vert/rouge (inbound/outbound)
 *    issu de la projection du vortex de Rankine sur l'axe du faisceau.
 */

const RADAR_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const RADAR_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform float uTime;
uniform float uMode;        // 0 = réflectivité, 1 = vitesse radiale
uniform vec2  uMesoUV;      // position du mésocyclone (espace écran 0..1)
uniform vec2  uStormMotion; // direction de déplacement de la cellule (unitaire)
uniform float uSwirl;       // intensité d'enroulement → courbure du crochet
uniform float uMaxWind;     // V_max du vortex (m/s), échelle du couplet SRV

// ── Bruit de valeur 2D + fbm (5 octaves) ─────────────────────────────────
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    v += amp * vnoise(p);
    p = p * 2.07 + 17.3;
    amp *= 0.5;
  }
  return v;
}

// ── Advection cyclonique : rotation différentielle autour du méso ────────
// C'est elle qui enroule le bord arrière du noyau de précipitation et
// dessine physiquement l'écho en crochet.
vec2 swirl(vec2 uv) {
  vec2 q = uv - uMesoUV;
  float r = length(q);
  float a = uSwirl * exp(-r * r / 0.022);
  float c = cos(a);
  float s = sin(a);
  return uMesoUV + mat2(c, -s, s, c) * q;
}

// ── Réflectivité simulée (dBZ, 0..72) ────────────────────────────────────
float reflectivity(vec2 uv) {
  vec2 p = swirl(uv);
  vec2 left = vec2(-uStormMotion.y, uStormMotion.x);

  // Noyau de précipitation (forward-flank downdraft), allongé dans le sens
  // du déplacement, décalé en aval-gauche du mésocyclone.
  vec2 coreCenter = uMesoUV + uStormMotion * 0.13 + left * 0.05;
  vec2 d = p - coreCenter;
  float along = dot(d, uStormMotion);
  float across = dot(d, left);
  float core = exp(-(along * along / 0.050 + across * across / 0.013));

  // Rideau de pluie étendu en avant de la cellule.
  vec2 d2 = p - (coreCenter + uStormMotion * 0.16);
  float shield = 0.55 * exp(-dot(d2, d2) / 0.045);

  float field = core + shield;
  field *= 0.70 + 0.55 * fbm(p * 11.0 + uTime * 0.06);

  // Encoche d'alimentation (inflow notch / WER) : l'air sec aspiré par le
  // méso creuse une zone vide d'écho juste derrière le crochet.
  vec2 n = uv - (uMesoUV - uStormMotion * 0.015 - left * 0.055);
  field *= 1.0 - 0.9 * exp(-dot(n, n) / 0.0035);

  return clamp(field, 0.0, 1.0) * 72.0;
}

// ── Vitesse radiale (m/s) vue depuis le radar mobile (centre de l'écran) ─
float radialVelocity(vec2 uv) {
  vec2 q = uv - uMesoUV;
  float r = max(length(q), 1e-4);
  float coreR = 0.04;
  // Profil de Rankine normalisé : ramp linéaire dans le cœur, 1/r dehors.
  float vt = (r < coreR) ? (r / coreR) : (coreR / r);
  vec2 tangent = vec2(-q.y, q.x) / r;
  vec2 v = tangent * vt * uMaxWind;
  vec2 beam = normalize(uv - vec2(0.5));
  float vr = dot(v, beam); // >0 : s'éloigne du radar ; <0 : s'en approche
  vr += (fbm(uv * 16.0 + 7.7) - 0.5) * 6.0; // bruit de mesure
  return vr;
}

// ── Palette NWS de réflectivité ──────────────────────────────────────────
vec3 dbzColor(float z) {
  if (z <  5.0) return vec3(0.020, 0.030, 0.040);
  if (z < 10.0) return vec3(0.016, 0.914, 0.906);
  if (z < 15.0) return vec3(0.004, 0.624, 0.957);
  if (z < 20.0) return vec3(0.012, 0.000, 0.957);
  if (z < 25.0) return vec3(0.008, 0.992, 0.008);
  if (z < 30.0) return vec3(0.004, 0.773, 0.004);
  if (z < 35.0) return vec3(0.000, 0.557, 0.000);
  if (z < 40.0) return vec3(0.992, 0.973, 0.008);
  if (z < 45.0) return vec3(0.898, 0.737, 0.000);
  if (z < 50.0) return vec3(0.992, 0.584, 0.000);
  if (z < 55.0) return vec3(0.992, 0.000, 0.000);
  if (z < 60.0) return vec3(0.831, 0.000, 0.000);
  if (z < 65.0) return vec3(0.737, 0.000, 0.000);
  if (z < 70.0) return vec3(0.973, 0.000, 0.992);
  return vec3(0.596, 0.329, 0.776);
}

// ── Palette SRV : vert = inbound, rouge = outbound ───────────────────────
vec3 srvColor(float vr) {
  float t = clamp(abs(vr) / 50.0, 0.0, 1.0);
  vec3 inbound  = mix(vec3(0.00, 0.16, 0.02), vec3(0.40, 1.00, 0.30), t);
  vec3 outbound = mix(vec3(0.18, 0.01, 0.01), vec3(1.00, 0.22, 0.12), t);
  return vr < 0.0 ? inbound : outbound;
}

void main() {
  vec2 fromCenter = vUv - 0.5;
  float rr = length(fromCenter);
  vec3 color;

  if (rr > 0.5) {
    color = vec3(0.0); // hors de la portée du scope circulaire
  } else {
    float z = reflectivity(vUv);
    if (uMode < 0.5) {
      color = dbzColor(z);
    } else {
      // Pas d'écho → pas de mesure Doppler exploitable.
      color = (z > 10.0) ? srvColor(radialVelocity(vUv)) : vec3(0.02, 0.03, 0.04);
    }

    // Anneaux de portée.
    float ringDist = abs(fract(rr * 5.0 + 0.5) - 0.5);
    color = mix(color, vec3(0.12, 0.34, 0.16), 0.45 * (1.0 - smoothstep(0.0, 0.025, ringDist)));

    // Balayage de l'antenne.
    float pixelAngle = atan(fromCenter.y, fromCenter.x);
    float sweep = fract(pixelAngle / 6.2831853 - uTime * 0.22);
    color += vec3(0.10, 0.30, 0.14) * pow(1.0 - sweep, 10.0) * 0.6;

    // Marqueur du véhicule (centre de l'écran).
    color = mix(color, vec3(1.0), smoothstep(0.012, 0.006, rr));
  }

  gl_FragColor = vec4(color, 1.0);
}
`;

export interface RadarState {
  /** Position du mésocyclone en espace écran radar (0..1, nord en haut). */
  mesoUV: THREE.Vector2;
  /** Direction de déplacement de la cellule en espace écran (unitaire). */
  stormMotion: THREE.Vector2;
  /** V_max du vortex (m/s). */
  maxWind: number;
  time: number;
}

export class DopplerRadar {
  readonly reflectivityTarget: THREE.WebGLRenderTarget;
  readonly velocityTarget: THREE.WebGLRenderTarget;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor(size = 256) {
    const options: THREE.RenderTargetOptions = { depthBuffer: false, stencilBuffer: false };
    this.reflectivityTarget = new THREE.WebGLRenderTarget(size, size, options);
    this.velocityTarget = new THREE.WebGLRenderTarget(size, size, options);

    this.material = new THREE.ShaderMaterial({
      vertexShader: RADAR_VERTEX_SHADER,
      fragmentShader: RADAR_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uMode: { value: 0 },
        uMesoUV: { value: new THREE.Vector2(0.5, 0.7) },
        uStormMotion: { value: new THREE.Vector2(0, -1) },
        uSwirl: { value: 2.4 },
        uMaxWind: { value: 80 },
      },
      depthTest: false,
      depthWrite: false,
    });

    // Triangle plein-écran (couvre le clip space sans diagonale de quad).
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    const triangle = new THREE.Mesh(geometry, this.material);
    triangle.frustumCulled = false;
    this.scene.add(triangle);
  }

  /** Rend les deux produits radar. À appeler à cadence de balayage (~2-3 Hz). */
  update(renderer: THREE.WebGLRenderer, state: RadarState) {
    const u = this.material.uniforms;
    u.uTime.value = state.time;
    (u.uMesoUV.value as THREE.Vector2).copy(state.mesoUV);
    (u.uStormMotion.value as THREE.Vector2).copy(state.stormMotion);
    u.uMaxWind.value = state.maxWind;

    const previousTarget = renderer.getRenderTarget();

    u.uMode.value = 0;
    renderer.setRenderTarget(this.reflectivityTarget);
    renderer.render(this.scene, this.camera);

    u.uMode.value = 1;
    renderer.setRenderTarget(this.velocityTarget);
    renderer.render(this.scene, this.camera);

    renderer.setRenderTarget(previousTarget);
  }
}
