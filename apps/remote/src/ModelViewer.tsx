import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { authedBlob } from "./api";

export function ModelViewer({ versionId, format }: { versionId: string; format: "stl" | "glb" }) {
  const host = useRef<HTMLDivElement>(null); const [error, setError] = useState("");
  useEffect(() => { if (!host.current) return; let disposed = false, url = ""; const el = host.current;
    const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(42, 1, .01, 5000); camera.position.set(2, 1.4, 2.5);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; el.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.autoRotate = true; controls.autoRotateSpeed = 1.2;
    scene.add(new THREE.HemisphereLight(0xdff8ff, 0x1c2240, 2.2)); const key = new THREE.DirectionalLight(0x7ce7ff, 3); key.position.set(3, 5, 4); scene.add(key);
    const grid = new THREE.GridHelper(4, 20, 0x334155, 0x182033); scene.add(grid);
    const fit = (obj: THREE.Object3D) => { scene.add(obj); const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3()), max = Math.max(size.x,size.y,size.z) || 1; obj.position.sub(center); obj.position.y += size.y/2; camera.position.set(max*1.7,max*1.15,max*1.9); camera.near=max/100; camera.far=max*100; camera.updateProjectionMatrix(); controls.target.set(0,size.y/2,0); };
    authedBlob(`/api/models/${versionId}`).then(async(blob) => { if (disposed) return; url=URL.createObjectURL(blob); if(format==="stl") { const g=new STLLoader().parse(await blob.arrayBuffer()); g.computeVertexNormals(); fit(new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0x72e5ff,roughness:.38,metalness:.1}))); } else new GLTFLoader().load(url,(g)=>fit(g.scene),undefined,(e)=>setError(String(e))); }).catch(e=>setError(e.message));
    const resize=()=>{const w=el.clientWidth,h=el.clientHeight; renderer.setSize(w,h,false); camera.aspect=w/Math.max(h,1); camera.updateProjectionMatrix();}; new ResizeObserver(resize).observe(el); resize(); let raf=0; const draw=()=>{controls.update();renderer.render(scene,camera);raf=requestAnimationFrame(draw)};draw();
    return()=>{disposed=true;cancelAnimationFrame(raf);controls.dispose();renderer.dispose();renderer.domElement.remove();if(url)URL.revokeObjectURL(url)};
  },[versionId,format]);
  return <div className="model-view" ref={host}>{error&&<div className="empty">{error}</div>}<span className="orbit-hint">Drag to rotate · Pinch to zoom</span></div>;
}
