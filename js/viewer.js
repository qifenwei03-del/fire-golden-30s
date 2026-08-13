import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Draco 解碼器放在專案內（models/draco/），不依賴外部 CDN —— 離線／網路被擋也能載入模型。
// 路徑相對於網頁根目錄（頁面在 / 下），DRACOLoader 會去 /models/draco/ 抓。
const DRACO_PATH = './models/draco/';

/** 每個佔位場景的鏡頭預設值 */
const SCENE_VIEWS = {
  flat:  { pos: [14, 15, 18], target: [0, 1, 0], min: 6, max: 90, fog: [26, 62] },
  tower: { pos: [18, 14, 22], target: [0, 3.2, 0], min: 8, max: 110, fog: [30, 76] },
};

/** 讀 css/style.css 的主題變數，讓 3D 場景跟版面同一組配色 */
const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * 可掛載到任意 DOM 容器的 3D 檢視器。
 * mount(el) 會把 canvas 塞進 el 並跟著它的尺寸縮放，
 * 之後其他頁面要用同一顆 renderer 只要再 mount 到別的容器即可。
 */
export class Viewer {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(css('--m-fog', '#031020')), 26, 62);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
    this.camera.position.set(14, 15, 18);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 90;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.45;

    this.modelRoot = new THREE.Group();
    this.scene.add(this.modelRoot);

    this.fires = [];
    this.routes = [];
    this.savedViews = {};        // { flat: {pos,target,autoRotate}, tower: {...} }
    this.customModels = {};      // { tower: Object3D } 外部載入的真實模型，蓋掉同名佔位場景
    this.customViews = {};       // { tower: {pos,target,...} } 依模型尺寸自動框好的視角
    this.swing = { on: false, center: 0, amp: THREE.MathUtils.degToRad(40), t0: 0 };  // 來回擺動
    this._addLights();
    this._addPlaceholder();

    this.clock = new THREE.Clock();
    this._raf = 0;
    this._host = null;
    this._ro = new ResizeObserver(() => this.resize());
  }

  /* ---------- 燈光 ---------- */
  _addLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1.1);
    this.scene.add(this.hemi);

    this.key = new THREE.DirectionalLight(0xffffff, 1.5);
    this.key.position.set(12, 20, 10);
    this.scene.add(this.key);

    this.rim = new THREE.DirectionalLight(0xffffff, 0.9);
    this.rim.position.set(-14, 8, -12);
    this.scene.add(this.rim);

    this._tintLights();
  }

  _tintLights() {
    this.hemi.color.set(css('--m-edge', '#74d4ff'));
    this.hemi.groundColor.set(css('--m-fog', '#031020'));
    this.key.color.set('#ffffff');
    this.rim.color.set(css('--m-grid', '#2f9dff'));
  }

  /* ---------- 預設佔位模型 ----------
     flat  = 單層平面圖（第一頁用）
     tower = 三層疊起來的大樓（首頁用）
     兩組都掛在 modelRoot 底下，用 visible 切換，共用同一顆 renderer。
     ------------------------------------ */
  _addPlaceholder() {
    this.fires = [];
    this.routes = [];
    this.scenes = {
      flat: this._buildFlat(),
      tower: this._buildTower(),
    };
    this.placeholder = new THREE.Group();
    for (const g of Object.values(this.scenes)) this.placeholder.add(g);
    this.modelRoot.add(this.placeholder);
    this.setScene(this.sceneName ?? 'flat');
  }

  /** 切換場景：有載入真實模型就用它（蓋掉同名佔位），視角優先用存過的，其次自動框好的，再其次預設 */
  setScene(name) {
    if (!SCENE_VIEWS[name] && !this.customModels[name]) return;
    this.sceneName = name;
    // 佔位場景：只有在沒有同名真實模型時才顯示
    if (this.scenes) {
      for (const [k, g] of Object.entries(this.scenes)) g.visible = k === name && !this.customModels[k];
    }
    // 外部真實模型：只顯示目前這一頁的
    for (const [k, m] of Object.entries(this.customModels)) m.visible = k === name;
    // 有真實模型就以它自動框好的視角為底，否則用佔位場景預設；存過的視角再蓋上去
    const base = (this.customModels[name] && this.customViews[name]) || SCENE_VIEWS[name] || {};
    this._applyView({ ...base, ...(this.savedViews[name] ?? {}) });
  }

  _applyView(v) {
    if (!v.pos) return;
    this.camera.position.set(...v.pos);
    this.controls.target.set(...v.target);
    this.controls.autoRotate = v.autoRotate ?? true;
    if (v.min != null) this.controls.minDistance = v.min;
    if (v.max != null) this.controls.maxDistance = v.max;
    if (v.near != null) this.camera.near = v.near;
    if (v.far != null) this.camera.far = v.far;
    if (v.near != null || v.far != null) this.camera.updateProjectionMatrix();
    if (v.speed != null) this.controls.autoRotateSpeed = v.speed;
    if (v.swingAmp != null) this.swing.amp = THREE.MathUtils.degToRad(v.swingAmp);
    if (v.swing != null) {
      this.swing.on = v.swing;
      if (v.swing) {
        this.controls.autoRotate = false;
        this.swing.center = new THREE.Spherical()
          .setFromVector3(this.camera.position.clone().sub(this.controls.target)).theta;
        this.swing.t0 = this.clock.getElapsedTime();
      }
    }
    if (v.fog) { this.scene.fog.near = v.fog[0]; this.scene.fog.far = v.fog[1]; }
    this.controls.update();
  }

  /* ---------- 視角（角度 / 遠近 / 自動旋轉），可存檔 ---------- */
  getView() {
    const r = (n) => +n.toFixed(3);
    return {
      pos: this.camera.position.toArray().map(r),
      target: this.controls.target.toArray().map(r),   // target = 自動旋轉的軸心
      autoRotate: this.controls.autoRotate,
      speed: +this.controls.autoRotateSpeed.toFixed(3),
      swing: this.swing.on,
      swingAmp: +THREE.MathUtils.radToDeg(this.swing.amp).toFixed(1),
    };
  }

  /** 把目前畫面上的視角記成這個場景的固定視角 */
  saveView(name = this.sceneName) {
    this.savedViews[name] = this.getView();
    return this.savedViews[name];
  }

  getSavedView(name = this.sceneName) { return this.savedViews[name] ?? null; }

  applyView(name, v) {
    if (!Array.isArray(v?.pos) || !Array.isArray(v?.target)) return false;
    this.savedViews[name] = {
      pos: v.pos, target: v.target, autoRotate: !!v.autoRotate, speed: v.speed,
      swing: !!v.swing, swingAmp: v.swingAmp,
    };
    if (this.sceneName === name) this.setScene(name);
    return true;
  }

  /** 丟掉存下來的視角，回到該場景的預設 */
  clearView(name = this.sceneName) {
    delete this.savedViews[name];
    if (this.sceneName === name) this.setScene(name);
  }

  setAutoRotate(on) { this.controls.autoRotate = !!on; if (on) this.swing.on = false; }  // 兩種轉法互斥
  /** 自動旋轉速度（可正可負，負值反向）；擺動模式也用這支當快慢 */
  setAutoRotateSpeed(s) { this.controls.autoRotateSpeed = s; }

  /** 來回擺動：在目前角度 ± 擺幅之間來回，不轉整圈 */
  setSwing(on) {
    this.swing.on = !!on;
    if (on) {
      this.controls.autoRotate = false;
      this.swing.center = new THREE.Spherical()
        .setFromVector3(this.camera.position.clone().sub(this.controls.target)).theta;
      this.swing.t0 = this.clock.getElapsedTime();
    }
  }
  /** 擺動幅度（左右各幾度） */
  setSwingAmp(deg) { this.swing.amp = THREE.MathUtils.degToRad(Math.max(0, deg)); }

  /** 互動模式：
     'orbit'  編輯用 —— 左鍵轉角度、右鍵平移、滾輪縮放（右鍵平移同時移動旋轉軸心）
     'pivot'  只平移 —— 左鍵拖曳平移（觸控／不方便按右鍵時用）
     'kiosk'  展示用 —— 只能轉、不能平移，避免現場把模型拖走 */
  setInteractionMode(mode) {
    const c = this.controls;
    if (mode === 'pivot') {
      c.enableRotate = false; c.enablePan = true;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    } else if (mode === 'kiosk') {
      c.enableRotate = true; c.enablePan = false;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      c.enableRotate = true; c.enablePan = true;   // 右鍵平移
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    }
  }

  /** 顯示／隱藏「旋轉軸心」的視覺輔助線（一條通過 target 的垂直軸） */
  showPivot(on) {
    if (!this._pivotHelper) {
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(css('--amber', '#ffb42e')),
        transparent: true, opacity: 0.9, depthTest: false,
      });
      const geo = new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(0, -1000, 0), new THREE.Vector3(0, 1000, 0)]
      );
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 999;
      this._pivotHelper = line;
      this.scene.add(line);
    }
    this._pivotHelper.visible = !!on;
  }

  /** 使用者拖／縮放結束時通知一次（自動旋轉不會觸發） */
  onViewEnd(cb) { this.controls.addEventListener('end', cb); }

  /* ---------- 單層平面圖 ---------- */
  _buildFlat() {
    const g = new THREE.Group();

    // 地板
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(20.4, 0.3, 12.4),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(css('--m-floor', '#0a1c30')),
        roughness: 0.95,
        metalness: 0,
      })
    );
    floor.position.y = -0.15;
    g.add(floor);

    const grid = new THREE.GridHelper(
      20, 20,
      new THREE.Color(css('--m-grid', '#2f9dff')),
      new THREE.Color(css('--m-grid-2', '#1c4a6b'))
    );
    grid.material.transparent = true;
    grid.material.opacity = 0.16;
    grid.position.y = 0.012;
    g.add(grid);

    // 牆體（線段定義：x1,z1,x2,z2）
    const segs = [
      [-10, -6, 10, -6], [10, -6, 10, 6], [10, 6, -10, 6], [-10, 6, -10, -6],
      [-2, -6, -2, 1], [-2, 1, 4, 1], [4, 1, 4, 6], [-10, 1, -6, 1], [4, -6, 4, -2],
    ];
    const wallMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(css('--m-wall', '#123049')),
      roughness: 0.8,
      metalness: 0.05,
    });
    const edgeMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(css('--m-edge', '#74d4ff')),
      transparent: true,
      opacity: 0.55,
    });
    const H = 1.7, T = 0.28;

    for (const [x1, z1, x2, z2] of segs) {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const geo = new THREE.BoxGeometry(len, H, T);
      const wall = new THREE.Mesh(geo, wallMat);
      wall.position.set((x1 + x2) / 2, H / 2, (z1 + z2) / 2);
      wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      g.add(wall);
      wall.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
    }

    g.add(this._makeFire(-6, 0.6, -3));

    // 逃生出口（沿用國際通用的綠色，不隨主題變動）
    const exitColor = new THREE.Color(css('--exit', '#3dffa0'));
    const exit = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 1.0, 1.7),
      new THREE.MeshBasicMaterial({ color: exitColor })
    );
    exit.position.set(10, 0.9, 3.6);
    g.add(exit);
    const exitLight = new THREE.PointLight(exitColor, 14, 12, 2);
    exitLight.position.set(9.2, 1.4, 3.6);
    g.add(exitLight);

    g.add(this._makeRoute([
      [-6, 0.12, -3], [-6, 0.12, 3.6], [9.4, 0.12, 3.6],
    ]));
    return g;
  }

  /* ---------- 三層疊起來的大樓 ---------- */
  _buildTower() {
    const g = new THREE.Group();
    const FLOORS = 3;
    const FH = 2.95;                 // 樓層間距（牆高 2.3，留一點縫看得到分層）
    const W = 15, D = 9.5;           // 樓板尺寸

    // 樓板：偏藍的白，帶一點自發光才不會在陰影裡變灰
    const slabColor = new THREE.Color(css('--m-slab', '#e4efff'));
    const slabMat = new THREE.MeshStandardMaterial({
      color: slabColor,
      emissive: slabColor,
      emissiveIntensity: 0.16,
      roughness: 0.9, metalness: 0,
      transparent: true, opacity: 0.62,
    });
    const wallMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(css('--m-wall', '#123049')),
      roughness: 0.8, metalness: 0.05, transparent: true, opacity: 0.5,
    });
    const edgeMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(css('--m-edge', '#74d4ff')),
      transparent: true, opacity: 0.6,
    });

    // 每層的隔間（線段：x1,z1,x2,z2）
    const plan = [
      [-W / 2, -D / 2, W / 2, -D / 2], [W / 2, -D / 2, W / 2, D / 2],
      [W / 2, D / 2, -W / 2, D / 2], [-W / 2, D / 2, -W / 2, -D / 2],
      [-2.5, -D / 2, -2.5, 0.5], [-2.5, 0.5, 3.5, 0.5], [3.5, 0.5, 3.5, D / 2],
    ];
    const H = 2.3, T = 0.2;

    for (let f = 0; f < FLOORS; f++) {
      const fl = new THREE.Group();
      fl.position.y = f * FH;
      g.add(fl);

      const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, 0.22, D + 0.4), slabMat);
      slab.position.y = -0.11;
      fl.add(slab);
      fl.add(new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), edgeMat).translateY(-0.11));

      for (const [x1, z1, x2, z2] of plan) {
        const len = Math.hypot(x2 - x1, z2 - z1);
        const geo = new THREE.BoxGeometry(len, H, T);
        const wall = new THREE.Mesh(geo, wallMat);
        wall.position.set((x1 + x2) / 2, H / 2, (z1 + z2) / 2);
        wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
        fl.add(wall);
        wall.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
      }
    }

    // 起火點在頂樓
    g.add(this._makeFire(-5, (FLOORS - 1) * FH + 0.6, -2.6));

    // 一樓出口
    const exitColor = new THREE.Color(css('--exit', '#3dffa0'));
    const exit = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 1.0, 1.6),
      new THREE.MeshBasicMaterial({ color: exitColor })
    );
    exit.position.set(W / 2, 0.85, 3);
    g.add(exit);
    const exitLight = new THREE.PointLight(exitColor, 16, 14, 2);
    exitLight.position.set(W / 2 - 0.8, 1.3, 3);
    g.add(exitLight);

    // 逃生動線：頂樓 → 樓梯間垂直往下 → 一樓出口
    const SX = 5.6, SZ = -2.6;                    // 樓梯間位置
    const top = (FLOORS - 1) * FH + 0.14;
    g.add(this._makeRoute([
      [-5, top, -2.6], [SX, top, SZ],
      [SX, FH + 0.14, SZ], [SX, 0.14, SZ],
      [SX, 0.14, 3], [W / 2 - 0.4, 0.14, 3],
    ]));
    return g;
  }

  /* ---------- 共用零件 ---------- */
  _makeFire(x, y, z) {
    const fire = new THREE.Group();
    fire.position.set(x, y, z);
    fire.add(new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0xff5a3d })
    ));
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0xff3b2a, transparent: true, opacity: 0.18, depthWrite: false })
    );
    fire.add(halo);
    const light = new THREE.PointLight(0xff5530, 26, 16, 2);
    fire.add(light);
    this.fires.push({ halo, light });
    return fire;
  }

  _makeRoute(points) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p))),
      new THREE.LineDashedMaterial({
        color: new THREE.Color(css('--exit', '#3dffa0')),
        dashSize: 0.7, gapSize: 0.45, transparent: true, opacity: 0.9,
      })
    );
    line.computeLineDistances();
    this.routes.push(line);
    return line;
  }

  /* ---------- 首頁：把真實建築模型改成「透視感牆面 + 白色樓板 + 逃生動線」 ----------
     模型在離線步驟已把材質收斂成兩種（名稱 'wall' / 'slab'），這裡照第一頁佔位場景那套
     配色重新上材質（讀 CSS 主題變數，所以藍／綠主題一樣會跟著變）。 */
  loadHomeModel(url, onProgress) {
    return new Promise((resolve, reject) => {
      this._loader().load(
        url,
        (gltf) => {
          const prev = this.customModels.tower;
          if (prev) { this.modelRoot.remove(prev); disposeTree(prev); }
          const obj = gltf.scene;
          this._blueprintMats = this._makeBlueprintMats();
          this._styleBlueprint(obj);                 // 換材質 + 加結構邊線（透視感）
          obj.add(this._buildHomeRoute());           // 逃生動線掛在模型底下，一起框、一起顯示
          this.customModels.tower = obj;
          this.modelRoot.add(obj);
          this.customViews.tower = this._frameView(obj);
          this.setScene(this.sceneName);
          resolve(gltf);
        },
        (e) => onProgress?.(e.total ? (e.loaded / e.total) * 100 : 0),
        reject
      );
    });
  }

  _makeBlueprintMats() {
    // 牆板：半透明玻璃面（保留牆板、可看穿內部）+ 上面再加框線 —— 玻璃屋剖面的透視感
    const wall = new THREE.MeshStandardMaterial({
      color: new THREE.Color(css('--m-wall', '#123049')),
      roughness: 0.85, metalness: 0.0,
      transparent: true, opacity: 0.28, depthWrite: false,   // 不寫深度，前後玻璃才會層層疊透
      side: THREE.DoubleSide,   // 兩面都畫，轉到牆背面玻璃也在
    });
    const slab = new THREE.MeshStandardMaterial({
      color: new THREE.Color(css('--m-slab', '#e4efff')),
      emissive: new THREE.Color(css('--m-slab', '#e4efff')), emissiveIntensity: 0.35,
      roughness: 0.9, metalness: 0,
      side: THREE.DoubleSide,   // 實心白樓板（不透明），任何角度都是穩定的實面
    });
    // 框線不寫深度：不然近側框線會把後面牆板的玻璃遮掉，整棟就變成只剩線框
    const edge = new THREE.LineBasicMaterial({
      color: new THREE.Color(css('--m-edge', '#74d4ff')), transparent: true, opacity: 0.5,
      depthWrite: false,
    });
    return { wall, slab, edge };
  }

  _styleBlueprint(obj) {
    const { wall, slab, edge } = this._blueprintMats;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const nm = o.material?.name;
      if (nm === 'wall-cut') { o.visible = false; return; }   // 剖面：挖掉靠近視角的兩面外牆
      const isSlab = nm === 'slab';
      o.material = isSlab ? slab : wall;
      // 樓板整圈邊線（1°）；牆板玻璃面 + 結構框線（30°）
      o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, isSlab ? 1 : 30), edge));
    });
  }

  _tintBlueprint() {
    const { wall, slab, edge } = this._blueprintMats;
    wall.color.set(css('--m-wall', '#123049'));
    slab.color.set(css('--m-slab', '#e4efff'));
    slab.emissive.set(css('--m-slab', '#e4efff'));
    edge.color.set(css('--m-edge', '#74d4ff'));
  }

  /* 逃生動線：頂樓起火點 → 樓梯間垂直往下 → 一樓安全出口。座標是照模型實測的樓層高度與樓梯位置抓的。 */
  _buildHomeRoute() {
    const g = new THREE.Group();
    const FY = [34.82, 38.22, 41.63];        // 三層樓板高度（實測）
    const SX = -12.4, SZ = -20.2;            // 樓梯間中心（實測）
    const top = FY[2] + 0.2;

    g.add(this._makeFire(-4, FY[2] + 0.6, -32));   // 起火點在頂樓遠端

    g.add(this._makeRoute([
      [-4, top, -32], [SX, top, SZ],               // 頂樓 → 樓梯間
      [SX, FY[1] + 0.2, SZ], [SX, FY[0] + 0.2, SZ], // 沿樓梯往下到一樓
      [SX, FY[0] + 0.2, -8], [-6, FY[0] + 0.2, 0.6], // 一樓 → 安全出口
    ]));

    const exitColor = new THREE.Color(css('--exit', '#3dffa0'));
    const exit = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 1.0, 1.6),
      new THREE.MeshBasicMaterial({ color: exitColor })
    );
    exit.position.set(-6, FY[0] + 0.7, 0.9);
    g.add(exit);
    const exitLight = new THREE.PointLight(exitColor, 16, 14, 2);
    exitLight.position.set(-6, FY[0] + 1.1, 0.6);
    g.add(exitLight);
    return g;
  }

  /** 主題（<html data-theme>）換掉之後重新套用場景配色 */
  applyTheme() {
    this.scene.fog.color.set(css('--m-fog', '#031020'));
    this._tintLights();
    if (this._blueprintMats) this._tintBlueprint();   // 首頁真實模型也跟著換色
    if (!this.placeholder) return;          // 已載入外部模型就不動它
    this.modelRoot.remove(this.placeholder);
    disposeTree(this.placeholder);
    this.placeholder = null;
    this.scenes = null;
    this._addPlaceholder();                 // 材質顏色在建立時就從 CSS 讀，重建即完成換色
  }

  /* ---------- 掛載 / 卸載 ---------- */
  mount(el) {
    if (this._host === el) return;
    this.unmount();
    this._host = el;
    el.appendChild(this.renderer.domElement);
    this._ro.observe(el);
    this.resize();
    this.start();
  }

  unmount() {
    this.stop();
    if (this._host) {
      this._ro.unobserve(this._host);
      if (this.renderer.domElement.parentNode === this._host) {
        this._host.removeChild(this.renderer.domElement);
      }
      this._host = null;
    }
  }

  resize() {
    if (!this._host) return;
    const { clientWidth: w, clientHeight: h } = this._host;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  start() {
    if (this._raf) return;
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      const t = this.clock.getElapsedTime();
      const p = 0.75 + Math.sin(t * 4.2) * 0.25;
      for (const f of this.fires ?? []) {
        f.halo.scale.setScalar(p);
        f.halo.material.opacity = 0.1 + p * 0.12;
        f.light.intensity = 18 + p * 14;
      }
      for (const r of this.routes ?? []) r.material.dashOffset = -t * 1.6;
      if (this.swing.on) {
        // 在 center ± amp 之間用正弦來回擺動；快慢沿用自動旋轉速度那支
        const off = this.camera.position.clone().sub(this.controls.target);
        const sph = new THREE.Spherical().setFromVector3(off);
        const w = Math.abs(this.controls.autoRotateSpeed) * 0.9;
        sph.theta = this.swing.center + this.swing.amp * Math.sin((t - this.swing.t0) * w);
        this.camera.position.copy(this.controls.target).add(off.setFromSpherical(sph));
      }
      if (this._pivotHelper?.visible) {
        const tg = this.controls.target;
        this._pivotHelper.position.set(tg.x, 0, tg.z);   // 軸心輔助線跟著 target 走
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  /* ---------- 載入外部模型 ---------- */
  _loader() {
    if (this._gltf) return this._gltf;
    const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
    this._gltf = new GLTFLoader().setDRACOLoader(draco);
    return this._gltf;
  }

  /**
   * @param {string} url  .glb / .gltf 網址或 blob URL
   * @param {(pct:number)=>void} [onProgress]
   */
  loadModel(url, onProgress) {
    return new Promise((resolve, reject) => {
      this._loader().load(
        url,
        (gltf) => {
          this.clearModel();
          this.modelRoot.add(gltf.scene);
          this.frameObject(gltf.scene);
          resolve(gltf);
        },
        (e) => onProgress?.(e.total ? (e.loaded / e.total) * 100 : 0),
        reject
      );
    });
  }

  clearModel() {
    if (this.placeholder) {
      this.modelRoot.remove(this.placeholder);
      disposeTree(this.placeholder);
      this.placeholder = null;
      this.scenes = null;
      this.fires = [];
      this.routes = [];
    }
    for (const child of [...this.modelRoot.children]) {
      this.modelRoot.remove(child);
      disposeTree(child);
    }
  }

  /** 依模型尺寸算出一組「框好」的視角描述（不直接動相機，給 setScene 當底用） */
  _frameView(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.5;
    const pos = center.clone().add(new THREE.Vector3(0.62, 0.66, 0.82).normalize().multiplyScalar(dist));
    return {
      pos: pos.toArray(),
      target: center.toArray(),
      min: dist * 0.15, max: dist * 5,
      near: dist / 100, far: dist * 12,
      fog: [dist * 0.9, dist * 3.4],
      speed: 0.45, swing: false, swingAmp: 40,
    };
  }

  /** 依模型尺寸自動調整相機距離（整份取代場景時用） */
  frameObject(obj) {
    const v = this._frameView(obj);
    if (v) this._applyView(v);
  }
}

function disposeTree(root) {
  root.traverse?.((o) => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
    else m?.dispose?.();
  });
}
