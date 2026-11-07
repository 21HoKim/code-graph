// Build a single self-contained HTML page (no VS Code needed) from analyzed sample graphs.
//   node scripts/build-demo.mjs out.html lang graph1.json[:Label[:run.json]] graph2.json[:Label[:run.json]] ...
// run.json = output of `node dist/cli.js trace <dir> -o run.json` (replayable runtime trace)
// ELK_CDN=https://cdn.jsdelivr.net/npm/elkjs@0.12.1/lib/  -> load ELK from a CDN instead of inlining it.
import fs from 'node:fs';

const [out, lang, ...inputs] = process.argv.slice(2);
const cdn = process.env.ELK_CDN;
const graphs = inputs.map((arg) => {
  const [file, label, run] = arg.split(':');
  return { label: label ?? file, graph: JSON.parse(fs.readFileSync(file, 'utf8')), trace: run ? JSON.parse(fs.readFileSync(run, 'utf8')) : undefined };
});
const js = fs.readFileSync('dist/webview/main.js', 'utf8');
const css = fs.readFileSync('dist/webview/main.css', 'utf8');
const elk = cdn ? '' : fs.readFileSync('dist/webview/elk-worker.js', 'utf8');
const settings = { defaultLevel: 'auto', layout: 'circuit', flow: 'all', maxParticles: 2500, showGuesses: true, lang, host: false };
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
const options = graphs.map((g, i) => `<option value="${i}">${g.label}</option>`).join('');
const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>CodeGraph — demo</title>
<style>${css}
.demo-pick{position:fixed;right:10px;top:46px;z-index:40;background:var(--cc-panel);border:1px solid var(--cc-border);border-radius:8px;padding:4px 8px;font-size:12px;color:var(--cc-fg)}
.demo-pick select{background:transparent;color:inherit;border:0;font:inherit}
</style>
</head>
<body class="vscode-dark" data-lang="${lang}"${cdn ? ` data-elk-cdn="${cdn}"` : ''}>
<div id="app"></div>
<div class="demo-pick ui">◆ <select id="demo-sample">${options}</select></div>
${cdn ? '' : `<script type="text/plain" id="elk-worker-src">${safe(elk)}</script>`}
<script>window.__CODE_GRAPH_DEMO__ = ${safe(JSON.stringify({ graph: graphs[0].graph, settings, trace: graphs[0].trace }))};
window.__CODE_GRAPH_SAMPLES__ = ${safe(JSON.stringify(graphs.map((g) => ({ graph: g.graph, trace: g.trace }))))};</script>
<script>${safe(js)}</script>
<script>
// keep the sample picker just below the toolbar (it wraps to several rows on phones)
(function () {
  var pick = document.querySelector('.demo-pick');
  var place = function () {
    var tb = document.querySelector('.toolbar');
    if (tb) pick.style.top = Math.round(tb.getBoundingClientRect().bottom + 6) + 'px';
  };
  var tb = document.querySelector('.toolbar');
  if (tb) new ResizeObserver(place).observe(tb);
  window.addEventListener('resize', place);
  place();
})();
document.getElementById('demo-sample').addEventListener('change', function (e) {
  var g = window.__CODE_GRAPH_SAMPLES__[Number(e.target.value)];
  window.codeGraph.loadDemo(g.graph, ${JSON.stringify(settings)}, g.trace);
});
</script>
</body>
</html>`;
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KiB)`);
