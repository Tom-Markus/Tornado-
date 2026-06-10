import * as THREE from 'three';

/**
 * Pluie battante GPU — enveloppe la caméra du chasseur de tempête.
 *
 * Chaque strie est un segment de droite (2 sommets) dont la position est une
 * fonction fermée de (seed, temps) évaluée en vertex shader : zéro simulation
 * CPU, zéro upload par frame. Les stries vivent dans une boîte centrée sur la
 * caméra ; chaque axe « boucle » (mod) indépendamment, si bien qu'une goutte
 * qui sort par le bas réapparaît en haut — pluie infinie sans réinjection CPU.
 *
 * La direction de chute = normalize(uRainVelocity) : en injectant une forte
 * composante horizontale (vent du vortex), la pluie devient quasi-horizontale
 * et inclinée, ce qui donne la sensation d'être physiquement dans la tempête.
 */
const RAIN_VERTEX_SHADER = /* glsl */ `
attribute float aSeed;
attribute float aEnd;            // 0 = tête de la strie, 1 = queue

uniform float uTime;
uniform vec3 uCameraPos;
uniform vec3 uBox;               // demi-dimensions de la boîte autour de la caméra
uniform vec3 uRainVelocity;      // m/s — chute + dérive horizontale du vent
uniform float uStreakLength;     // longueur visuelle d'une strie (m)

varying float vAlpha;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  vec3 r = vec3(hash(aSeed * 0.317 + 0.11),
                hash(aSeed * 0.911 + 0.53),
                hash(aSeed * 0.621 + 0.97));

  // Position de base répartie dans la boîte, advectée par le vent puis bouclée.
  vec3 box = uBox * 2.0;
  vec3 p = r * box + uRainVelocity * uTime;
  p = mod(p, box) - uBox;        // wrap centré [-uBox, +uBox]

  // Étire le segment le long de la vitesse de la pluie (queue en arrière).
  vec3 dir = normalize(uRainVelocity);
  vec3 world = uCameraPos + p - dir * aEnd * uStreakLength;

  // Atténuation radiale douce : la pluie proche est nette, la lointaine fond
  // dans le brouillard. La tête est plus opaque que la queue.
  float d = length(p) / length(uBox);
  vAlpha = (1.0 - smoothstep(0.6, 1.0, d)) * mix(0.9, 0.15, aEnd);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const RAIN_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;

void main() {
  gl_FragColor = vec4(uColor, vAlpha * 0.5);
}
`;

export class Rain {
  readonly object: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private readonly velocity = new THREE.Vector3();

  constructor(streakCount = 6000) {
    const positions = new Float32Array(streakCount * 2 * 3); // requis, inutilisé
    const seeds = new Float32Array(streakCount * 2);
    const ends = new Float32Array(streakCount * 2);
    for (let i = 0; i < streakCount; i++) {
      seeds[i * 2] = i;
      seeds[i * 2 + 1] = i;
      ends[i * 2] = 0;     // tête
      ends[i * 2 + 1] = 1; // queue
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERTEX_SHADER,
      fragmentShader: RAIN_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uCameraPos: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(85, 55, 85) },
        uRainVelocity: { value: new THREE.Vector3(0, -75, 0) },
        uStreakLength: { value: 3.2 },
        uColor: { value: new THREE.Color(0.62, 0.68, 0.70) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.object = new THREE.LineSegments(geometry, this.material);
    this.object.frustumCulled = false; // suit toujours la caméra
    this.object.renderOrder = 5;
  }

  /**
   * @param windHoriz vent horizontal local (x, z) au niveau de la caméra (m/s) —
   *                  incline la pluie. Plafonné pour rester lisible.
   */
  update(dt: number, cameraPosition: THREE.Vector3, windHoriz: THREE.Vector2) {
    this.material.uniforms.uTime.value += dt;
    (this.material.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPosition);

    // Chute gravitaire + dérive du vent (composante horizontale plafonnée à ±55 m/s
    // pour que les stries restent inclinées et non purement horizontales).
    const k = 0.6;
    this.velocity.set(
      THREE.MathUtils.clamp(windHoriz.x * k, -55, 55),
      -75,
      THREE.MathUtils.clamp(windHoriz.y * k, -55, 55),
    );
    (this.material.uniforms.uRainVelocity.value as THREE.Vector3).copy(this.velocity);
  }
}
