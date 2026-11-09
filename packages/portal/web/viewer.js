// 3D preview: drag to spin, pinch/scroll to zoom. Loaded only on the "My things" detail screen.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export async function showModel(container, url, format) {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x332b44 : 0xd8ccff, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 2.5;
  controls.addEventListener("start", () => (controls.autoRotate = false));

  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error("Could not load the model");
  const data = await res.arrayBuffer();
  let object;
  if (format === "glb") {
    const gltf = await new GLTFLoader().parseAsync(data, "");
    object = gltf.scene;
  } else {
    const geometry = new STLLoader().parse(data);
    geometry.computeVertexNormals();
    geometry.rotateX(-Math.PI / 2); // STL is Z-up, three.js is Y-up
    object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x9d7bff, roughness: 0.55, metalness: 0.05 }));
  }
  scene.add(object);

  // Centre and frame the model.
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);
  const radius = Math.max(size.x, size.y, size.z) || 1;
  camera.position.set(radius * 1.2, radius * 0.9, radius * 1.6);
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.minDistance = radius * 0.5;
  controls.maxDistance = radius * 6;

  let running = true;
  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h || 1;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  const loop = () => {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();

  return {
    size: { x: size.x, y: size.y, z: size.z },
    dispose() {
      running = false;
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
