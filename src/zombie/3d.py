# Draft of 3D utilities
import panel as pn

pn.config.static_dirs = {"mesh": "./mesh"}

# Three.js HTML and JavaScript code
three_js_code = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Three.js OBJ Loader</title>
    <style>
        body { margin: 0; }
        canvas { display: block; }
    </style>
</head>
<body>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script src="https://cdn.rawgit.com/mrdoob/three.js/r128/examples/js/loaders/OBJLoader.js"></script>
    <script>
        let scene, camera, renderer;
        let objects = [];

        function init() {
            // Set up the scene
            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
            camera.position.z = 5;

            // Set up the renderer
            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setSize(window.innerWidth, window.innerHeight);
            document.body.appendChild(renderer.domElement);

            // Load the OBJ file
            const loader = new THREE.OBJLoader();
            loader.load('/static/your_model.obj', function (object) {
                object.traverse(function (child) {
                    if (child instanceof THREE.Mesh) {
                        child.material.transparent = true;
                        child.material.opacity = 0.5; // Start as transparent
                    }
                });

                scene.add(object);
                objects.push(object);
            });

            // Add click event listener
            window.addEventListener('click', onClick, false);

            animate();
        }

        function onClick(event) {
            // Calculate mouse position in normalized device coordinates
            const mouse = new THREE.Vector2(
                (event.clientX / window.innerWidth) * 2 - 1,
                -(event.clientY / window.innerHeight) * 2 + 1
            );

            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(mouse, camera);

            const intersects = raycaster.intersectObjects(objects, true);

            if (intersects.length > 0) {
                const mesh = intersects[0].object;
                mesh.material.opacity = (mesh.material.opacity === 0.5) ? 1 : 0.5;
            }
        }

        function animate() {
            requestAnimationFrame(animate);
            renderer.render(scene, camera);
        }

        init();
    </script>
</body>
</html>
"""

# Create the Panel app
three_js_pane = pn.pane.HTML(
    three_js_code, height=600, width=800, sizing_mode="stretch_both"
)

# Serve the Panel app
pn.Column("## 3D Visualization with Three.js", three_js_pane).servable()
