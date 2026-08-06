---
Task ID: 1
Agent: Main Orchestrator
Task: Clone Stream-Vault repo, replace existing project, scan entire codebase

Work Log:
- Cloned https://github.com/Anisbk00/Stream-Vault.git using provided credentials
- Removed old project directories (src/, public/, prisma/, db/, mini-services/, tests/, agent-ctx/, tool-results/)
- Rsync'd all repo contents into /home/z/my-project/
- Cleaned up temp clone directory
- Ran `bun install` — 22 new packages installed successfully
- Started dev server with `bun run dev` — Next.js 16.1.3 (Turbopack) on port 3000
- First compilation: 5.1s compile + 366ms render → HTTP 200
- Verified with agent-browser: page loads correctly showing Movera splash screen (RetroShield gate)
- Zero console errors, zero runtime errors
- Full codebase scan completed by Explore agent

Stage Summary:
- Project replaced successfully with Stream-Vault (Movera) codebase
- App uses Supabase exclusively (no Prisma)
- 25 streaming components, 14 core libraries, 2 Zustand stores, 13 API routes
- Dev server running on port 3000, page renders correctly
- Missing .env.local (Supabase + TMDB keys) — app shows RetroShield gate as expected
- All universal behavior rules acknowledged and will be enforced

---
Task ID: 2
Agent: Main Orchestrator
Task: Fix PWA logout after inactivity + "connection lost" on re-login + add error handlers

Work Log:
- Identified 6 root causes of the PWA logout/re-login failure chain
- Fix 1: Added JWT expiry validation to bootstrapFromCache() in store/index.ts
  - Before: cached expired token set status='authenticated' → instant logout on getSession() null
  - After: expired JWT with refresh_token → status='loading' → auth effect attempts refresh
  - After: expired JWT without refresh_token → status='unauthenticated' directly
- Fix 2: Added session recovery to MoveraApp auth validation effect
  - Before: getSession()=null → immediate setStatus('unauthenticated') → hard logout
  - After: getSession()=null + online → attempt refreshSession() first → restore if successful
  - After: refresh failed → toast "Session expired" + graceful unauthenticated transition
- Fix 3: Added JWT expiry detection + refresh to session-manager visibility handler
  - Before: visibility wake → heartbeat only → expired JWT causes false eviction
  - After: visibility wake → check JWT expiry → attempt refresh → then heartbeat
  - Added 800ms network stabilization delay after device wake
- Fix 4: Complete rewrite of LoginScreen error handling
  - Added classifyAuthError() with 6 error categories: network, auth, server, timeout, config, unknown
  - Added waitForNetworkReady() probe (HEAD to Supabase URL) before signIn
  - Added auto-retry with exponential backoff (max 2 retries) for transient errors
  - Specific messages: "Cannot reach server", "No internet", "Too many attempts", "Server error"
  - Network readiness check prevents "connection lost" on device wake
- Fix 5: Added refreshSession() and isSessionTokenExpired() to supabase.ts
  - refreshSession(): wraps supabase.auth.refreshSession() with error classification
  - isSessionTokenExpired(): client-side JWT expiry check via localStorage
- Fix 6: Added [AUTH] prefix diagnostic logging at all key decision points
  - bootstrapFromCache: JWT expiry detection outcome
  - MoveraApp: session recovery attempt/success/failure
  - session-manager: visibility wake refresh attempt/success/failure
  - LoginScreen: error classification for every signIn failure
  - supabase.ts: refreshSession success/failure
- Verified: dev server compiles cleanly (0 errors, 1 pre-existing warning)
- Verified: browser loads login screen correctly, form is interactive, zero JS errors

Stage Summary:
- 5 files modified: store/index.ts, MoveraApp.tsx, session-manager.ts, LoginScreen.tsx, supabase.ts
- Primary fix: PWA session recovery via refresh token before hard logout
- Secondary fix: Classified error handlers prevent "connection lost" ambiguity
- Tertiary fix: Network readiness probe + auto-retry for transient failures
- Diagnostic: [AUTH] logs will identify exact cause next time without reinstall
- No UI/UX changes — all fixes are logic-only, preserving visual identity
