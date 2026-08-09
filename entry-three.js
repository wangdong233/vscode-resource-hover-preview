// entry-three.js —— esbuild bundle 入口（构建时打成单 IIFE，暴露 globalThis.MP_THREE）。
// 详见 doc/08 §5 3D。three.js r185 无 UMD，各 Loader 是独立 ESM + 裸 import 'three'，
// blob 加载无法解析裸 import → 必须 esbuild bundle 成单文件。
// 0.4.3：加 STLLoader/OBJLoader/FBXLoader（glb/gltf/stl/obj/fbx 五格式分发，API 各异）。
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

globalThis.MP_THREE = Object.assign({}, THREE, { OrbitControls, GLTFLoader, STLLoader, OBJLoader, FBXLoader });
