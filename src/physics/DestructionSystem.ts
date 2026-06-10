import * as THREE from 'three';
import { VortexField, AIR_DENSITY } from './VortexField';

const GROUND_Y = 0.15;
/** Borne de stabilité de l'intégrateur semi-implicite (m/s²). */
const MAX_DEBRIS_ACCEL = 400;

/** Sous-maillage pré-découpé d'un bâtiment (toit, mur_nord, …). */
export interface StructuralPiece {
  mesh: THREE.Mesh;
  /** Aire exposée au vent (m²). */
  area: number;
  dragCoefficient: number;
  /** Masse (kg). */
  mass: number;
  /** Seuil_Structure : |F_vent| (N) au-delà duquel la pièce est arrachée. */
  failureForce: number;
  attached: boolean;
}

/**
 * Corps libre dans le champ du vortex. Deux variantes :
 *  - pièce de bâtiment unique (`mesh` non nul ; position/quaternion sont des
 *    RÉFÉRENCES vers ceux du mesh → l'intégration écrit directement dedans) ;
 *  - éclat instancié du pool (`mesh` nul, `instanceId` >= 0).
 */
interface DebrisBody {
  mesh: THREE.Mesh | null;
  instanceId: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  mass: number;
  area: number;
  dragCoefficient: number;
  restTimer: number;
}

// Tampons module : zéro allocation dans la boucle chaude.
const _wind = new THREE.Vector3();
const _vrel = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _spinQ = new THREE.Quaternion();
const _spinE = new THREE.Euler();
const _probe = new THREE.Vector3();

/**
 * Pool de débris : un unique InstancedMesh pour les éclats génériques
 * (jamais de création/destruction de géométrie en cours de partie), plus la
 * liste des pièces de bâtiments détachées. Tout est recyclé via une free-list.
 */
export class DebrisSystem {
  private readonly scene: THREE.Scene;
  private readonly chunkMesh: THREE.InstancedMesh;
  private readonly freeChunks: number[] = [];
  private readonly active: DebrisBody[] = [];
  private readonly dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, chunkCapacity = 512) {
    this.scene = scene;
    const geometry = new THREE.BoxGeometry(0.7, 0.08, 0.22); // planche générique
    const material = new THREE.MeshLambertMaterial({ color: 0x8a7155 });
    this.chunkMesh = new THREE.InstancedMesh(geometry, material, chunkCapacity);
    this.chunkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chunkMesh.frustumCulled = false;

    // Tous les éclats démarrent cachés (échelle nulle) et dans la free-list.
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < chunkCapacity; i++) {
      this.chunkMesh.setMatrixAt(i, this.dummy.matrix);
      this.freeChunks.push(i);
    }
    scene.add(this.chunkMesh);
  }

  get activeCount(): number {
    return this.active.length;
  }

  /** Détache une pièce de bâtiment : elle devient un corps libre dans le vortex. */
  releasePiece(piece: StructuralPiece, wind: THREE.Vector3) {
    const mesh = piece.mesh;
    this.scene.attach(mesh); // re-parente en conservant la transformation monde
    this.active.push({
      mesh,
      instanceId: -1,
      position: mesh.position,
      quaternion: mesh.quaternion,
      velocity: new THREE.Vector3(wind.x * 0.3, 5 + Math.random() * 7, wind.z * 0.3),
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
      ),
      mass: piece.mass,
      area: piece.area * 0.6, // aire moyenne présentée en culbute
      dragCoefficient: piece.dragCoefficient,
      restTimer: 0,
    });
    // Gerbe d'éclats secondaires depuis le point d'arrachement.
    for (let i = 0; i < 6; i++) this.spawnChunk(mesh.position, wind);
  }

  /** Prend un éclat dans le pool. Pool épuisé → on ne crée JAMAIS de géométrie. */
  spawnChunk(position: THREE.Vector3, wind: THREE.Vector3) {
    const id = this.freeChunks.pop();
    if (id === undefined) return;
    this.active.push({
      mesh: null,
      instanceId: id,
      position: new THREE.Vector3(
        position.x + (Math.random() - 0.5) * 2,
        position.y + Math.random() * 2,
        position.z + (Math.random() - 0.5) * 2,
      ),
      quaternion: new THREE.Quaternion(),
      velocity: new THREE.Vector3(
        wind.x * 0.4 + (Math.random() - 0.5) * 8,
        4 + Math.random() * 8,
        wind.z * 0.4 + (Math.random() - 0.5) * 8,
      ),
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
      ),
      mass: 4,
      area: 0.16,
      dragCoefficient: 1.3,
      restTimer: 0,
    });
  }

  /**
   * Intégration semi-implicite (Euler symplectique) de tous les débris actifs :
   *   a = F_drag/m + g, avec F_drag = ½·ρ·|v_rel|²·C_d·A dirigée selon v_rel.
   * La trajectoire hélicoïdale ÉMERGE de la traînée dans le champ tournant du
   * vortex — aucune trajectoire scriptée.
   */
  update(dt: number, vortex: VortexField) {
    const step = Math.min(dt, 1 / 30);
    let chunksDirty = false;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];

      vortex.getWindVelocity(b.position, _wind);
      _vrel.subVectors(_wind, b.velocity);
      const speed = _vrel.length();
      _accel.copy(_vrel).multiplyScalar(
        (0.5 * AIR_DENSITY * b.dragCoefficient * b.area * speed) / b.mass,
      );
      if (_accel.lengthSq() > MAX_DEBRIS_ACCEL * MAX_DEBRIS_ACCEL) {
        _accel.setLength(MAX_DEBRIS_ACCEL);
      }
      _accel.y -= 9.81;

      b.velocity.addScaledVector(_accel, step);
      b.position.addScaledVector(b.velocity, step);

      // Rotation propre (culbute).
      _spinE.set(
        b.angularVelocity.x * step,
        b.angularVelocity.y * step,
        b.angularVelocity.z * step,
      );
      _spinQ.setFromEuler(_spinE);
      b.quaternion.multiply(_spinQ);

      // Contact sol : rebond amorti + frottement.
      if (b.position.y < GROUND_Y) {
        b.position.y = GROUND_Y;
        b.velocity.y *= -0.25;
        b.velocity.x *= 0.65;
        b.velocity.z *= 0.65;
        b.angularVelocity.multiplyScalar(0.6);
        if (b.velocity.lengthSq() < 2.0) b.restTimer += step;
        else b.restTimer = 0;
      }

      const dx = b.position.x - vortex.center.x;
      const dz = b.position.z - vortex.center.y;
      const farAway = dx * dx + dz * dz > 4_000_000 || b.position.y > 2000;

      if (b.restTimer > 4 || farAway) {
        if (b.instanceId >= 0 || farAway) {
          this.recycle(i);
          chunksDirty = true;
        } else {
          // Pièce de bâtiment posée au sol : on la fige (épave persistante)
          // et on la retire simplement de la boucle de simulation.
          this.removeFromActive(i);
        }
        continue;
      }

      if (b.instanceId >= 0) {
        this.dummy.position.copy(b.position);
        this.dummy.quaternion.copy(b.quaternion);
        this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix();
        this.chunkMesh.setMatrixAt(b.instanceId, this.dummy.matrix);
        chunksDirty = true;
      }
    }

    if (chunksDirty) this.chunkMesh.instanceMatrix.needsUpdate = true;
  }

  private recycle(index: number) {
    const b = this.active[index];
    if (b.instanceId >= 0) {
      this.dummy.position.set(0, -10, 0);
      this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      this.chunkMesh.setMatrixAt(b.instanceId, this.dummy.matrix);
      this.freeChunks.push(b.instanceId);
    } else if (b.mesh) {
      this.scene.remove(b.mesh);
    }
    this.removeFromActive(index);
  }

  /** Retrait O(1) par swap-pop — pas de splice dans la boucle chaude. */
  private removeFromActive(index: number) {
    this.active[index] = this.active[this.active.length - 1];
    this.active.pop();
  }
}

/**
 * Bâtiment de la Tornado Alley : assemblage de sous-maillages pré-découpés,
 * chacun doté d'un seuil de rupture. Les corps restent "dormants" (aucune
 * simulation) tant que |F_vent| < Seuil_Structure.
 */
export class DestructibleBuilding {
  readonly group = new THREE.Group();
  readonly pieces: StructuralPiece[] = [];
  private intactCount = 0;

  get intact(): boolean {
    return this.intactCount > 0;
  }

  addPiece(mesh: THREE.Mesh, area: number, mass: number, failureForce: number, dragCoefficient = 1.2) {
    this.group.add(mesh);
    this.pieces.push({ mesh, area, mass, failureForce, dragCoefficient, attached: true });
    this.intactCount++;
  }

  /**
   * Test de rupture : pression dynamique q = ½·ρ·|v|², force par pièce
   * F = q·C_d·A. Si F > failureForce, la pièce est confiée au DebrisSystem.
   */
  checkFailure(vortex: VortexField, debris: DebrisSystem) {
    _probe.set(this.group.position.x, 5, this.group.position.z);
    vortex.getWindVelocity(_probe, _wind);
    const q = 0.5 * AIR_DENSITY * _wind.lengthSq();

    for (const piece of this.pieces) {
      if (!piece.attached) continue;
      const force = q * piece.dragCoefficient * piece.area;
      if (force > piece.failureForce) {
        piece.attached = false;
        this.intactCount--;
        debris.releasePiece(piece, _wind);
      }
    }
  }

  /**
   * Ferme à ossature bois : 4 murs + toit.
   * Le toit cède vers q ≈ 0.9 kPa (~38 m/s, EF1) — toujours la première pièce
   * arrachée ; les murs tiennent jusqu'à q ≈ 1.9 kPa (~55 m/s, EF2/EF3).
   */
  static farmhouse(w: number, d: number, h: number): DestructibleBuilding {
    const b = new DestructibleBuilding();
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xb9aa8d });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x6e4f3a });
    const t = 0.18;

    const wall = (gw: number, gh: number, x: number, z: number, ry: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, t), wallMat);
      m.position.set(x, gh / 2, z);
      m.rotation.y = ry;
      b.addPiece(m, gw * gh, 35 * gw * gh, 1900 * 1.2 * gw * gh, 1.2);
    };
    wall(w, h, 0, -d / 2, 0);            // mur_nord
    wall(w, h, 0, d / 2, 0);             // mur_sud
    wall(d, h, -w / 2, 0, Math.PI / 2);  // mur_ouest
    wall(d, h, w / 2, 0, Math.PI / 2);   // mur_est

    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.22, d + 0.7), roofMat);
    roof.position.y = h + 0.11;
    b.addPiece(roof, (w + 0.7) * (d + 0.7), 28 * w * d, 900 * 1.3 * (w + 0.7) * (d + 0.7), 1.3);

    return b;
  }
}

/**
 * Ordonnanceur des tests structurels : round-robin de N bâtiments par frame,
 * avec culling de distance — le coût par frame est constant quel que soit le
 * nombre de bâtiments dans la scène.
 */
export class DestructionManager {
  private readonly buildings: DestructibleBuilding[] = [];
  private cursor = 0;

  add(building: DestructibleBuilding) {
    this.buildings.push(building);
  }

  update(vortex: VortexField, debris: DebrisSystem, checksPerFrame = 4) {
    const n = this.buildings.length;
    if (n === 0) return;
    for (let k = 0; k < Math.min(checksPerFrame, n); k++) {
      this.cursor = (this.cursor + 1) % n;
      const b = this.buildings[this.cursor];
      if (!b.intact) continue;
      const dx = b.group.position.x - vortex.center.x;
      const dz = b.group.position.z - vortex.center.y;
      const cull = vortex.params.maxRadius * 1.2;
      if (dx * dx + dz * dz > cull * cull) continue;
      b.checkFailure(vortex, debris);
    }
  }
}
