const { chromium } = require('playwright');
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const ws = require('ws');
const path = require('path');

const ARTIFACT_DIR = '/home/3lmagary/.gemini/antigravity-ide/brain/601cc564-396c-45fb-b6fe-898e9d48225d';

async function run() {
  console.log("=== BROWSER ↔ OBSIDIAN E2E AUTOMATION STARTING ===");

  const uniqueSuffix = Math.random().toString(36).substring(7);
  const usernameA = `user_a_${uniqueSuffix}`;

  // 1. Setup user, workspace and document
  console.log("Registering User A...");
  const resA = await fetch('http://localhost:4000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: usernameA, password: 'password123' })
  });
  const dataA = await resA.json();
  if (!resA.ok) throw new Error("Failed to register User A: " + JSON.stringify(dataA));

  const tokenA = dataA.token;
  const userA = dataA.user;

  console.log("Creating Workspace...");
  const resWS = await fetch('http://localhost:4000/api/workspaces', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    },
    body: JSON.stringify({ name: 'Obsidian Integration Workspace' })
  });
  const workspace = await resWS.json();
  if (!resWS.ok) throw new Error("Failed to create workspace: " + JSON.stringify(workspace));

  console.log("Creating Document...");
  const resDoc = await fetch(`http://localhost:4000/api/workspaces/${workspace.id}/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    },
    body: JSON.stringify({ title: 'Obsidian Integration Note' })
  });
  const document = await resDoc.json();
  if (!resDoc.ok) throw new Error("Failed to create document: " + JSON.stringify(document));

  const workspaceId = workspace.id;
  const documentId = document.id;
  console.log(`Setup complete! workspaceId=${workspaceId}, documentId=${documentId}`);

  // 2. Start Playwright Browser (Browser Client)
  console.log("Launching Playwright Browser...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log(`[BROWSER CONSOLE]: ${msg.text()}`));

  console.log("Browser: Loading frontend and injecting auth...");
  await page.goto('http://localhost:5173/');
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('cosync_token', token);
    localStorage.setItem('cosync_user', JSON.stringify(user));
  }, { token: tokenA, user: userA });
  await page.reload();

  console.log("Browser: Opening document...");
  await page.waitForSelector('text=Obsidian Integration Workspace');
  await page.click('text=Obsidian Integration Workspace');
  await page.waitForSelector('text=Obsidian Integration Note');
  await page.click('text=Obsidian Integration Note');

  // Wait for Browser to connect
  console.log("Browser: Waiting to connect (1 online)...");
  await page.waitForSelector('text=1 online', { timeout: 15000 });

  // 3. Connect simulated Obsidian Client (Node Client)
  console.log("Obsidian Simulator: Connecting to room...");
  const obsidianDoc = new Y.Doc();
  const roomName = `workspace/${workspaceId}/doc/${documentId}`;
  
  const obsidianProvider = new WebsocketProvider('ws://localhost:4000', roomName, obsidianDoc, {
    WebSocketPolyfill: ws,
    protocols: ['co-sync-auth', tokenA]
  });

  const obsidianText = obsidianDoc.getText('codemirror');

  // Set awareness local state for simulated Obsidian user
  obsidianProvider.awareness.setLocalState({
    user: {
      name: 'obsidian-client',
      color: '#4CAF50',
      userId: 'obsidian-client'
    }
  });

  // Wait for both to show "2 online"
  console.log("Waiting for both Browser and Obsidian Simulator to connect (2 online)...");
  await page.waitForSelector('text=2 online', { timeout: 15000 });
  console.log("SUCCESS: Both browser and Obsidian simulator are connected!");

  // Take screenshot after initial connection
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '13_obsidian_connected.png') });

  // =========================================================================
  // TEST 1: BROWSER -> OBSIDIAN (Typing in browser updates Obsidian text)
  // =========================================================================
  console.log("\n--- TEST 1: BROWSER ↔ OBSIDIAN (Browser types, Obsidian receives) ---");
  console.log("Browser: Typing 'Hello from the web browser client!'");
  await page.focus('.tiptap');
  await page.keyboard.type('Hello from the web browser client!');

  // Wait for the simulated Obsidian client to receive the change on ytext ('codemirror')
  console.log("Obsidian Simulator: Waiting to receive update on codemirror text...");
  
  let receivedText = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    receivedText = obsidianText.toString();
    if (receivedText.includes("Hello from the web browser client!")) {
      console.log(`SUCCESS: Obsidian received update! Content: "${receivedText.trim()}"`);
      break;
    }
    await new Promise(r => setTimeout(r, 400));
  }

  if (!receivedText.includes("Hello from the web browser client!")) {
    throw new Error(`FAIL: Obsidian failed to receive update. Current text: "${receivedText}"`);
  }

  // Wait 1000ms so that the browser's lastXmlChangeTime check (500ms safety window) expires.
  // In the real world, human switching between editor and Obsidian takes time, but in E2E tests it is instant.
  console.log("Waiting 1000ms for loop prevention safety window to clear...");
  await new Promise(r => setTimeout(r, 1000));

  // =========================================================================
  // TEST 2: OBSIDIAN -> BROWSER (Obsidian updates ytext, Browser editor updates)
  // =========================================================================
  console.log("\n--- TEST 2: OBSIDIAN ↔ BROWSER (Obsidian edits, Browser receives) ---");
  console.log("Obsidian Simulator: Inserting '\\nAnd this sentence was added by the Obsidian plugin.'");
  
  obsidianDoc.transact(() => {
    obsidianText.insert(obsidianText.length, '\nAnd this sentence was added by the Obsidian plugin.');
  });

  // Wait for Browser editor to render the new sentence
  console.log("Browser: Waiting for editor to show Obsidian updates...");
  await page.waitForSelector('text=And this sentence was added by the Obsidian plugin.', { timeout: 10000 });
  console.log("SUCCESS: Browser successfully synced text from Obsidian!");

  // Take screenshot of browser displaying Obsidian modifications
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '14_obsidian_to_browser_done.png') });

  // Helper to extract clean browser text
  const getCleanText = async () => {
    return await page.evaluate(() => {
      const el = document.querySelector('.tiptap');
      if (!el) return '';
      const paras = Array.from(el.querySelectorAll('p')).map(p => {
        const clone = p.cloneNode(true);
        clone.querySelectorAll('.collaboration-cursor__label').forEach(c => c.remove());
        clone.querySelectorAll('.collaboration-cursor__caret').forEach(c => c.remove());
        return clone.textContent.trim();
      });
      return paras.join('\n').trim();
    });
  };

  const finalBrowserText = await getCleanText();
  const finalObsidianText = obsidianText.toString();
  
  console.log(`\nFinal Browser Editor Plain Text:\n"${finalBrowserText}"`);
  console.log(`Final Obsidian Document Plain Text:\n"${finalObsidianText.trim()}"`);

  // Ensure content converges
  // We compare finalBrowserText with body of finalObsidianText (excluding frontmatter)
  if (finalObsidianText.includes(finalBrowserText)) {
    console.log("SUCCESS: Content convergence verified between Browser and Obsidian!");
  } else {
    throw new Error("FAIL: Divergent content between Browser and Obsidian!");
  }

  // Clean up
  obsidianProvider.disconnect();
  obsidianDoc.destroy();
  await browser.close();
  
  console.log("\n=== ALL BROWSER ↔ OBSIDIAN TESTS PASSED SUCCESSFULLY ===");
}

run().catch(err => {
  console.error("Obsidian E2E Automation error:", err);
  process.exit(1);
});
