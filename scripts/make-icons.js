/**
 * Render the app icons from icon.svg.
 *
 * Three outputs, because Android and iOS want different things:
 *
 *   icon.png           1024², full bleed. iOS and the legacy Android launcher.
 *   adaptive-icon.png  1024², foreground only, TRANSPARENT, mark inside the safe zone.
 *                      Android masks adaptive icons to a circle/squircle of the OEM's
 *                      choosing and can crop ~33% of the edge, so a full-bleed image
 *                      here loses its outer third. The background is a flat colour set
 *                      in app.config.ts, not baked in.
 *   splash-icon.png    the mark alone, for expo-splash-screen.
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const svgPath = process.argv[2];
const outDir = process.argv[3];
const svg = fs.readFileSync(svgPath);

// Rasterise at high density so the curves stay clean when downscaled to 48dp.
const render = (size) => sharp(svg, { density: 512 }).resize(size, size).png();

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  await render(1024).toFile(path.join(outDir, 'icon.png'));

  // Foreground: 66% of the canvas, centred, on transparency — Android's documented
  // safe zone for adaptive icons.
  const markSize = 676;
  const mark = await render(markSize).toBuffer();
  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: mark, top: (1024 - markSize) / 2, left: (1024 - markSize) / 2 }])
    .png()
    .toFile(path.join(outDir, 'adaptive-icon.png'));

  await render(512).toFile(path.join(outDir, 'splash-icon.png'));

  for (const f of ['icon.png', 'adaptive-icon.png', 'splash-icon.png']) {
    const meta = await sharp(path.join(outDir, f)).metadata();
    console.log(`${f}  ${meta.width}x${meta.height}  ${fs.statSync(path.join(outDir, f)).size} bytes`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
