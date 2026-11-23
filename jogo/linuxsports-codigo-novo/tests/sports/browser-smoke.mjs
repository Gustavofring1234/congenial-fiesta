// Teste de fumaça no navegador (WebGL 2 de verdade): abre minigames/sports/demo/ no Chromium headless e confere que
// a cena, a colisão, o CHR0, as partículas e o layout 2D funcionam e que os shaders (TEV e partículas) compilam.
//
// Precisa do playwright-core e de um Chromium (o mesmo setup dos testes de navegador do WEBC):
//   PLAYWRIGHT_CORE=/caminho/node_modules/playwright-core [CHROMIUM_PATH=/caminho/chrome] node tests/sports/browser-smoke.mjs [saida.png]
// O servidor estático sobe na pasta que contém jogo/ e LNUX-APPs/ (a demo usa o vendor do WEBC por caminho relativo).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '../..');
const SERVE = path.resolve(PROJECT, '../..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const shot = process.argv[2] || null;
const port = 8700 + Math.floor(Math.random() * 200);

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: SERVE, stdio: 'ignore' });
const fail = (m) => { console.error('FALHOU:', m); process.exitCode = 1; };
try {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push(String(e)));
  const rel = path.relative(SERVE, path.join(PROJECT, 'minigames/sports/demo/index.html')).split(path.sep).join('/');
  await page.goto(`http://127.0.0.1:${port}/${rel}?cena=glf_course_fc1&anim=bbl_b_swing1R&efeito=Bsb_ball_tail01&layout=sportsTop_00`);
  await page.waitForFunction(() => window.__sports?.ready || window.__sports?.errors.length, null, { timeout: 120000 });
  const s = await page.evaluate(() => {
    const S = window.__sports;
    const gl = document.getElementById('palco').getContext('webgl2');
    return { ...S, webgl2: !!gl };
  });
  if (shot) await page.screenshot({ path: shot });
  // celular em retrato: o layout reescala sem erro
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const fit = await page.evaluate(() => getComputedStyle(document.querySelector('.sp-lyt-stage')).transform);
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-celular.png') });
  await browser.close();
  console.log(JSON.stringify({ ...s, layoutTransformPhone: fit, consoleErrors: logs }, null, 1));
  const shaderErr = logs.filter((l) => /shader|program|WebGL/i.test(l));
  if (!s.ready) fail('a demo não ficou pronta: ' + s.errors.join('; '));
  if (s.errors.length) fail('erros: ' + s.errors.join('; '));
  if (shaderErr.length) fail('erros de shader: ' + shaderErr.join('; '));
  if (!(s.programs > 0)) fail('nenhum programa WebGL');
  if (!(s.scene?.triangles > 0)) fail('sem colisão');
  if (s.scene?.ground !== 'tee') fail(`chão sob o corpo = ${s.scene?.ground}, esperado tee`);
  if (!(s.particles > 0)) fail('nenhuma partícula viva');
  if (!(s.layout?.panes > 0)) fail('layout sem painéis');
  if (!fit || fit === 'none') fail('layout não reescalou no celular');
  if (!process.exitCode) console.log('OK: demo no Chromium (WebGL 2) sem erros');
} finally {
  server.kill();
}
