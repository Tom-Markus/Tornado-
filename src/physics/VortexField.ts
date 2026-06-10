import * as THREE from 'three';

/** Densité de l'air au niveau de la mer (kg/m³). */
export const AIR_DENSITY = 1.225;

/**
 * Paramètres du vortex de Rankine modifié.
 *
 * ── Rotation (vortex de Rankine) ──────────────────────────────────────────
 *   r <  R_core :  V_θ(r) = ω·r                   (rotation en corps solide)
 *   r >= R_core :  V_θ(r) = ω·R_core² / r         (vortex potentiel — le moment
 *                                                  angulaire ω·R_core² est conservé)
 *
 * ── Aspiration (inflow / outflow) ─────────────────────────────────────────
 *   |V_rad|(r) = S · R_core² / max(r², R_core²)    (décroissance en 1/r², bornée
 *                                                   dans le cœur pour éviter la
 *                                                   singularité en r = 0)
 *   Profil vertical :  convergent (vers l'axe) près du sol, pondéré par
 *   e^(−y/H_in) — la couche limite d'alimentation — puis divergent (outflow)
 *   au sommet de la colonne, pondéré par smoothstep(0.7·H, H, y).
 *
 * ── Updraft ───────────────────────────────────────────────────────────────
 *   V_up(r, y) = W · (y/H)^0.7 · e^(−r²/R_core²)
 *   Maximal dans le cœur, croissant avec l'altitude : l'air accélère en
 *   montant vers le mésocyclone (étirement vertical de la supercellule).
 */
export interface VortexParams {
  /** ω — vitesse angulaire du cœur en rotation solide (rad/s). */
  omega: number;
  /** R_core — rayon des vents maximaux (m). V_max = ω·R_core. */
  coreRadius: number;
  /** H — sommet de la colonne de circulation (m). */
  height: number;
  /** S — vitesse d'inflow maximale au sol, à r = R_core (m/s). */
  inflowStrength: number;
  /** H_in — hauteur caractéristique de la couche d'inflow (m). */
  inflowHeight: number;
  /** W — vitesse verticale maximale au sommet du cœur (m/s). */
  updraftStrength: number;
  /** Rayon d'influence au-delà duquel le champ est nul (m). */
  maxRadius: number;
}

/** Tornade EF4 : V_max = ω·R_core = 1.8 × 45 ≈ 81 m/s (~292 km/h). */
export const EF4_PRESET: VortexParams = {
  omega: 1.8,
  coreRadius: 45,
  height: 900,
  inflowStrength: 28,
  inflowHeight: 60,
  updraftStrength: 55,
  maxRadius: 650,
};

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

const _wind = new THREE.Vector3();
const _vrel = new THREE.Vector3();

/**
 * Champ de vecteurs 3D F(x, y, z) de la tornade.
 * `getWindVelocity` est sans allocation (passez un vecteur `out`) :
 * elle est appelée des centaines de fois par frame (débris, particules, véhicule).
 */
export class VortexField {
  readonly params: VortexParams;

  /** Position du pied du vortex au sol — (x, z) monde. */
  readonly center = new THREE.Vector2(0, 0);

  /** Déplacement de la cellule orageuse (m/s), composantes (x, z). */
  readonly motion = new THREE.Vector2(2.5, 9);

  private time = 0;

  constructor(params: VortexParams) {
    this.params = params;
  }

  /** Avance la trajectoire au sol : translation de la cellule + méandre erratique. */
  update(dt: number) {
    this.time += dt;
    const t = this.time;
    // Pseudo-bruit 1D bon marché (somme de sinus incommensurables) : le pied
    // de la tornade "danse" autour de la trajectoire moyenne de la cellule.
    const wobbleX = Math.sin(t * 0.13) * 0.6 + Math.sin(t * 0.047 + 1.7);
    const wobbleZ = Math.cos(t * 0.11) * 0.6 + Math.sin(t * 0.071 + 0.4);
    this.center.x += (this.motion.x + wobbleX * 2.5) * dt;
    this.center.y += (this.motion.y + wobbleZ * 2.5) * dt;
  }

  /**
   * Vitesse du vent (m/s) à une position 3D quelconque.
   * Décomposition cylindrique autour de l'axe vertical du vortex :
   * tangentielle (Rankine) + radiale (inflow/outflow) + verticale (updraft).
   */
  getWindVelocity(position: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    const { omega, coreRadius, height, inflowStrength, inflowHeight, updraftStrength, maxRadius } = this.params;

    const dx = position.x - this.center.x;
    const dz = position.z - this.center.y;
    const y = Math.max(position.y, 0);
    const r = Math.hypot(dx, dz);

    out.set(0, 0, 0);
    if (r > maxRadius || y > height) return out;

    const rSafe = Math.max(r, 1e-3);
    const ux = dx / rSafe; // radial unitaire (sortant)
    const uz = dz / rSafe;

    // ── 1. Tangentielle — vortex de Rankine ──────────────────────────────
    const vTheta = r < coreRadius
      ? omega * r
      : (omega * coreRadius * coreRadius) / rSafe;
    // Sens cyclonique autour de +Y : v = ω×r → direction unitaire (uz, 0, -ux).

    // ── 2. Radiale — inflow au sol (∝ 1/r²), outflow au sommet ───────────
    const radialMag = (inflowStrength * coreRadius * coreRadius) / Math.max(r * r, coreRadius * coreRadius);
    const inflow = radialMag * Math.exp(-y / inflowHeight);
    const outflow = radialMag * 0.6 * smoothstep(0.7 * height, height, y);
    const vRad = outflow - inflow; // négatif = convergent vers l'axe

    // ── 3. Verticale — updraft confiné au cœur, croissant avec y ─────────
    const coreMask = Math.exp(-(r * r) / (coreRadius * coreRadius));
    const vUp = updraftStrength * Math.pow(Math.min(y / height, 1), 0.7) * coreMask;

    // Enveloppe de champ lointain : extinction douce vers maxRadius.
    const envelope = 1 - smoothstep(0.6 * maxRadius, maxRadius, r);

    out.set(
      (vTheta * uz + vRad * ux) * envelope,
      vUp * envelope,
      (-vTheta * ux + vRad * uz) * envelope,
    );
    return out;
  }

  /**
   * Force aérodynamique exercée sur un corps :
   *   F_drag = ½ · ρ · |v_rel|² · C_d · A   (vectorielle : ½ρC_dA·|v_rel|·v_rel)
   * où v_rel = v_vent − v_objet.
   */
  getDragForce(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    area: number,
    dragCoefficient: number,
    out = new THREE.Vector3(),
  ): THREE.Vector3 {
    this.getWindVelocity(position, _wind);
    _vrel.subVectors(_wind, velocity);
    const speed = _vrel.length();
    return out.copy(_vrel).multiplyScalar(0.5 * AIR_DENSITY * dragCoefficient * area * speed);
  }
}
