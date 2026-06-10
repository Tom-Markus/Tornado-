import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { VortexField, EF4_PRESET } from './physics/VortexField';
import { DebrisSystem, DestructibleBuilding, DestructionManager } from './physics/DestructionSystem';
import { Tornado } from './rendering/Tornado';
import { DopplerRadar } from './hud/DopplerRadar';

// ───────────────────────── Renderer / scène ─────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.autoClear = false;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3f4a42);
scene.fog = new THREE.Fog(0x3f4a42, 250, 2800);

scene.add(new THREE.HemisphereLight(0x70806a, 0x3a352c, 0.9));
const sun = new THREE.DirectionalLight(0xffe2b0, 1.1);
sun.position.set(-300, 280, -2000); // soleil bas, derrière la tornade → contre-jour
scene.add(sun);
const sunDirection = sun.position.clone().normalize();

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(8000, 8000),
  new THREE.MeshLambertMaterial({ color: 0x55603e }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// Plafond nuageux sombre de la supercellule (ancre visuelle du sommet du cône).
const ceiling = new THREE.Mesh(
  new THREE.CircleGeometry(2400, 48),
  new THREE.MeshBasicMaterial({ color: 0x2a2f29, transparent: true, opacity: 0.92 }),
);
ceiling.rotation.x = Math.PI / 2;
ceiling.position.y = EF4_PRESET.height * 0.98;
scene.add(ceiling);

// ───────────────────────── Simulation ───────────────────────────────────
const vortex = new VortexField(EF4_PRESET);
vortex.center.set(-150, -900);

const tornado = new Tornado(EF4_PRESET);
scene.add(tornado.group);

const debris = new DebrisSystem(scene, 512);
const destruction = new DestructionManager();

for (let i = 0; i < 26; i++) {
  const building = DestructibleBuilding.farmhouse(
    6 + Math.random() * 6,
    5 + Math.random() * 4,
    2.8 + Math.random() * 1.5,
  );
  building.group.position.set(
    (Math.random() - 0.5) * 1600,
    0,
    -1200 + Math.random() * 1400,
  );
  building.group.rotation.y = Math.random() * Math.PI;
  scene.add(building.group);
  destruction.add(building);
}

// ───────────────── Véhicule + caméra tourelle de toit ───────────────────
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 6000);
const controls = new PointerLockControls(camera, renderer.domElement);
renderer.domElement.addEventListener('click', () => controls.lock());

const vehicle = {
  position: new THREE.Vector3(0, 0, 260),
  heading: Math.PI, // face à -Z, vers la tempête
  speed: 0,
  windDrift: new THREE.Vector3(),
};
const TURRET_HEIGHT = 2.7;
const VEHICLE_MASS = 2400;
const VEHICLE_AREA = 6.5;
const VEHICLE_CD = 1.05;

const keys = new Set<string>();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

const _forward = new THREE.Vector3();
const _windForce = new THREE.Vector3();
const _vehicleVelocity = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _localWind = new THREE.Vector3();
const _toVortex = new THREE.Vector3();

function updateVehicle(dt: number) {
  const accelInput =
    (keys.has('KeyW') || keys.has('KeyZ') ? 1 : 0) - (keys.has('KeyS') ? 0.7 : 0);
  const steerInput =
    (keys.has('KeyA') || keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0);

  vehicle.speed += accelInput * 12 * dt;
  vehicle.speed *= 1 - 0.6 * dt; // résistance de roulement
  vehicle.speed = THREE.MathUtils.clamp(vehicle.speed, -10, 38);

  const steerScale = Math.min(Math.abs(vehicle.speed) / 12 + 0.15, 1);
  vehicle.heading += steerInput * 1.6 * steerScale * dt * Math.sign(vehicle.speed || 1);

  _forward.set(Math.sin(vehicle.heading), 0, Math.cos(vehicle.heading));

  // Poussée du vent sur la caisse : F_drag = ½ρ|v_rel|²·C_d·A.
  _vehicleVelocity.copy(_forward).multiplyScalar(vehicle.speed).add(vehicle.windDrift);
  _probe.copy(vehicle.position).setY(1.5);
  vortex.getDragForce(_probe, _vehicleVelocity, VEHICLE_AREA, VEHICLE_CD, _windForce);
  vehicle.windDrift.addScaledVector(_windForce, dt / VEHICLE_MASS);
  vehicle.windDrift.multiplyScalar(1 - 1.5 * dt); // adhérence des pneus
  vehicle.windDrift.y = 0;

  vehicle.position.addScaledVector(_forward, vehicle.speed * dt);
  vehicle.position.addScaledVector(vehicle.windDrift, dt);

  // Caméra tourelle : posée sur le toit, secouée par les rafales.
  camera.position.set(vehicle.position.x, TURRET_HEIGHT, vehicle.position.z);
  vortex.getWindVelocity(_probe, _localWind);
  const gust = _localWind.length();
  if (gust > 22) {
    const shake = (gust - 22) * 0.0035;
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.position.z += (Math.random() - 0.5) * shake;
  }
}

// ───────────────────────── HUD radar ─────────────────────────────────────
const RADAR_RANGE = 1200; // m couverts par le rayon de l'écran radar

const radar = new DopplerRadar(256);
const hudScene = new THREE.Scene();
const hudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);

const reflectivityQuad = new THREE.Mesh(
  new THREE.PlaneGeometry(0.56, 0.56),
  new THREE.MeshBasicMaterial({ map: radar.reflectivityTarget.texture }),
);
const velocityQuad = new THREE.Mesh(
  new THREE.PlaneGeometry(0.56, 0.56),
  new THREE.MeshBasicMaterial({ map: radar.velocityTarget.texture }),
);
hudScene.add(reflectivityQuad, velocityQuad);

function layoutHud() {
  const aspect = window.innerWidth / window.innerHeight;
  hudCamera.left = -aspect;
  hudCamera.right = aspect;
  hudCamera.updateProjectionMatrix();
  reflectivityQuad.position.set(-aspect + 0.34, -0.66, -1);
  velocityQuad.position.set(-aspect + 0.96, -0.66, -1);
}
layoutHud();

const radarState = {
  mesoUV: new THREE.Vector2(),
  stormMotion: new THREE.Vector2(),
  maxWind: EF4_PRESET.omega * EF4_PRESET.coreRadius,
  time: 0,
};

function updateRadar(time: number) {
  // Monde → écran radar centré véhicule, nord (-Z) en haut.
  const dx = vortex.center.x - vehicle.position.x;
  const dz = vortex.center.y - vehicle.position.z;
  radarState.mesoUV.set(
    0.5 + (dx / RADAR_RANGE) * 0.5,
    0.5 - (dz / RADAR_RANGE) * 0.5,
  );
  radarState.stormMotion.set(vortex.motion.x, -vortex.motion.y).normalize();
  radarState.time = time;
  radar.update(renderer, radarState);
}

// ─────────────────── Panneau météo (HTML overlay) ───────────────────────
const panelBody = document.getElementById('panel-body') as HTMLElement;

function updatePanel(time: number) {
  const dx = vortex.center.x - vehicle.position.x;
  const dz = vortex.center.y - vehicle.position.z;
  const distance = Math.hypot(dx, dz);
  const azimuth = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;

  _probe.copy(vehicle.position).setY(2);
  vortex.getWindVelocity(_probe, _localWind);
  const stationWind = _localWind.length();
  _toVortex.set(dx, 0, dz).normalize();
  const radialVel = _localWind.dot(_toVortex); // composante vers le vortex

  const vMax = EF4_PRESET.omega * EF4_PRESET.coreRadius;
  const dbz = Math.min(72, 74 * Math.exp(-distance / 1100) + Math.sin(time * 0.7) * 2 + 50 * Math.exp(-distance / 250));
  const pressure = 1002 - 46 * Math.exp(-distance / 400);
  const jitter = (f: number, a: number) => Math.sin(time * f) * a;

  panelBody.textContent =
    `CELLULE   : SUPERCELLULE "TIGER-1"\n` +
    `DIST VORTEX : ${distance.toFixed(0)} m   AZ ${azimuth.toFixed(0)}°\n` +
    `V_MAX (Rankine) : ${vMax.toFixed(0)} m/s (${(vMax * 3.6).toFixed(0)} km/h)\n` +
    `R_CŒUR : ${EF4_PRESET.coreRadius} m   CLASSE : EF4\n` +
    `dBZ (station) : ${dbz.toFixed(1)}\n` +
    `VENT STATION : ${stationWind.toFixed(1)} m/s\n` +
    `V RADIALE : ${radialVel.toFixed(1)} m/s\n` +
    `──────────────────────────\n` +
    `CAPE ${(4120 + jitter(0.21, 35)).toFixed(0)} J/kg   CIN ${(-18 + jitter(0.17, 3)).toFixed(0)} J/kg\n` +
    `SRH 0-1km ${(412 + jitter(0.13, 14)).toFixed(0)} m²/s²\n` +
    `LCL ${(660 + jitter(0.11, 18)).toFixed(0)} m\n` +
    `P STATION : ${pressure.toFixed(1)} hPa ↓`;
}

// ───────────────────────── Boucle principale ────────────────────────────
const clock = new THREE.Clock();
let radarTimer = 1;
let panelTimer = 1;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const time = clock.elapsedTime;

  vortex.update(dt);
  tornado.update(dt, vortex, sunDirection);
  destruction.update(vortex, debris, 4);
  debris.update(dt, vortex);
  updateVehicle(dt);

  radarTimer += dt;
  if (radarTimer > 0.35) {
    radarTimer = 0;
    updateRadar(time);
  }
  panelTimer += dt;
  if (panelTimer > 0.25) {
    panelTimer = 0;
    updatePanel(time);
  }

  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(hudScene, hudCamera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  layoutHud();
});

animate();
