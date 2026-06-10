import * as THREE from 'three';
import type { VortexParams } from '../physics/VortexField';
import { VortexField } from '../physics/VortexField';
import {
  TORNADO_VERTEX_SHADER,
  TORNADO_FRAGMENT_SHADER,
  DUST_VERTEX_SHADER,
  DUST_FRAGMENT_SHADER,
} from './tornadoShaders';

/**
 * Assemblage visuel de la tornade :
 *  - cône-maillage déformé sur GPU (paroi de condensation) ;
 *  - nuage de points analytiques (debris ball + bandes de condensation).
 * Le groupe est repositionné chaque frame sur le pied du vortex physique :
 * visuel et champ de force restent rigoureusement alignés.
 */
export class Tornado {
  readonly group = new THREE.Group();

  private readonly coneMaterial: THREE.ShaderMaterial;
  private readonly dustMaterial: THREE.ShaderMaterial;
  private time = 0;

  constructor(params: VortexParams, dustCount = 3500) {
    // ── Cône : cylindre unité ouvert, profil recalculé en vertex shader ───
    const coneGeometry = new THREE.CylinderGeometry(1, 1, params.height, 128, 96, true);
    coneGeometry.translate(0, params.height / 2, 0);

    this.coneMaterial = new THREE.ShaderMaterial({
      vertexShader: TORNADO_VERTEX_SHADER,
      fragmentShader: TORNADO_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uHeight: { value: params.height },
        uBottomRadius: { value: params.coreRadius * 0.4 },
        uTopRadius: { value: params.coreRadius * 3.3 },
        uProfileExponent: { value: 2.4 },
        uNoiseAmplitude: { value: 0.16 },
        uNoiseFrequency: { value: 1.7 },
        uRotationSpeed: { value: params.omega * 0.65 },
        uBendAmplitude: { value: params.coreRadius * 0.9 },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1.0, 0.88, 0.7) },
        uAmbientSky: { value: new THREE.Color(0.45, 0.52, 0.44) },
        uDustColor: { value: new THREE.Color(0.42, 0.38, 0.33) },
        uOpacity: { value: 0.93 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const cone = new THREE.Mesh(coneGeometry, this.coneMaterial);
    cone.frustumCulled = false; // la déformation GPU sort de la bounding sphere CPU
    cone.renderOrder = 2;
    this.group.add(cone);

    // ── Particules : positions calculées en closed-form sur GPU ───────────
    const dustGeometry = new THREE.BufferGeometry();
    const seeds = new Float32Array(dustCount);
    const positions = new Float32Array(dustCount * 3); // requis par THREE, inutilisé par le shader
    for (let i = 0; i < dustCount; i++) seeds[i] = i;
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    dustGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    this.dustMaterial = new THREE.ShaderMaterial({
      vertexShader: DUST_VERTEX_SHADER,
      fragmentShader: DUST_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uOmega: { value: params.omega },
        uCoreRadius: { value: params.coreRadius },
        uHeight: { value: params.height },
        uBottomRadius: { value: params.coreRadius * 0.4 },
        uTopRadius: { value: params.coreRadius * 3.3 },
        uProfileExponent: { value: 2.4 },
        uPointSize: { value: 24 },
        uDustColor: { value: new THREE.Color(0.38, 0.32, 0.25) },
        uCondensationColor: { value: new THREE.Color(0.55, 0.56, 0.52) },
      },
      transparent: true,
      depthWrite: false,
    });

    const dust = new THREE.Points(dustGeometry, this.dustMaterial);
    dust.frustumCulled = false;
    dust.renderOrder = 3;
    this.group.add(dust);
  }

  update(dt: number, vortex: VortexField, sunDirection: THREE.Vector3) {
    this.time += dt;
    this.coneMaterial.uniforms.uTime.value = this.time;
    this.dustMaterial.uniforms.uTime.value = this.time;
    (this.coneMaterial.uniforms.uSunDirection.value as THREE.Vector3).copy(sunDirection);
    this.group.position.set(vortex.center.x, 0, vortex.center.y);
  }
}
