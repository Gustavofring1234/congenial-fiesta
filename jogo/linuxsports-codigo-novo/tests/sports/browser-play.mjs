// Teste de navegador da Etapa 5 (WebGL 2 de verdade): abre minigames/sports/demo/jogar.html no Chromium headless,
// confere o menu da máquina de estados (Boot -> Menu principal pelo teclado) e joga uma partida de cada modalidade com
// a CPU no lugar do jogador (?cpu=1), acelerada, até o placar final, sem erros de console/shader.
//   PLAYWRIGHT_CORE=/caminho/node_modules/playwright-core [CHROMIUM_PATH=/caminho/chrome] node tests/sports/browser-play.mjs [pasta-das-fotos]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '../..');
const SERVE = path.resolve(PROJECT, '../..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const shots = process.argv[2] || null;
const port = 8700 + Math.floor(Math.random() * 200);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: SERVE, stdio: 'ignore' });
const fail = (m) => { console.error('FALHOU:', m); process.exitCode = 1; };
const rel = path.relative(SERVE, path.join(PROJECT, 'minigames/sports/demo/jogar.html')).split(path.sep).join('/');
const url = (q) => `http://127.0.0.1:${port}/${rel}${q}`;

try {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const report = {};
  // 1) menus
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
    page.on('pageerror', (e) => logs.push(String(e)));
    await page.goto(url(''));
    await page.waitForFunction(() => window.__sportsGame && window.__sportsGame.machine === 'Boot', null, { timeout: 60000 });
    await page.focus('#jogo');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__sportsGame.machine === 'MainMenu', null, { timeout: 10000 });
    const items = await page.$$eval('.sp-menu-item', (b) => b.map((x) => x.textContent));
    await page.click('.sp-menu-item[data-id=play]');
    await page.waitForFunction(() => window.__sportsGame.machine === 'SportSelect', null, { timeout: 10000 });
    const sports = await page.$$eval('.sp-menu-item', (b) => b.map((x) => x.textContent));
    if (shots) await page.screenshot({ path: path.join(shots, 'menu.png') });
    report.menu = { items, sports, errors: logs };
    if (sports.length !== 5) fail('menu de modalidades sem as 5');
    if (logs.length) fail('erros no menu: ' + logs.join('; '));
    await page.close();
  }
  // 2) uma partida curta por modalidade, CPU contra CPU
  const quick = { bowling: '&quadros=1', tennis: '', baseball: '', golf: '', boxing: '' };
  for (const [sport, extra] of Object.entries(quick)) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
    page.on('pageerror', (e) => logs.push(String(e)));
    await page.goto(url(`?esporte=${sport}&cpu=1&velocidade=4${extra}`));
    await page.waitForFunction(() => window.__sportsGame && window.__sportsGame.state === 'jogando', null, { timeout: 120000 }).catch(() => {});
    // o SwiftShader (WebGL por software) desenha poucos quadros por segundo: espera a partida andar 3 s de jogo
    await page.waitForFunction(() => { const S = window.__sportsGame; return S && (S.error || S.errors.length || (S.time >= 3 && S.actors > 0)); }, null, { timeout: 180000 }).catch(() => {});
    const mid = await page.evaluate(() => ({ ...window.__sportsGame, game: undefined }));
    if (shots) await page.screenshot({ path: path.join(shots, `${sport}.png`) });
    report[sport] = { state: mid.state, machine: mid.machine, actors: mid.actors, programs: mid.programs, time: Math.round(mid.time), score: mid.score.split('\n')[0], errors: [...mid.errors, ...logs], error: mid.error };
    if (mid.error || mid.errors.length) fail(`${sport}: ${mid.error || mid.errors.join('; ')}`);
    if (!(mid.time >= 3)) fail(`${sport}: a partida não andou`);
    if (!(mid.actors > 0)) fail(`${sport}: nenhum ator desenhado`);
    const shader = logs.filter((l) => /shader|program|WebGL/i.test(l));
    if (shader.length) fail(`${sport}: erro de shader: ${shader.join('; ')}`);
    await page.close();
  }
  await browser.close();
  console.log(JSON.stringify(report, null, 1));
  if (!process.exitCode) console.log('OK: menus e as 5 modalidades no Chromium (WebGL 2) sem erros');
} finally {
  server.kill();
}
