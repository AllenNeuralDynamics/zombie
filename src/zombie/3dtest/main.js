import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set(0,0,12);

const renderer = new THREE.WebGLRenderer();
renderer.setSize( window.innerWidth, window.innerHeight );
document.body.appendChild( renderer.domElement );

const loader = new OBJLoader();

const material = new THREE.MeshBasicMaterial({
    color: 0xFF0000,    // red (can also use a CSS color string here)
    flatShading: true,
    transparent: true,
    opacity: 0.5,
    blending: THREE.NormalBlending,
    depthWrite: false,
    depthTest: true,
});

var pivot = new THREE.Object3D();
pivot.position.set(0,0,0);
scene.add(pivot);

var areas = [184, 500, 453, 1057, 677, 247, 669, 31, 972, 44, 714, 95, 254, 22, 541, 922, 698, 895, 1089, 703, 623, 343, 512]
areas.forEach(loadObject);
var loaded = 0;

function loadObject(area) {
    console.log(`Loading area: ${area}`);
    loader.load(
      // Path to the .obj file
      `files/meshes/${area}.obj`,
    
      // Called when the resource is loaded
      function (object) {
        object.traverse(function (child) {
          if (child.isMesh) {
            child.material = material;
          }
        });
    
        object.position.sub(new THREE.Vector3(6.6, 4, 5.7));
    
        // object.rotation.x = 0;
    
        object.scale.set(0.001, 0.001, 0.001);     // Adjust as needed
    
        pivot.attach(object);

        loaded++;

        if (loaded == areas.length) {
            pivot.rotation.set(-3*Math.PI/4,-Math.PI/4,0);
        }
    
        render();
      },
    
      // Called while loading is progressing
      function (xhr) {
        // console.log((xhr.loaded / xhr.total * 100) + '% loaded');
      },
    
      // Called when loading has errors
      function (error) {
        console.error('An error happened', error);
      }
    );
}





const controls = new  OrbitControls( camera, renderer.domElement );
controls.minDistance = 6;
controls.maxDistance = 15;

controls.minPolarAngle = -Math.PI/2;
controls.maxPolarAngle = Math.PI;

controls.minAzimuthAngle = -Math.PI / 2;
controls.maxAzimuthAngle = Math.PI / 2;

controls.addEventListener( 'change', render );



window.addEventListener( 'resize', onWindowResize );

function onWindowResize() {

    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    renderer.setSize( window.innerWidth, window.innerHeight );
    render();
}


function render() {

    renderer.render( scene, camera );

}