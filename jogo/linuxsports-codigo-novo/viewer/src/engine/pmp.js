// Objetos do .pmp (cursos de golfe) -> matriz de mundo do three.js.
//
// O registro guarda três vetores na ordem Z, Y, X (o .scene.json já os traz nomeados em `axes`).
// Calibrado por tools/validate_pmp.py (index/pmp-calibration.json), em 1.361 objetos:
//  - posição no mesmo referencial da malha de colisão (mediana da altura sobre o terreno ≤ 0,9);
//  - nenhum objeto inclinado (axes.y é sempre (0,1,0)), então só o sentido do yaw estava em aberto;
//  - lidos como COLUNAS da rotação, o +Z do tee (tipo 0) aponta para os pinos (tipo 1)
//    em 5 de 6 cursos com yaw não trivial; como linhas, só em 1.
import * as THREE from 'three';

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _s = new THREE.Vector3();

/** Escreve em `out` (Matrix4) a transformação do objeto: translação · rotação(colunas x,y,z) · escala. */
export function pmpMatrix(o, out = new THREE.Matrix4()) {
  _x.fromArray(o.axes.x);
  _y.fromArray(o.axes.y);
  _z.fromArray(o.axes.z);
  return out.makeBasis(_x, _y, _z).scale(_s.fromArray(o.scale)).setPosition(o.position[0], o.position[1], o.position[2]);
}
