// Shapes for the slicer-advisor tests.
import type { Mesh } from "@morphix/slicing";
import { box } from "./phase3-fixtures";

export function merge(...meshes: Mesh[]): Mesh {
  const positions = new Float32Array(meshes.reduce((a, m) => a + m.positions.length, 0));
  const indices = new Uint32Array(meshes.reduce((a, m) => a + m.indices.length, 0));
  let po = 0, io = 0;
  for (const m of meshes) {
    positions.set(m.positions, po);
    indices.set(Array.from(m.indices, (i) => i + po / 3), io);
    po += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

/** Pillar with a wide slab on top: every overhang is above the plate. */
export const tShape = () => merge(box(10, 10, 30, { x: 15, y: 15, z: 0 }), box(40, 40, 5, { x: 0, y: 0, z: 30 }));
/** C-shape: the top slab hangs over the bottom slab (supports would stand on the model). */
export const cShape = () => merge(box(40, 40, 5), box(10, 40, 30, { x: 0, y: 0, z: 5 }), box(40, 40, 5, { x: 0, y: 0, z: 35 }));
