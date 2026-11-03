'use strict';

// Rotation- and winding-independent signature for native no-go polygons.
// Coordinates must already use the same map scale. No map writes occur here.
function canonicalNativePolygon(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3 ||
      !vertices.every(point => Array.isArray(point) && point.length >= 2 &&
        Number.isFinite(point[0]) && Number.isFinite(point[1]))) return null;
  const variants = [];
  const n = vertices.length;
  for (const reverse of [false, true]) {
    for (let shift = 0; shift < n; shift++) {
      variants.push(Array.from({length:n}, (_,i) => {
        const j = reverse ? (shift - i + n * 2) % n : (shift + i) % n;
        return vertices[j][0] + ',' + vertices[j][1];
      }).join('|'));
    }
  }
  return variants.sort()[0];
}
module.exports = { canonicalNativePolygon };
