// Three.js viewer tuned for a Raspberry Pi 4: render on demand, pixel ratio 1,
// no shadows or post-processing. STL/GLB in millimetres, Z-up (rotated to Y-up).
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { QD330_BUILD_VOLUME_MM as VOL } from "@morphix/shared";
import { useTheme } from "../theme";

export interface ModelSize {
  x: number;
  y: number;
  z: number;
}

interface Props {
  url: string;
  format: "stl" | "glb";
  /** Desired model height in mm; null = native size. */
  targetHeightMm: number | null;
  onMeasured?: (native: ModelSize, scaled: ModelSize) => void;
  onError?: (message: string) => void;
  /** Called once with a PNG data URL after the first render. */
  onThumbnail?: (png: string) => void;
}

export function ModelViewer({ url, format, targetHeightMm, onMeasured, onError, onThumbnail }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dark = useTheme().resolved === "dark";
  const state = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    model: THREE.Object3D | null;
    nativeSize: THREE.Vector3 | null;
    render: () => void;
  } | null>(null);
  const callbacks = useRef({ onMeasured, onError, onThumbnail });
  callbacks.current = { onMeasured, onError, onThumbnail };

  // Scene setup (once)
  useEffect(() => {
    const wrap = wrapRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch (e) {
      callbacks.current.onError?.(`3D view unavailable (WebGL could not start): ${(e as Error).message}`);
      return;
    }
    renderer.setPixelRatio(1);
    wrap.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    camera.position.set(260, 220, 300);

    scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x3a3168 : 0x9a8fc0, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(200, 400, 250);
    scene.add(sun);

    // Build plate and build volume (QD330 as reported by firmware)
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(VOL.x, VOL.y),
      new THREE.MeshBasicMaterial({ color: dark ? 0x2a2350 : 0xece6ff, transparent: true, opacity: 0.95 }),
    );
    plate.rotation.x = -Math.PI / 2;
    scene.add(plate);
    const grid = new THREE.GridHelper(VOL.x, 22, dark ? 0x6a5bb8 : 0xb7a8f0, dark ? 0x3e3478 : 0xd6cdf7);
    grid.position.y = 0.05;
    scene.add(grid);
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(VOL.x, VOL.z, VOL.y)),
      new THREE.LineBasicMaterial({ color: dark ? 0xa08bff : 0x6c4cf0, transparent: true, opacity: dark ? 0.5 : 0.35 }),
    );
    box.position.y = VOL.z / 2;
    scene.add(box);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 40, 0);
    controls.enableDamping = false;
    controls.minDistance = 40;
    controls.maxDistance = 1200;
    controls.maxPolarAngle = Math.PI * 0.95;

    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = wrap;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    state.current = { renderer, scene, camera, controls, model: null, nativeSize: null, render };
    return () => {
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      state.current = null;
    };
  }, []);

  // Load model when the URL changes
  useEffect(() => {
    const s = state.current;
    if (!s) return;
    let cancelled = false;
    const material = new THREE.MeshStandardMaterial({ color: 0x8c6bff, roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide });

    const place = (obj: THREE.Object3D) => {
      if (cancelled) return;
      if (s.model) s.scene.remove(s.model);
      const holder = new THREE.Group();
      holder.add(obj);
      s.scene.add(holder);
      s.model = holder;
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      obj.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
      s.nativeSize = size;
      applyScale();
      frame();
      s.render();
      if (callbacks.current.onThumbnail) {
        // Capture right after rendering, before the drawing buffer is cleared.
        callbacks.current.onThumbnail(s.renderer.domElement.toDataURL("image/png"));
      }
    };

    const fail = (e: unknown) => !cancelled && callbacks.current.onError?.(`Could not load model: ${String((e as Error)?.message ?? e)}`);

    if (format === "stl") {
      new STLLoader().load(
        url,
        (geo) => {
          geo.rotateX(-Math.PI / 2); // Z-up (printer) -> Y-up (three.js)
          geo.computeVertexNormals();
          place(new THREE.Mesh(geo, material));
        },
        undefined,
        fail,
      );
    } else {
      new GLTFLoader().load(
        url,
        (gltf) => {
          // Untextured previews (e.g. Meshy shape-only) get the friendly Morphix colour.
          gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            if (!mats.some((x) => (x as THREE.MeshStandardMaterial).map)) m.material = material;
          });
          place(gltf.scene);
        },
        undefined,
        fail,
      );
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, format]);

  useEffect(() => {
    applyScale();
    state.current?.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetHeightMm]);

  function applyScale() {
    const s = state.current;
    if (!s?.model || !s.nativeSize) return;
    const k = targetHeightMm && s.nativeSize.y > 0 ? targetHeightMm / s.nativeSize.y : 1;
    s.model.scale.setScalar(k);
    const n = s.nativeSize;
    // three.js Y is the printer's Z (height)
    callbacks.current.onMeasured?.({ x: n.x, y: n.z, z: n.y }, { x: n.x * k, y: n.z * k, z: n.y * k });
  }

  function frame() {
    const s = state.current;
    if (!s?.model) return;
    const box = new THREE.Box3().setFromObject(s.model);
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    const dist = Math.max(size * 1.6, 180);
    s.controls.target.copy(center);
    s.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.8);
    s.controls.update();
  }

  return <div ref={wrapRef} className="canvas-wrap" />;
}
