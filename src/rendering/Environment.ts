import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Décor « Tornado Alley » : ciel dégradé lumineux (l'horizon clair iconique
 * d'une base de supercellule), plaine agricole texturée, route filant vers la
 * tempête, ligne électrique et arbres instanciés. Tout est statique et bon
 * marché pour le GPU (textures procédurales + InstancedMesh).
 */
export interface EnvColors {
  horizon: THREE.Color; // bas du ciel, lumineux (= couleur du brouillard)
  zenith: THREE.Color;  // haut du ciel, sombre et menaçant
}

/** Ciel : dôme inversé avec dégradé vertical zénith → horizon. */
function buildSky(colors: EnvColors): THREE.Mesh {
  const geo = new THREE.SphereGeometry(5000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uHorizon: { value: colors.horizon.clone() },
      uZenith: { value: colors.zenith.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      varying vec3 vDir;
      void main() {
        float h = normalize(vDir).y;
        // Bande lumineuse rasante à l'horizon, assombrissement vers le zénith.
        float t = smoothstep(-0.08, 0.55, h);
        vec3 col = mix(uHorizon, uZenith, t);
        // Léger renforcement de la lueur juste au-dessus de l'horizon.
        col += uHorizon * 0.25 * exp(-pow((h - 0.02) * 7.0, 2.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.renderOrder = -10;
  return sky;
}

/** Texture procédurale de plaine : patchwork de champs verts/ocre + sillons. */
function makeGroundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#6a7748';
  ctx.fillRect(0, 0, 1024, 1024);

  const palette = ['#5b6a3c', '#74824a', '#566032', '#8a8b52', '#48542d', '#7d7340'];
  for (let i = 0; i < 550; i++) {
    ctx.fillStyle = palette[(Math.random() * palette.length) | 0];
    ctx.globalAlpha = 0.25 + Math.random() * 0.4;
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const r = 18 + Math.random() * 130;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.4 + Math.random() * 0.9), Math.random() * 3.14, 0, 7);
    ctx.fill();
  }

  // Sillons de labour pour quelques champs (lignes parallèles fines).
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = '#3f4a28';
  for (let f = 0; f < 8; f++) {
    const ox = Math.random() * 1024;
    const oy = Math.random() * 1024;
    const ang = Math.random() * Math.PI;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate(ang);
    for (let l = -120; l < 120; l += 4) {
      ctx.beginPath();
      ctx.moveTo(l, -120);
      ctx.lineTo(l, 120);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(28, 28); // champs plus grands → variation visible jusqu'au loin
  return tex;
}

/** Géométrie d'un poteau électrique en « T » (mât + traverse), fusionnée. */
function makePoleGeometry(): THREE.BufferGeometry {
  const mast = new THREE.BoxGeometry(0.35, 11, 0.35);
  mast.translate(0, 5.5, 0);
  const arm = new THREE.BoxGeometry(3.6, 0.3, 0.3);
  arm.translate(0, 9.6, 0);
  const arm2 = new THREE.BoxGeometry(2.6, 0.3, 0.3);
  arm2.translate(0, 8.6, 0);
  return mergeGeometries([mast, arm, arm2])!;
}

export function buildEnvironment(scene: THREE.Scene, colors: EnvColors): void {
  scene.add(buildSky(colors));

  // ── Sol agricole texturé ───────────────────────────────────────────────
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 9000),
    new THREE.MeshStandardMaterial({
      map: makeGroundTexture(),
      roughness: 0.95,
      metalness: 0.0,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ── Route asphaltée mouillée filant vers la tempête (axe Z) ────────────
  // roughness basse → l'asphalte reflète le ciel = aspect détrempé sous l'orage.
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(7, 7000),
    new THREE.MeshStandardMaterial({ color: 0x32352f, roughness: 0.35, metalness: 0.1 }),
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.03, -1200);
  scene.add(road);

  // Bas-côtés de gravier plus clairs (cadrent la route, cassent le noir).
  for (const sx of [-5.2, 5.2]) {
    const shoulder = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 7000),
      new THREE.MeshStandardMaterial({ color: 0x6a6450, roughness: 1 }),
    );
    shoulder.rotation.x = -Math.PI / 2;
    shoulder.position.set(sx, 0.02, -1200);
    scene.add(shoulder);
  }

  // Bande centrale jaune discontinue.
  const dashMat = new THREE.MeshStandardMaterial({ color: 0x8c7a2c, roughness: 1 });
  const dashGeo = new THREE.PlaneGeometry(0.35, 4);
  const dashCount = 120;
  const dashes = new THREE.InstancedMesh(dashGeo, dashMat, dashCount);
  const m = new THREE.Matrix4();
  for (let i = 0; i < dashCount; i++) {
    m.makeRotationX(-Math.PI / 2);
    m.setPosition(0, 0.05, 1400 - i * 30);
    dashes.setMatrixAt(i, m);
  }
  scene.add(dashes);

  // ── Ligne électrique : poteaux instanciés des deux côtés de la route ───
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2e271d, roughness: 0.9 });
  const poleGeo = makePoleGeometry();
  const poleCount = 80;
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, poleCount);
  let pi = 0;
  for (let i = 0; i < poleCount / 2; i++) {
    const z = 1400 - i * 55;
    for (const side of [-7, 7]) {
      m.makeTranslation(side, 0, z);
      poles.setMatrixAt(pi++, m);
    }
  }
  poles.castShadow = true;
  scene.add(poles);

  // ── Arbres : tronc + couronne instanciés, semés loin de la route ───────
  const trunkGeo = new THREE.CylinderGeometry(0.4, 0.6, 4, 6);
  trunkGeo.translate(0, 2, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2d1f, roughness: 1 });
  const crownGeo = new THREE.IcosahedronGeometry(3.2, 1);
  crownGeo.translate(0, 6, 0);
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x2f3d24, roughness: 1, flatShading: true });

  const treeCount = 240;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, treeCount);
  let ti = 0;
  for (let i = 0; i < treeCount; i++) {
    const x = (Math.random() - 0.5) * 4500;
    const z = -2400 + Math.random() * 4200;
    if (Math.abs(x) < 30) continue; // libère la route
    const s = 0.7 + Math.random() * 1.4;
    m.makeScale(s, s + Math.random() * 0.5, s);
    m.setPosition(x, 0, z);
    trunks.setMatrixAt(ti, m);
    crowns.setMatrixAt(ti, m);
    ti++;
  }
  trunks.count = ti;
  crowns.count = ti;
  trunks.castShadow = true;
  crowns.castShadow = true;
  scene.add(trunks, crowns);
}
