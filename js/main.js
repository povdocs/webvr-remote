(function () {
	var initialCameraPosition = {
			x: 0,
			y: 1.82,
			z: 0
		},

		PEER_API_KEY = 'af7e49eb-ae1a-45dd-8305-03d5b6c07ca4',
		FOG = 250,
		MOVE_SPEED = 10,
		SLOW_SPEED = MOVE_SPEED * 0.2,
		CHECKERBOARD = 'images/checkerboard.png',

		statusExpire = 0,
		statusObject,

		connection,
		qrCode,

		camera,
		head,
		pointer,

		objects = [],
		pickTargets = [],
		intersection,
		grabbedObject,
		grabQuat = new THREE.Quaternion(),

		offsetAngle = 0,
		pointerLat = 0,
		pointerLon = 0,
		pointerVector = new THREE.Vector3(),
		raycaster = new THREE.Raycaster(),
		worldNormal = new THREE.Vector3(),
		scratchVector = new THREE.Vector3(),
		originPosition = new THREE.Vector3(),
		yAxis = new THREE.Vector3(0, 1, 0),

		moving = false,
		moveX = 0,
		moveZ = 0,

		updateOrientation,
		recenterPointer,
		requestFullScreen,

		clock = new THREE.Clock();

	function topObject(obj) {
		var parent;
		parent = obj.parent;
		while (parent && !(parent instanceof THREE.Scene)) {
			obj = parent;
			parent = obj.parent;
		}
		return obj;
	}

	function updatePosition() {
		var delta,
			x,
			z,
			cos,
			sin,
			speed = SLOW_SPEED,
			length,
			moveLongitude,
			cameraLon,
			vector;

		delta = clock.getDelta();
		if (moving) {

			cos = Math.cos(pointerLon);
			sin = Math.sin(pointerLon);

			z = cos * moveZ - sin * moveX;
			x = sin * moveZ + cos * moveX;

			//normalize for calculating longitude of movement vector
			length = Math.sqrt(x * x + z * z);
			moveLongitude = Math.acos(z / length);
			if (x < 0) {
				moveLongitude *= -1;
			}

			vector = new THREE.Vector3(0, 0, 1);
			vector.applyQuaternion(camera.quaternion);
			vector.normalize();

			cos = Math.cos(Math.asin(vector.y));
			if (cos) {
				cameraLon = Math.acos(vector.z / cos);
				if (vector.x < 0) {
					cameraLon *= -1;
				}

				//slow down if you're not moving in the direction you're looking
				//so you don't puke

				speed = SLOW_SPEED + (MOVE_SPEED - SLOW_SPEED) * Math.pow(1 - Math.abs(moveLongitude - cameraLon) / Math.PI, 2);
			}


			head.position.z += z * delta * speed;
			head.position.x += x * delta * speed;

			updatePointer();
		}
	}

	function stopMoving() {
		updatePosition();
		moving = false;
	}

	function updatePointer() {
		var intersects,
			normalMatrix,
			hover = false;

		originPosition.copy(head.position);
		if (head.parent && !(head.parent instanceof THREE.Scene)) {
			head.localToWorld(originPosition);
		}

		raycaster.set(originPosition, pointerVector);
		intersects = raycaster.intersectObjects(pickTargets, true);

		if (intersects.length > 0) {
			if (!intersection) {
				hover = true;
			}
			intersection = intersects[0];
		} else {
			intersection = null;
		}

		if (intersection) {
			pointer.position.copy(intersection.point);

			if (intersection.face) {
				normalMatrix = new THREE.Matrix3().getNormalMatrix(intersection.object.matrixWorld);
				worldNormal.copy(intersection.face.normal).applyMatrix3(normalMatrix).normalize();

				scratchVector.copy(intersection.point).add(worldNormal);
				pointer.lookAt(scratchVector);
			}
		} else {
			//todo: don't need to use scratchVector here
			scratchVector.copy(pointerVector);
			scratchVector.multiplyScalar(4).add(originPosition);
			pointer.position.copy(scratchVector);
			pointer.lookAt(originPosition);
		}

		if (hover && !grabbedObject &&
				connection && connection.open &&
				objects.indexOf(topObject(intersection.object)) >= 0) {

			connection.send({
				action: 'hover'
			});
		}
	}

	function unGrabObject() {
		if (grabbedObject) {
			grabbedObject.quaternion.set(0, 0, 0, 1);
			grabbedObject.rotateY(Math.PI);
			grabbedObject = null;
			pointer.visible = true;
			updatePointer();
		}
	}

	function grabObject(obj) {
		obj = topObject(obj);

		if (objects.indexOf(obj) < 0) {
			return;
		}

		unGrabObject();

		grabbedObject = obj;
		grabbedObject.rotation.set(0, offsetAngle, 0);
		grabbedObject.quaternion.multiply(grabQuat);
		updatePointer();
		pointer.visible = false;
	}

	function initOrientation() {
		var orientationQuaternion = new THREE.Quaternion(),
			euler = new THREE.Euler(),
			previousOrientation = 0;

		function updateOrientation(data) {
			var alpha,
				beta,
				gamma,
				orient,
				autoAlign;

			alpha = data.gamma ?
			THREE.Math.degToRad(data.alpha) : 0; // Z
			beta = data.beta ?
			THREE.Math.degToRad(data.beta) : 0; // X'
			gamma = data.gamma ?
			THREE.Math.degToRad(data.gamma) : 0; // Y''
			orient = data.orientation ?
			THREE.Math.degToRad(data.orientation) : 0; // O

			orient = 0;

			autoAlign = previousOrientation !== orient;
			previousOrientation = orient;

			// The angles alpha, beta and gamma
			// form a set of intrinsic Tait-Bryan angles of type Z-X'-Y''

			// 'ZXY' for the device, but 'YXZ' for us
			euler.set(beta, alpha, - gamma, 'YXZ');

			orientationQuaternion.setFromEuler(euler);

			pointerVector.set(0, 0, -1).applyQuaternion(orientationQuaternion);
			pointerVector.applyAxisAngle(yAxis, offsetAngle);

			pointerLat = Math.asin(pointerVector.y);
			pointerLon = Math.acos(pointerVector.z / Math.cos(pointerLat));
			if (pointerVector.x < 0) {
				pointerLon *= -1;
			}

			grabQuat.copy(orientationQuaternion);

			if (grabbedObject) {
				grabbedObject.rotation.set(0, offsetAngle, 0);
				grabbedObject.quaternion.multiply(grabQuat);
			} else {
				updatePointer();
			}
		}

		recenterPointer = function () {
			var vector,
				latitude,
				cosLatitude,
				cameraLon,
				previousOffset;

			if (camera) {
				vector = new THREE.Vector3(0, 0, 1);
				vector.applyQuaternion(camera.quaternion);
				vector.normalize();

				latitude = Math.asin(vector.y);
				cosLatitude = Math.cos(latitude);
				if (!cosLatitude) {
					//cannot recenter if camera is looking straight up or straight down
					return;
				}

				cameraLon = Math.acos(vector.z / cosLatitude);
				if (vector.x < 0) {
					cameraLon *= -1;
				}

				previousOffset = offsetAngle;
				offsetAngle = cameraLon - pointerLon + previousOffset;

				pointerVector.applyAxisAngle(yAxis, offsetAngle - previousOffset);

				pointerLat = Math.asin(pointerVector.y);
				pointerLon = Math.acos(pointerVector.z / Math.cos(pointerLat));
				if (pointerVector.x < 0) {
					pointerLon *= -1;
				}

				updatePointer();
				console.log('recentered');
			}
		};

		return updateOrientation;
	}

	function initPhysics() {
		var worker,
			sendTime;
		worker = new Worker('js/worker.js');
	}

	function initScene() {
		var renderer,
			scene,
			vrControls,
			vrButton,
			vrEffect,
			fsButton,

			loader,
			directionalLight,
			floor,

			statsTime = Date.now(),
			prevStatsTime = statsTime,
			fps = 0,
			frames,
			statsTex,
			ctx,
			statsCanvas,

			requestPointerLock,
			exitPointerLock;

		function scanHMD() {
			var hmd,
				timeout = 1000;

			vrEffect.scan();
			vrControls.scan();

			hmd = vrEffect.hmd();

			if (hmd) {
				if (hmd.deviceId !== 'debug-0') {
					timeout = 5000;
				}
				setTimeout(scanHMD, timeout);
			}
		}

		function getBoundingBox(node) {
			var boundingBox,
				position = new THREE.Vector3();

			node.traverse(function (child) {
				var box;

				if (!child.geometry) {
					return;
				}

				if (child.geometry.vertices) {
					box = new THREE.Box3().setFromObject(child);
				} else if (child.geometry.boundingSphere) {
					box = child.geometry.boundingSphere.getBoundingBox();
				}

				if (!box) {
					return;
				}

				position.set(0, 0, 0);
				child.localToWorld(position);
				box.translate(position);

				if (boundingBox) {
					boundingBox.union(box);
				} else {
					boundingBox = box;
				}
			});

			return boundingBox;
		}

		function recenterCompoundObject(object) {
			var boundingBox = getBoundingBox(object),
				center = boundingBox.center();

			object.children.forEach(function (node) {
				node.position.sub(center);
			});
			object.updateMatrixWorld();
		}

		function resize() {
			camera.aspect = window.innerWidth / window.innerHeight;
			camera.updateProjectionMatrix();
			renderer.setSize(window.innerWidth, window.innerHeight);
		}

		function render() {
			var time, diff;
			//todo: render previous stats
			ctx.fillStyle = '#444';
			ctx.fillRect(0, 0, statsCanvas.width, statsCanvas.height);
			ctx.fillStyle = 'white';
			ctx.font = 'Bold 30px Sans-Serif';
			ctx.fillText(fps + 'fps', 10, 50);
			statsTex.needsUpdate = true;
			statsTime = Date.now();

			updatePosition();
			vrControls.update();
			vrEffect.render(scene, camera);
			requestAnimationFrame(render);

			frames++;
			time = Date.now();
			diff = time - prevStatsTime;
			if (diff > 1000) {
				fps = Math.round(frames * 1000 / diff);
				prevStatsTime = time;
				frames = 0;
			}
		}

		if (pointer) {
			return;
		}

		renderer = new THREE.WebGLRenderer();
		renderer.setSize(window.innerWidth, window.innerHeight);
		document.body.appendChild(renderer.domElement);

		scene = new THREE.Scene();

		head = new THREE.Object3D();
		head.rotateY(Math.PI);
		head.position.x = initialCameraPosition.x;
		head.position.y = initialCameraPosition.y;
		head.position.z = initialCameraPosition.z;
		scene.add(head);

		camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, FOG * 2 + 1);
		head.add(camera);

		vrControls = new THREE.VRControls( camera );
		//vrControls.freeze = true;

		requestFullscreen = renderer.domElement.webkitRequestFullscreen ||
			renderer.domElement.mozRequestFullScreen ||
			renderer.domElement.msRequestFullscreen;
		requestFullscreen = requestFullscreen.bind(renderer.domElement);

		requestPointerLock = (renderer.domElement.requestPointerLock ||
			renderer.domElement.mozRequestPointerLock ||
			renderer.domElement.webkitRequestPointerLock).bind(renderer.domElement);
		exitPointerLock = (document.exitPointerLock ||
			document.mozExitPointerLock ||
			document.webkitExitPointerLock).bind(document);

		vrEffect = new THREE.VRStereoEffect(renderer);
		vrEffect.addEventListener('fullscreenchange', function () {
			vrControls.freeze = !(vrControls.mode() || vrEffect.vrPreview());
			if (vrControls.freeze) {
				vrControls.reset();
			}

			if (vrEffect.isFullscreen()) {
				requestPointerLock();
			} else {
				exitPointerLock();
			}
		});

		statsCanvas = document.createElement('canvas');
		statsCanvas.width = 120;
		statsCanvas.height = 80;
		ctx = statsCanvas.getContext('2d');
		statsTex = new THREE.Texture(statsCanvas);
		var statsObj = new THREE.Mesh(
			new THREE.PlaneGeometry(12, 8),
			new THREE.MeshLambertMaterial({
				//color: 0x000099,
				map: statsTex
			})
		);
		statsObj.position.z = 80;
		statsObj.position.y = 30;
		statsObj.rotateY(Math.PI);
		scene.add(statsObj);

		floor = new THREE.Mesh(
			new THREE.CircleGeometry(FOG / 8, 32),
			new THREE.MeshPhongMaterial({
				color: 0x999999,
				specular: 0x111111,
				map: THREE.ImageUtils.loadTexture(CHECKERBOARD),

				shininess: 100,
				shading: THREE.SmoothShading
			})
		);
		floor.name = 'floor';

		floor.material.map.wrapS = THREE.RepeatWrapping;
		floor.material.map.wrapT = THREE.RepeatWrapping;
		floor.material.map.repeat.set(10, 10);
		floor.receiveShadow = true;
		floor.rotateX(-Math.PI / 2);
		scene.add(floor);
		pickTargets.push(floor);

		loader = new THREE.OBJMTLLoader();
		loader.load( 'models/statuehead.obj', 'models/statuehead.mtl', function ( object ) {
			recenterCompoundObject(object);
			object.position.y = initialCameraPosition.y;

			object.position.z = 4;
			object.position.x = 2;
			object.scale.set(0.8, 0.8, 0.8);
			object.rotateY(Math.PI);
			scene.add( object );
			objects.push(object);
			pickTargets.push(object);
		});

		loader.load( 'models/cow.obj', 'models/cow.mtl', function ( object ) {
			recenterCompoundObject(object);
			object.position.y = initialCameraPosition.y;

			object.position.z = 4;
			object.position.x = -2;
			object.scale.set(1.2, 1.2, 1.2);
			object.rotateY(Math.PI);
			scene.add( object );
			objects.push(object);
			pickTargets.push(object);
		});

		loader = new THREE.UTF8Loader();

		loader.load('models/hand.js', function (object) {
			var s = 4,
				removables = [];

			object.traverse(function(node) {

				node.castShadow = true;
				node.receiveShadow = true;

				if (node.material && node.material.name === 'skin') {
					node.material.wrapAround = true;
					node.material.wrapRGB.set( 0.6, 0.2, 0.1 );
				} else if (!node.material || node.material.name !== 'nails') {
					console.log(node.material);
					if (!node.children.length) {
						removables.push(node);
					}
				}

			});

			removables.forEach(function (node) {
				node.parent.remove(node);
			});

			recenterCompoundObject(object);
			object.position.y = initialCameraPosition.y;

			object.scale.set(s, s, s);
			object.position.z = 10;

			scene.add(object);
			objects.push(object);
			pickTargets.push(object);

		}, {
			normalizeRGB: true
		});

		directionalLight = new THREE.DirectionalLight( 0xffffff, 1.475 );
		directionalLight.position.set( 100, 100, -100 );
		scene.add( directionalLight );

		pointer = new THREE.Mesh(
			new THREE.TorusGeometry(0.1, 0.02, 16, 32),
			new THREE.MeshBasicMaterial({
				color: 0xaaaaaa
			})
		);
		scene.add(pointer);

		render();

		fsButton = document.getElementById('fs');
		fsButton.addEventListener('click', requestFullscreen, false);

		vrButton = document.getElementById('vr');
		vrButton.addEventListener('click', function () {
			if (vrControls.mode()) {
				vrEffect.requestFullScreen();
			}
		}, false);

		setTimeout(function () {
			if (vrControls.mode()) {
				vrButton.disabled = false;
				scanHMD();
			} else {
				recenterPointer();
			}
		}, 1);

		window.addEventListener('deviceorientation', function deviceOrientation(event) {
			if (typeof event.gamma === 'number') {
				vrButton.disabled = false;
			}
			window.removeEventListener('deviceorientation', deviceOrientation, false);
		}, false);

		window.addEventListener('keydown', function (evt) {
			console.log('keydown', evt.keyCode);

			if (evt.keyCode === 'Z'.charCodeAt(0)) {
				vrControls.zeroSensor();
			} else if (evt.keyCode === 13) {
				vrEffect.requestFullScreen();
			}
		}, false);

		window.addEventListener('resize', resize, false);
	}

	function initPeer(id) {
		var peer,
			peerId,
			connectionInfo = document.getElementById('connection-info');

		peer = new Peer(id, {
			key: PEER_API_KEY
		});

		peer.on('error', function (err) {
			console.log('peer error', err);

			//clean out qr code and start over
			if (qrCode) {
				qrCode.clear();
			}

			initPeer();
		});

		peer.on('disconnected', function () {
			console.log('peer disconnected');
		});

		peer.on('close', function () {
			console.log('peer closed');
			if (qrCode) {
				qrCode.clear();
			}
		});

		peer.on('open', function (id) {
			var url,
				location = window.location,
				path;

			peerId = id;
			path = location.pathname.split('/');
			path.pop();
			url = location.origin + path.join('/') + '/touch.html#' + peerId;
			document.getElementById('link').setAttribute('href', url);
			connectionInfo.style.display = '';
			window.location.hash = id;

			if (!qrCode) {
				qrCode = new QRCode('qrcode', {
					text: url,
					width: 200,
					height: 200,
					correctLevel: QRCode.CorrectLevel.L
				});
			} else {
				qrCode.makeImage(url);
			}
		});

		peer.on('connection', function (conn) {
			var neverRecentered = true;

			if (connection && connection.open) {
				//todo: bump existing connection if we haven't had any data from it in a while
				console.log('only one connection allowed at a time', conn);
				conn.close();
				return;
			}

			connection = conn;
			console.log('Connection open', conn.peer);

			//hide connection-info
			connectionInfo.style.display = 'none';

			connection.on('data', function (data){
				if (data.action === 'orientation') {
					updateOrientation(data);
					if (neverRecentered) {
						neverRecentered = false;
						recenterPointer();
					}

				} else if (data.action === 'recenter') {
					recenterPointer();

				} else if (data.action === 'ping') {
					console.log('ping');
					connection.send({
						action: 'pong',
						pingId: data.pingId
					});

				} else if (data.action === 'click') {
					console.log('click');
					if (grabbedObject) {
						unGrabObject();
					} else if (intersection) {
						grabObject(intersection.object);
					}

				} else if (data.action === 'move') {
					moving = true;
					moveX = data.x;
					moveZ = data.z;

				} else if (data.action === 'stop') {
					stopMoving();
				}
			});

			connection.on('error', function (err){
				console.log('connection error', err);
				if (peer && peer.open) {
					connectionInfo.style.display = '';
				}
			});

			connection.on('close', function (){
				console.log('connection closed');
				connection = null;
				if (peer && peer.open) {
					connectionInfo.style.display = '';
				}
			});
		});
	}

	function init() {
		var infobutton = document.getElementById('infobutton'),
			info = document.getElementById('info');

		updateOrientation = initOrientation();
		initPeer(window.location.hash.substr(1));
		initScene();

		infobutton.addEventListener('click', function () {
			if (info.className) {
				info.className = '';
			} else {
				info.className = 'open';
			}
		});
	}

	init();

}());
