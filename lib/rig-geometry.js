/**
 * Rig 几何解析：rig.json + parts/manifest.json → 画布尺寸、轴心、落点。
 *
 * 宿主（lib/index.js）、离线渲染器（tools/lib/rig-render.mjs）与网页 canvas
 * 共用这一份几何，三者不会各算一套。网页那边由宿主把这里的结果直接塞进
 * state 载荷，客户端只负责套变换，不重复布局计算。
 *
 * 坐标系：画布坐标，原点在画布左上角，y 向下。
 */

/** 配件名（不含 body）。 */
export const PART_NAMES = ['ahoge', 'earLeft', 'earRight', 'tail'];

/** 前后关系：尾巴与两耳在主体之后，呆毛在主体之前。 */
export const DRAW_ORDER = ['tail', 'earLeft', 'earRight', 'body', 'ahoge'];

/** 绕轴心缩放后的有效包围盒（画布/主体框坐标）。 */
export function effectiveBox(part) {
  return {
    x: part.x + part.pivotX * (1 - part.scale),
    y: part.y + part.pivotY * (1 - part.scale),
    width: part.width * part.scale,
    height: part.height * part.scale,
  };
}

/**
 * 解析绘制顺序。rig.json 可以覆盖默认顺序 —— 遮挡关系是美术决定，不该写死在
 * 代码里。覆盖时必须恰好包含全部部件各一次：少画一个的表现是"某个部件凭空
 * 消失"，很难查，所以宁可在这里报错。
 */
function resolveOrder(rig) {
  const wanted = rig.order;
  if (wanted === undefined) return DRAW_ORDER;
  if (!Array.isArray(wanted)) throw new Error('rig.json 的 order 必须是数组');
  const expected = ['body', ...PART_NAMES];
  if (wanted.length !== expected.length || expected.some((n) => !wanted.includes(n))) {
    throw new Error(`rig.json 的 order 必须恰好含 ${expected.join('/')} 各一次，实际是 ${wanted.join('/')}`);
  }
  return [...wanted];
}

/**
 * @param {object} rig      assets/rig/rig.json 的内容
 * @param {object} manifest assets/rig/parts/manifest.json 的内容
 */
export function resolveRig(rig, manifest) {
  if (!rig || !manifest || !manifest.body) throw new Error('rig.json / manifest.json 不完整');
  const body = manifest.body;
  // 先校验绘制顺序再解析部件：配置写坏时应当立刻报出「顺序不对」，
  // 而不是先撞上别的错、把真正的原因盖掉。
  const order = resolveOrder(rig);
  const parts = {};
  for (const name of PART_NAMES) {
    const meta = manifest.parts && manifest.parts[name];
    if (!meta) throw new Error(`部件清单里缺少 ${name}`);
    const def = rig[name];
    if (!def) throw new Error(`rig.json 里缺少 ${name} 的定义`);
    const scale = def.scale ?? 1;
    const pivotX = def.pivotX * meta.width;
    const pivotY = def.pivotY * meta.height;
    parts[name] = {
      width: meta.width,
      height: meta.height,
      // 部件包围盒左上角在主体框坐标里的位置
      x: def.x * body.width,
      y: def.y * body.height,
      pivotX,
      pivotY,
      scale,
    };
  }

  const boxes = PART_NAMES.map((n) => effectiveBox(parts[n]));
  const minX = Math.min(0, ...boxes.map((b) => b.x));
  const minY = Math.min(0, ...boxes.map((b) => b.y));
  const maxX = Math.max(body.width, ...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(body.height, ...boxes.map((b) => b.y + b.height));
  const canvas = { width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY) };

  for (const name of PART_NAMES) {
    const p = parts[name];
    p.originX = p.x - minX;
    p.originY = p.y - minY;
    // 部件自身的落点矩阵：先在部件局部坐标里绕轴心缩放，再平移到 origin。
    // 两个矩阵必须先合成再用 —— 若按「先平移再缩放」的顺序施加，
    // 会多出一个 (scale-1)·origin 的位移，部件会整块飘走。
    p.place = [p.scale, 0, p.originX + p.pivotX * (1 - p.scale), 0, p.scale, p.originY + p.pivotY * (1 - p.scale)];
    // 轴心在画布坐标里的位置（绕轴心缩放不会移动轴心），供旋转用
    p.pivotCanvasX = p.originX + p.pivotX;
    p.pivotCanvasY = p.originY + p.pivotY;
  }

  return {
    canvas,
    // 主体绕脚下锚点做压扁/拉伸
    anchor: {
      x: rig.bodyAnchorX * body.width - minX,
      y: rig.bodyAnchorY * body.height - minY,
    },
    body: { width: body.width, height: body.height, originX: -minX, originY: -minY },
    parts,
    order,
  };
}

/** 2x3 仿射合成：先施加 n，再施加 m。数组为 [a, b, tx, c, d, ty]。 */
export function mulAffine(m, n) {
  return [
    m[0] * n[0] + m[1] * n[3], m[0] * n[1] + m[1] * n[4], m[0] * n[2] + m[1] * n[5] + m[2],
    m[3] * n[0] + m[4] * n[3], m[3] * n[1] + m[4] * n[4], m[3] * n[2] + m[4] * n[5] + m[5],
  ];
}

/** 施加仿射到点。 */
export function applyAffine(m, x, y) {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

/** 绕固定点旋转的仿射。 */
export function rotationAbout(radians, px, py) {
  const c = Math.cos(radians), s = Math.sin(radians);
  return [c, -s, px - c * px + s * py, s, c, py - s * px - c * py];
}
