const { chromium } = require('playwright');
const path = require('path');

async function runBenchmark() {
  console.log("=========================================");
  console.log("COSYNC PERFORMANCE BENCHMARK RUNNER");
  console.log("=========================================");

  const uniqueSuffix = Math.random().toString(36).substring(7);
  const username = `bench_${uniqueSuffix}`;

  // 1. Create a temporary user, workspace, and document
  console.log(`[1/5] Setting up temporary document for benchmark (User: ${username})...`);
  
  const registerRes = await fetch('http://localhost:4000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123' })
  });
  const registerData = await registerRes.json();
  if (!registerRes.ok) throw new Error("Registration failed: " + JSON.stringify(registerData));

  const token = registerData.token;
  const user = registerData.user;

  const wsRes = await fetch('http://localhost:4000/api/workspaces', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ name: 'Benchmark Workspace' })
  });
  const workspace = await wsRes.json();
  if (!wsRes.ok) throw new Error("Workspace creation failed: " + JSON.stringify(workspace));

  const docRes = await fetch(`http://localhost:4000/api/workspaces/${workspace.id}/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ title: 'Benchmark Test Document' })
  });
  const document = await docRes.json();
  if (!docRes.ok) throw new Error("Document creation failed: " + JSON.stringify(document));

  console.log(`[2/5] Setup complete. Workspace ID: ${workspace.id}, Document ID: ${document.id}`);

  // 2. Launch headless browser
  console.log("[3/5] Launching Playwright Chromium instance...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Create CDP session to monitor Chrome Performance metrics
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Performance.enable');

  async function getCDPMetrics() {
    const response = await cdpSession.send('Performance.getMetrics');
    const result = {};
    for (const m of response.metrics) {
      result[m.name] = m.value;
    }
    return result;
  }

  // Load application and inject auth token
  await page.goto('http://localhost:5173/');
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('cosync_token', token);
    localStorage.setItem('cosync_user', JSON.stringify(user));
  }, { token, user });
  await page.reload();

  // Open the document
  await page.waitForSelector('text=Benchmark Workspace');
  await page.click('text=Benchmark Workspace');
  await page.waitForSelector('text=Benchmark Test Document');
  await page.click('text=Benchmark Test Document');
  await page.waitForSelector('.tiptap');
  
  // Wait another second to stabilize WebSocket connection
  await page.waitForTimeout(1000);

  console.log("[4/5] Running active typing benchmark...");

  // Capture initial metrics
  const initialMetrics = await getCDPMetrics();
  
  // Performance measurement variables
  const characterCount = 100;
  
  const startTime = Date.now();
  await page.focus('.tiptap');
  
  // Type 100 characters sequentially
  for (let i = 0; i < characterCount; i++) {
    await page.keyboard.type('a', { delay: 10 }); // simulates user typing
  }
  
  const endTime = Date.now();
  const duration = endTime - startTime;
  
  // Capture final metrics
  const finalMetrics = await getCDPMetrics();
  await browser.close();

  console.log("[5/5] Compiling benchmark results...\n");

  // Calculate differences
  const domNodesCreated = (finalMetrics.Nodes || 0) - (initialMetrics.Nodes || 0);
  const layoutCount = (finalMetrics.LayoutCount || 0) - (initialMetrics.LayoutCount || 0);
  const styleRecalcs = (finalMetrics.RecalcStyleCount || 0) - (initialMetrics.RecalcStyleCount || 0);
  const memoryChurnKB = Math.round(((finalMetrics.JSHeapUsedSize || 0) - (initialMetrics.JSHeapUsedSize || 0)) / 1024);
  const taskDurationMs = Math.round(((finalMetrics.TaskDuration || 0) - (initialMetrics.TaskDuration || 0)) * 1000);
  const scriptDurationMs = Math.round(((finalMetrics.ScriptDuration || 0) - (initialMetrics.ScriptDuration || 0)) * 1000);
  const totalDurationMs = duration;
  const avgLatencyPerChar = (duration / characterCount).toFixed(2);

  console.log("=========================================");
  console.log("          BENCHMARK RESULT REPORT        ");
  console.log("=========================================");
  console.log(`Document Type: Standard Workspace Doc`);
  console.log(`Keystrokes Typed: ${characterCount} characters`);
  console.log(`Total Typing Time: ${totalDurationMs} ms`);
  console.log(`Average Latency Per Key: ${avgLatencyPerChar} ms`);
  console.log(`Browser CPU Task Duration: ${taskDurationMs} ms`);
  console.log(`Browser Script Run Duration: ${scriptDurationMs} ms`);
  console.log(`DOM Nodes Created/Modified: ${domNodesCreated} nodes`);
  console.log(`Style Recalculations: ${styleRecalcs}`);
  console.log(`Layout Redraws (Shifts): ${layoutCount}`);
  console.log(`Memory Used Heap Delta: ${memoryChurnKB} KB`);
  console.log("=========================================");
  console.log("Use this script to compare HEAD with commit 9d7e615.");
  console.log("Simply run 'node tests/benchmark.js' on both commits.");
  console.log("=========================================\n");
}

runBenchmark().catch(err => {
  console.error("Benchmark execution failed:", err);
  process.exit(1);
});
