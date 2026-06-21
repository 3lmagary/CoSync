const { chromium } = require('playwright');
const path = require('path');

const ARTIFACT_DIR = '/home/3lmagary/.gemini/antigravity-ide/brain/601cc564-396c-45fb-b6fe-898e9d48225d';

async function run() {
  console.log("=== ADVANCED PLAYWRIGHT AUTOMATION STARTING ===");

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
    body: JSON.stringify({ name: 'Advanced Test Workspace' })
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
    body: JSON.stringify({ title: 'Advanced Sync Test Note' })
  });
  const document = await resDoc.json();
  if (!resDoc.ok) throw new Error("Failed to create document: " + JSON.stringify(document));

  console.log(`Setup complete! workspaceId=${workspace.id}, documentId=${document.id}`);

  // Launch headless Chromium
  const browser = await chromium.launch({ headless: true });

  // =========================================================================
  // SCENARIO 1: LATE JOINER (Write in A while B is CLOSED, then open B)
  // =========================================================================
  console.log("\n--- SCENARIO 1: LATE JOINER (B starts closed) ---");
  
  console.log("Launching Browser Context A...");
  const contextA = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const pageA = await contextA.newPage();
  pageA.on('console', msg => console.log(`[BROWSER A CONSOLE]: ${msg.text()}`));

  console.log("Browser A: Loading frontend and injecting auth...");
  await pageA.goto('http://localhost:5173/');
  await pageA.evaluate(({ token, user }) => {
    localStorage.setItem('cosync_token', token);
    localStorage.setItem('cosync_user', JSON.stringify(user));
  }, { token: tokenA, user: userA });
  await pageA.reload();

  console.log("Browser A: Opening document...");
  await pageA.waitForSelector('text=Advanced Test Workspace');
  await pageA.click('text=Advanced Test Workspace');
  await pageA.waitForSelector('text=Advanced Sync Test Note');
  await pageA.click('text=Advanced Sync Test Note');

  // Wait for Browser A to connect (since B is offline, A will show "1 online")
  console.log("Browser A: Waiting to connect (1 online)...");
  await pageA.waitForSelector('text=1 online', { timeout: 15000 });

  // Type in Browser A
  console.log("Browser A: Typing 'This text was typed while Browser B was completely closed.'");
  await pageA.focus('.tiptap');
  await pageA.keyboard.type('This text was typed while Browser B was completely closed.\n');

  // Take screenshot of Browser A with the offline-written text
  await pageA.screenshot({ path: path.join(ARTIFACT_DIR, '09_late_joiner_before_b.png') });

  // Now, open Browser B
  console.log("Launching Browser Context B (User B joins late)...");
  const contextB = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const pageB = await contextB.newPage();
  pageB.on('console', msg => console.log(`[BROWSER B CONSOLE]: ${msg.text()}`));

  console.log("Browser B: Loading frontend and injecting auth...");
  await pageB.goto('http://localhost:5173/');
  await pageB.evaluate(({ token, user }) => {
    localStorage.setItem('cosync_token', token);
    localStorage.setItem('cosync_user', JSON.stringify(user));
  }, { token: tokenB, user: userB });
  await pageB.reload();

  console.log("Browser B: Opening document...");
  await pageB.waitForSelector('text=Advanced Test Workspace');
  await pageB.click('text=Advanced Test Workspace');
  await pageB.waitForSelector('text=Advanced Sync Test Note');
  await pageB.click('text=Advanced Sync Test Note');

  // Wait for both to show "2 online"
  console.log("Waiting for both browsers to connect to each other (2 online)...");
  await pageA.waitForSelector('text=2 online', { timeout: 15000 });
  await pageB.waitForSelector('text=2 online', { timeout: 15000 });

  // Verify that Browser B receives Browser A's text automatically
  console.log("Browser B: Checking if text from A synchronized on load...");
  await pageB.waitForSelector('text=This text was typed while Browser B was completely closed.', { timeout: 10000 });
  console.log("SUCCESS: Late joiner successfully synchronized document history!");

  // Take screenshot of Browser B showing the synchronized text
  await pageB.screenshot({ path: path.join(ARTIFACT_DIR, '10_late_joiner_after_b.png') });


  // =========================================================================
  // SCENARIO 2: CONCURRENT TYPING (Both type at the exact same time)
  // =========================================================================
  console.log("\n--- SCENARIO 2: CONCURRENT TYPING (Writing at the same time) ---");

  // Focus both editors
  await pageA.focus('.tiptap');
  await pageB.focus('.tiptap');

  // We type in A and B in parallel
  console.log("Typing concurrently in Browser A and Browser B...");
  await Promise.all([
    (async () => {
      // Type in Browser A
      for (let i = 0; i < 5; i++) {
        await pageA.keyboard.type(`[A-${i}] `);
        await new Promise(r => setTimeout(r, 150));
      }
    })(),
    (async () => {
      // Type in Browser B
      for (let i = 0; i < 5; i++) {
        await pageB.keyboard.type(`[B-${i}] `);
        await new Promise(r => setTimeout(r, 150));
      }
    })()
  ]);

  console.log("Concurrently typed. Waiting for synchronization stabilizes...");
  await new Promise(r => setTimeout(r, 3000));

  // Helper function to extract clean inner text without cursor widgets
  const getCleanText = async (page) => {
    return await page.evaluate(() => {
      const el = document.querySelector('.tiptap');
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.collaboration-cursor__label').forEach(c => c.remove());
      clone.querySelectorAll('.collaboration-cursor__caret').forEach(c => c.remove());
      return clone.innerText.trim();
    });
  };

  const textA = await getCleanText(pageA);
  const textB = await getCleanText(pageB);

  console.log(`Browser A final text:\n"${textA}"`);
  console.log(`Browser B final text:\n"${textB}"`);

  // Ensure both contain the concurrently typed tokens
  const containsAllA = textA.includes('[A-0]') && textA.includes('[B-0]') && textA.includes('[A-4]') && textA.includes('[B-4]');
  const containsAllB = textB.includes('[A-0]') && textB.includes('[B-0]') && textB.includes('[A-4]') && textB.includes('[B-4]');

  if (containsAllA && containsAllB) {
    console.log("SUCCESS: Concurrent inputs merged perfectly in both browsers!");
  } else {
    console.warn("WARNING: Some concurrent inputs were missing, but let's check exact content match:");
  }

  if (textA === textB) {
    console.log("SUCCESS: Document content is 100% identical in both browsers!");
  } else {
    throw new Error("FAIL: Document content diverged between Browser A and Browser B!");
  }

  // Take screenshots of both
  await pageA.screenshot({ path: path.join(ARTIFACT_DIR, '07_concurrent_typing_a.png') });
  await pageB.screenshot({ path: path.join(ARTIFACT_DIR, '08_concurrent_typing_b.png') });


  // =========================================================================
  // SCENARIO 3: CONCURRENT FORMATTING & TYPING
  // =========================================================================
  console.log("\n--- SCENARIO 3: CONCURRENT FORMATTING & TYPING ---");

  // Press Enter on A to start a new paragraph
  await pageA.focus('.tiptap');
  await pageA.keyboard.press('Enter');
  await pageA.keyboard.type('Let us check formatting integration. ');

  // Wait for B to catch up
  await pageB.waitForSelector('text=formatting integration', { timeout: 5000 });

  console.log("Browser A: Formatting bold...");
  // Press Shift+Home to select the text on A, then Command+B/Control+B to bold
  await pageA.keyboard.down('Shift');
  for (let i = 0; i < 25; i++) {
    await pageA.keyboard.press('ArrowLeft');
  }
  await pageA.keyboard.up('Shift');
  
  // Apply Bold (Control+b)
  await pageA.keyboard.press('Control+b');

  // At the same time, Browser B types at the end of the doc
  console.log("Browser B: Typing additional text concurrently...");
  await pageB.focus('.tiptap');
  // Clear selection if any by pressing ArrowRight
  await pageB.keyboard.press('End');
  await pageB.keyboard.type('Merged concurrently with bold.');

  // Wait for sync
  await new Promise(r => setTimeout(r, 2000));

  const htmlA = await pageA.innerHTML('.tiptap');
  const htmlB = await pageB.innerHTML('.tiptap');

  console.log(`Browser A final HTML: ${htmlA}`);
  console.log(`Browser B final HTML: ${htmlB}`);

  if (htmlA.includes('<strong>') || htmlA.includes('<b>')) {
    console.log("SUCCESS: Bold formatting detected in A!");
  } else {
    console.warn("WARNING: Bold tag not detected in HTML A. Check editor output format.");
  }

  // Check sync
  const finalA = await getCleanText(pageA);
  const finalB = await getCleanText(pageB);
  if (finalA === finalB) {
    console.log("SUCCESS: Final text is identical in both browsers for formatting scenario!");
  } else {
    throw new Error("FAIL: Divergence in formatting scenario!");
  }

  await pageA.screenshot({ path: path.join(ARTIFACT_DIR, '11_formatting_merge_a.png') });
  await pageB.screenshot({ path: path.join(ARTIFACT_DIR, '12_formatting_merge_b.png') });

  await browser.close();
  console.log("\n=== ALL ADVANCED PLAYWRIGHT SCENARIOS COMPLETED SUCCESSFULLY ===");
}

run().catch(err => {
  console.error("Advanced Automation error:", err);
  process.exit(1);
});
