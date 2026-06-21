const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = '/home/3lmagary/.gemini/antigravity-ide/brain/601cc564-396c-45fb-b6fe-898e9d48225d';

async function run() {
  console.log("PLAYWRIGHT AUTOMATION STARTING...");

  const uniqueSuffix = Math.random().toString(36).substring(7);
  const usernameA = `user_a_${uniqueSuffix}`;
  const usernameB = `user_b_${uniqueSuffix}`;

  // 1. Create two users and set up a shared document via backend REST API
  console.log("Registering User A...");
  const resA = await fetch('http://localhost:4000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: usernameA, password: 'password123' })
  });
  const dataA = await resA.json();
  if (!resA.ok) throw new Error("Failed to register User A: " + JSON.stringify(dataA));

  console.log("Registering User B...");
  const resB = await fetch('http://localhost:4000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: usernameB, password: 'password123' })
  });
  const dataB = await resB.json();
  if (!resB.ok) throw new Error("Failed to register User B: " + JSON.stringify(dataB));

  const tokenA = dataA.token;
  const tokenB = dataB.token;
  const userA = dataA.user;
  const userB = dataB.user;

  console.log("Creating Workspace under User A...");
  const resWS = await fetch('http://localhost:4000/api/workspaces', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    },
    body: JSON.stringify({ name: 'Diagnostic Workspace' })
  });
  const workspace = await resWS.json();
  if (!resWS.ok) throw new Error("Failed to create workspace: " + JSON.stringify(workspace));

  console.log("Sharing Workspace with User B...");
  const resShare = await fetch(`http://localhost:4000/api/workspaces/${workspace.id}/share`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    },
    body: JSON.stringify({ username: usernameB })
  });
  const shareData = await resShare.json();
  if (!resShare.ok) throw new Error("Failed to share workspace: " + JSON.stringify(shareData));

  console.log("Creating Document under workspace...");
  const resDoc = await fetch(`http://localhost:4000/api/workspaces/${workspace.id}/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    },
    body: JSON.stringify({ title: 'Realtime Sync Test Note' })
  });
  const document = await resDoc.json();
  if (!resDoc.ok) throw new Error("Failed to create document: " + JSON.stringify(document));

  console.log(`Setup complete! workspaceId=${workspace.id}, documentId=${document.id}`);

  // 2. Launch headless Chromium
  const browser = await chromium.launch({ headless: true });

  // Browser Context A (Ahmed)
  console.log("Launching Browser Context A...");
  const contextA = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const pageA = await contextA.newPage();

  pageA.on('console', msg => {
    console.log(`[BROWSER A CONSOLE]: ${msg.text()}`);
  });

  // Browser Context B (User B)
  console.log("Launching Browser Context B...");
  const contextB = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const pageB = await contextB.newPage();

  pageB.on('console', msg => {
    console.log(`[BROWSER B CONSOLE]: ${msg.text()}`);
  });

  // Load app in A, inject localStorage auth token, reload
  console.log("Browser A: Loading frontend and injecting auth...");
  await pageA.goto('http://localhost:5173/');
  await pageA.evaluate(({ token, user }) => {
    localStorage.setItem('cosync_token', token);
    localStorage.setItem('cosync_user', JSON.stringify(user));
  }, { token: tokenA, user: userA });
  await pageA.reload();

  // Load app in B, inject localStorage auth token, reload
  console.log("Browser B: Loading frontend and injecting auth...");
  await pageB.goto('http://localhost:5173/');
  await pageB.evaluate(({ token, user }) => {
    localStorage.setItem('cosync_token', token);
    localStorage.setItem('cosync_user', JSON.stringify(user));
  }, { token: tokenB, user: userB });
  await pageB.reload();

  // Wait for workspace to load and click it to expand
  console.log("Expanding Workspace folder in Browser A...");
  await pageA.waitForSelector('text=Diagnostic Workspace');
  await pageA.click('text=Diagnostic Workspace');

  console.log("Expanding Workspace folder in Browser B...");
  await pageB.waitForSelector('text=Diagnostic Workspace');
  await pageB.click('text=Diagnostic Workspace');

  // Wait for sidebar documents to load
  console.log("Waiting for documents sidebar to render...");
  await pageA.waitForSelector('text=Realtime Sync Test Note');
  await pageB.waitForSelector('text=Realtime Sync Test Note');

  // Take screenshot before entering room
  await pageA.screenshot({ path: path.join(ARTIFACT_DIR, '01_browser_a_ready.png') });
  await pageB.screenshot({ path: path.join(ARTIFACT_DIR, '02_browser_b_ready.png') });

  // Click document on A and B to open the rooms
  console.log("Browser A: Clicking Document link...");
  await pageA.click('text=Realtime Sync Test Note');
  
  console.log("Browser B: Clicking Document link...");
  await pageB.click('text=Realtime Sync Test Note');

  // Wait for ws to connect and join room (look for online users badge text "2 online")
  console.log("Waiting for connections and presence to synchronize...");
  await pageA.waitForSelector('text=2 online', { timeout: 15000 });
  await pageB.waitForSelector('text=2 online', { timeout: 15000 });
  console.log("SUCCESS: Both browsers show '2 online'!");

  // Take screenshots showing Online Users & Editor open
  await pageA.screenshot({ path: path.join(ARTIFACT_DIR, '03_browser_a_connected.png') });
  await pageB.screenshot({ path: path.join(ARTIFACT_DIR, '04_browser_b_connected.png') });

  // Focus Editor on Browser A and type Hello
  console.log("Browser A: Typing 'Hello from Browser A'...");
  await pageA.focus('.tiptap');
  await pageA.keyboard.type('Hello from Browser A');

  // Wait for Browser B to receive the sync update
  console.log("Waiting for Browser B to display synced text...");
  await pageB.waitForSelector('text=Hello from Browser A', { timeout: 10000 });
  console.log("SUCCESS: Text synchronized to Browser B!");

  // Take final screenshots demonstrating document synchronization
  await pageA.screenshot({ path: path.join(ARTIFACT_DIR, '05_browser_a_final.png') });
  await pageB.screenshot({ path: path.join(ARTIFACT_DIR, '06_browser_b_final.png') });

  await browser.close();
  console.log("PLAYWRIGHT AUTOMATION SUCCESSFUL!");
}

run().catch(err => {
  console.error("Automation error:", err);
  process.exit(1);
});
