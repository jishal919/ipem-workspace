  let API_BASE = window.IPEM_CONFIG?.API_BASE_URL || '/api';

  // When API_BASE is a relative path (e.g. '/api' on Vercel), we resolve the
  // absolute backend URL via the /backend-info endpoint. This is stored as a
  // Promise so callers building preview URLs can await it, eliminating the race
  // condition where a preview URL was built before the override resolved.
  let _apiBaseReady;
  if (API_BASE.startsWith('/')) {
    _apiBaseReady = fetch(API_BASE + '/backend-info')
      .then(r => r.json())
      .then(d => {
        if (d && d.backend_url) {
          API_BASE = d.backend_url.replace(/\/+$/, '');
          if (window.IPEM_CONFIG) {
            try {
              Object.defineProperty(window.IPEM_CONFIG, 'API_BASE_URL', {
                value: API_BASE,
                writable: true,
                configurable: true
              });
            } catch (e) {}
          }
          console.log('Resolved absolute API_BASE:', API_BASE);
        }
        return API_BASE;
      })
      .catch(err => {
        console.warn('Failed to resolve absolute API_BASE:', err);
        return API_BASE; // use relative path as fallback (still works via SW)
      });
  } else {
    _apiBaseReady = Promise.resolve(API_BASE);
  }

  // Helper: ensure API_BASE is fully resolved before returning a preview URL.
  // For localhost the promise resolves immediately. For Vercel it waits for
  // the /backend-info fetch to complete (usually < 300 ms).
  async function resolvedApiBase() {
    await _apiBaseReady;
    return API_BASE;
  }
    const N8N_WEBHOOK_URL = window.IPEM_CONFIG?.N8N_WEBHOOK_URL || '';
    let activeSession = null;
    let allPrograms = [];
    let currentExplorerTab = 'files';
    let modalProgram = null;
    let isWaiting = false;
    let webhookRuntimeOnline = false;
    let selectedProgram = null;
    let mobileDrawerMode = 'conversations';
    let conversationSearchQuery = '';
    let showHiddenFilesState = false;

    function isHiddenFile(filePath, forceShowSystem = false) {
      if (forceShowSystem) {
        const ALWAYS_HIDDEN_FILES = ["__pycache__", "node_modules"];
        const ALWAYS_HIDDEN_EXTENSIONS = [".pyc", ".pyo"];
        const segments = filePath.split('/');
        for (const seg of segments) {
          if (!seg) continue;
          const cleanSeg = seg.endsWith('/') ? seg.slice(0, -1) : seg;
          if (ALWAYS_HIDDEN_FILES.includes(cleanSeg)) return true;
          const extIndex = cleanSeg.lastIndexOf('.');
          if (extIndex !== -1) {
            const ext = cleanSeg.slice(extIndex).toLowerCase();
            if (ALWAYS_HIDDEN_EXTENSIONS.includes(ext)) return true;
          }
        }
        return false;
      }

      const HIDDEN_FILES = [
        "__pycache__",
        "node_modules",
        "sitecustomize.py",
        ".DS_Store",
        "Thumbs.db",
        ".pytest_cache",
        ".npm"
      ];
      const HIDDEN_EXTENSIONS = [
        ".pyc",
        ".pyo"
      ];

      const segments = filePath.split('/');
      for (const seg of segments) {
        if (!seg) continue;
        const cleanSeg = seg.endsWith('/') ? seg.slice(0, -1) : seg;
        if (HIDDEN_FILES.includes(cleanSeg)) return true;
        const extIndex = cleanSeg.lastIndexOf('.');
        if (extIndex !== -1) {
          const ext = cleanSeg.slice(extIndex).toLowerCase();
          if (HIDDEN_EXTENSIONS.includes(ext)) return true;
        }
      }
      return false;
    }

    function toggleShowHiddenFiles(checked) {
      showHiddenFilesState = checked;
      const cb1 = document.getElementById('showHiddenCheckbox');
      const cb2 = document.getElementById('showHiddenCheckboxMobile');
      if (cb1) cb1.checked = checked;
      if (cb2) cb2.checked = checked;
      loadExplorerContent();
    }
    window.toggleShowHiddenFiles = toggleShowHiddenFiles;

    function loadExpandedFolders() {
      try {
        return JSON.parse(localStorage.getItem('ipem_expanded_folders') || '{}');
      } catch {
        return {};
      }
    }
    function saveExpandedFolders(state) {
      localStorage.setItem('ipem_expanded_folders', JSON.stringify(state));
    }
    function getExplorerContentElement() {
      if (isMobileLayout() && mobileDrawerMode === 'programs') {
        return document.getElementById('sidebarExplorerContent');
      }
      return document.getElementById('explorerContent');
    }

    function switchMobileDrawerMode(mode) {
      if (window.innerWidth > MOBILE_BREAKPOINT) return;
      mobileDrawerMode = mode;

      const headerConv = document.getElementById('drawerHeaderConv');
      const headerProg = document.getElementById('drawerHeaderProg');
      const convListContainer = document.getElementById('convListContainer');
      const sidebarProgContent = document.getElementById('sidebarProgContent');

      const tabConv = document.getElementById('drawerTabConv');
      const tabProg = document.getElementById('drawerTabProg');

      if (mode === 'conversations') {
        if (headerConv) headerConv.classList.remove('hidden');
        if (headerProg) headerProg.classList.add('hidden');
        if (convListContainer) convListContainer.classList.remove('hidden');
        if (sidebarProgContent) sidebarProgContent.classList.add('hidden');
        if (tabConv) tabConv.classList.add('active');
        if (tabProg) tabProg.classList.remove('active');

        renderConversationSidebar();
      } else {
        if (headerConv) headerConv.classList.add('hidden');
        if (headerProg) headerProg.classList.remove('hidden');
        if (convListContainer) convListContainer.classList.add('hidden');
        if (sidebarProgContent) sidebarProgContent.classList.remove('hidden');
        if (tabConv) tabConv.classList.remove('active');
        if (tabProg) tabProg.classList.add('active');

        loadExplorerContent();
      }
    }
    window.switchMobileDrawerMode = switchMobileDrawerMode;

    function filterConversations() {
      const input = document.getElementById('convSearchInput');
      conversationSearchQuery = input ? input.value.toLowerCase() : '';
      renderConversationSidebar();
    }
    window.filterConversations = filterConversations;
    let fileContextTarget = null;
    const deleteRequests = new Set();
    const RUNNABLE_FILE_EXTENSIONS = new Set(['py','js','ts','java','go','rs','cpp','c','rb','php']);
    const MOBILE_BREAKPOINT = 768;
    let monacoReady = null;
    let monacoEditor = null;
    let editorModel = null;
    let editorViewState = null;
    let editorState = {
      open: false, loading: false, saving: false,
      programName: null, filename: null, originalContent: '', dirty: false
    };

    // ── CONVERSATION STORE ──────────────────────────────────────────────────────
    const CONV_KEY        = 'ipem_conversations';
    const ACTIVE_CONV_KEY = 'ipem_active_conv';
    const MEMORY_WINDOW   = 12;
    const TITLE_CONTEXT_TURNS = 8;
    const TITLE_REFRESH_USER_TURNS = 4;
    const PENDING_AUTH_DRAFT_KEY = 'ipem_pending_auth_draft';
    const titleGenerationInFlight = new Set();
    // Legacy key — migrated on startup
    const LEGACY_HISTORY_KEY = 'ipem_chat_history';

    // ── CONVERSATION → PROJECT MAPPING CACHE ────────────────────────────────────
    // In-memory cache of { sessionId → { program_name, project_type, language } }
    // Populated from the server's /conversation-projects endpoint.
    let convProjectsCache = {};

    async function loadConvProjectsFromServer() {
      if (!getAuthToken()) return;
      try {
        const projects = await api('GET', '/conversation-projects');
        if (Array.isArray(projects)) {
          convProjectsCache = {};
          projects.forEach(p => {
            convProjectsCache[p.session_id] = {
              program_name: p.program_name,
              project_type: p.project_type || 'single_file',
              language:     p.language || null
            };
          });
           // Sync into localStorage convs so linkedProgramId is populated
          const convs = loadConversations();
          let changed = false;
          convs.forEach(c => {
            const proj = convProjectsCache[c.sessionId];
            if (proj) {
              if (c.linkedProgramId !== proj.program_name) {
                c.linkedProgramId = proj.program_name;
                changed = true;
              }
            } else {
              if (c.linkedProgramId !== null) {
                c.linkedProgramId = null;
                changed = true;
              }
            }
          });
          if (changed) saveConversations(convs);
          renderConversationSidebar();
        }
      } catch (err) {
        console.warn('[CONV PROJECTS] Failed to load from server:', err);
      }
    }

    function getConvProject(sessionId) {
      return convProjectsCache[sessionId] || null;
    }

    function loadConversations() {
      try { return JSON.parse(localStorage.getItem(CONV_KEY) || '[]'); }
      catch { return []; }
    }
    function saveConversations(convs) {
      localStorage.setItem(CONV_KEY, JSON.stringify(convs));
    }
    function getActiveConvId() {
      return localStorage.getItem(ACTIVE_CONV_KEY) || null;
    }
    function setActiveConvId(id) {
      localStorage.setItem(ACTIVE_CONV_KEY, id);
    }
    function getActiveConv() {
      const id = getActiveConvId();
      if (!id) return null;
      return loadConversations().find(c => c.id === id) || null;
    }
    function createConversation(title = 'New Chat', customSessionId = null) {
      const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const sessionId = customSessionId || ('ui_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      const conv = { id, title, sessionId, messages: [], linkedProgramId: null, createdAt: Date.now(), updatedAt: Date.now() };
      const convs = loadConversations();
      convs.unshift(conv);
      saveConversations(convs);
      return conv;
    }
    function updateConv(convId, changes) {
      const convs = loadConversations();
      const idx = convs.findIndex(c => c.id === convId);
      if (idx === -1) return;
      convs[idx] = { ...convs[idx], ...changes, updatedAt: Date.now() };
      saveConversations(convs);
      return convs[idx];
    }
    function deleteConversation(convId) {
      const allConvs = loadConversations();
      const conv = allConvs.find(c => c.id === convId);
      const remainingConvs = allConvs.filter(c => c.id !== convId);
      saveConversations(remainingConvs);
      // Clean up DB history
      if (conv) api('DELETE', '/history?session_id=' + conv.sessionId).catch(() => {});
    }
    function removeConversationLocally(sessionId) {
      const allConvs = loadConversations();
      const convIndex = allConvs.findIndex(c => c.sessionId === sessionId);
      if (convIndex === -1) return;

      const conv = allConvs[convIndex];
      allConvs.splice(convIndex, 1);
      saveConversations(allConvs);

      if (getActiveConvSessionId() === sessionId) {
        notify('This conversation was deleted by an administrator.', 'error');
        const nextConv = allConvs[0];
        if (nextConv) switchConversation(nextConv.id);
        else newConversation();
      } else {
        renderConversationSidebar();
      }
    }
    function linkProgramToConv(convId, programName) {
      updateConv(convId, { linkedProgramId: programName });
    }
    function getConvByProgram(programName) {
      return loadConversations().find(c => c.linkedProgramId === programName) || null;
    }

    // ── PER-CONVERSATION HISTORY ────────────────────────────────────────────────
    function getActiveConvSessionId() {
      const conv = getActiveConv();
      return conv ? conv.sessionId : ('legacy_' + (localStorage.getItem('ipem_session_id') || 'default'));
    }
    // Alias for backward compat
    function getSessionId() { return getActiveConvSessionId(); }

    function loadChatHistory() {
      const conv = getActiveConv();
      if (!conv) return [];
      return conv.messages || [];
    }
    function saveChatHistory(messages) {
      const id = getActiveConvId();
      if (!id) return;
      updateConv(id, { messages: messages.slice(-100) });
    }
    function pushHistory(role, content) {
      const h = loadChatHistory();
      h.push({ role, content, ts: Date.now() });
      saveChatHistory(h);
    }
    function buildContextString() {
      return loadChatHistory().slice(-MEMORY_WINDOW)
        .map(t => `${t.role === 'user' ? 'User' : 'IPEM'}: ${t.content}`).join('\n');
    }
    function buildContextArray() {
      return loadChatHistory().slice(-MEMORY_WINDOW).map(t => ({
        role: t.role === 'user' ? 'user' : 'assistant', content: t.content
      }));
    }
    function clearChatHistory() {
      const id = getActiveConvId();
      if (id) updateConv(id, { messages: [] });
    }

    // Auto-title: use the LLM to create concise modern chat titles.
    async function autoTitleConversation(convId, n8nResponse, firstUserMessage) {
      const conv = loadConversations().find(c => c.id === convId);
      if (!shouldGenerateConversationTitle(conv, firstUserMessage)) return;
      if (titleGenerationInFlight.has(convId)) return;

      // Prefer n8n-provided title
      const titleFromN8n = n8nResponse?.conversationTitle || n8nResponse?.title;
      if (titleFromN8n && typeof titleFromN8n === 'string') {
        applyGeneratedConversationTitle(convId, titleFromN8n);
        return;
      }

      titleGenerationInFlight.add(convId);
      try {
        const title = await generateConversationTitle(convId, firstUserMessage);
        applyGeneratedConversationTitle(convId, title);
      } catch (err) {
        console.warn('Title generation failed:', err);
      } finally {
        titleGenerationInFlight.delete(convId);
      }
    }

    function shouldGenerateConversationTitle(conv, latestUserMessage) {
      if (!conv) return false;
      if (!isMeaningfulTitleInput(latestUserMessage)) return false;
      const userTurns = (conv.messages || []).filter(m => m.role === 'user').length;
      if (!conv.title || conv.title === 'New Chat') return true;
      if (conv.titleSource !== 'llm') return true;
      const lastUserTurn = conv.titleUserTurnCount || 0;
      return userTurns >= lastUserTurn + TITLE_REFRESH_USER_TURNS;
    }

    function isMeaningfulTitleInput(text) {
      const cleaned = String(text || '').trim();
      if (cleaned.length < 8) return false;
      if (/^(hi|hello|hey|ok|okay|thanks|thank you)$/i.test(cleaned)) return false;
      return true;
    }

    async function generateConversationTitle(convId, latestUserMessage) {
      const conv = loadConversations().find(c => c.id === convId);
      if (!conv) return '';

      const context = buildTitleContext(conv, latestUserMessage);
      if (!context) return '';

      const prompt = [
        'Generate a short conversation title summarizing this chat.',
        '',
        'Requirements:',
        '- 2-8 words',
        '- No quotes',
        '- No punctuation unless necessary',
        '- Human-friendly',
        '- Similar to ChatGPT, Claude, Gemini, or Cursor sidebar titles',
        '- Capture the main user intent or topic',
        '- Avoid generic prefixes like Chat about, Conversation regarding, or Discussion on',
        '',
        'Return only the title.',
        '',
        'Chat context:',
        context
      ].join('\n');

      const payload = {
        chatInput: prompt,
        message: prompt,
        sessionId: `${conv.sessionId || conv.id}_title`,
        history: [],
        context
      };
      const response = await api('POST', '/chat', payload);
      return sanitizeGeneratedTitle(extractResponseText(response));
    }

    function buildTitleContext(conv, latestUserMessage) {
      const turns = (conv.messages || [])
        .filter(m => m && m.content && typeof m.content === 'string')
        .slice(-TITLE_CONTEXT_TURNS)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`);

      if (!turns.length && latestUserMessage) turns.push(`User: ${latestUserMessage}`);
      return turns.join('\n');
    }

    function sanitizeGeneratedTitle(title) {
      let cleaned = String(title || '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/^title\s*:\s*/i, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      cleaned = cleaned.split(/\r?\n/)[0].trim();
      cleaned = cleaned.replace(/[.!?]+$/g, '').trim();
      cleaned = cleaned.replace(/^(chat about|conversation regarding|discussion on|title)\s+/i, '').trim();
      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length < 2 || words.length > 10) return '';
      return words.slice(0, 8).join(' ').slice(0, 60);
    }

    function applyGeneratedConversationTitle(convId, title) {
      const cleaned = sanitizeGeneratedTitle(title);
      if (!cleaned) return;
      const conv = loadConversations().find(c => c.id === convId);
      if (!conv) return;
      const userTurns = (conv.messages || []).filter(m => m.role === 'user').length;
      updateConv(convId, {
        title: cleaned,
        titleSource: 'llm',
        titleGeneratedAt: Date.now(),
        titleUserTurnCount: userTurns
      });
      renderConversationSidebar();
      updateConvTitleBar();
    }

    // ── CONVERSATION SIDEBAR RENDERING ─────────────────────────────────────────
    function renderConversationSidebar() {
      const list = document.getElementById('convList');
      if (!list) return;
      let convs = loadConversations();
      if (conversationSearchQuery) {
        convs = convs.filter(c => c.title.toLowerCase().includes(conversationSearchQuery));
      }
      const activeId = getActiveConvId();
      if (!convs.length) {
        list.innerHTML = `<div class="programs-empty">${conversationSearchQuery ? 'No matching chats found.' : 'No conversations yet.<br>Start chatting!'}</div>`;
        return;
      }
      // Group by date
      const now = Date.now();
      const todayStart    = new Date().setHours(0,0,0,0);
      const yesterdayStart= todayStart - 86400000;
      const weekStart     = todayStart - 6 * 86400000;
      const groups = { today: [], yesterday: [], thisWeek: [], older: [] };
      convs.forEach(c => {
        if      (c.updatedAt >= todayStart)     groups.today.push(c);
        else if (c.updatedAt >= yesterdayStart) groups.yesterday.push(c);
        else if (c.updatedAt >= weekStart)      groups.thisWeek.push(c);
        else                                    groups.older.push(c);
      });
      const renderGroup = (label, items) => {
        if (!items.length) return '';
        return `<div class="conv-group-label">${label}</div>` +
          items.map(c => {
            const isActive = c.id === activeId;
            const isUnread = c.unread && !isActive;
            const titleStyle = isUnread ? 'font-weight: bold; color: var(--text-main);' : '';
            const unreadDot = isUnread ? `<span style="display:inline-block; width:6px; height:6px; background-color:#ff4a4a; border-radius:50%; margin-right:6px; flex-shrink:0;"></span>` : '';
            // Get project name from cache or linkedProgramId
            const projInfo = getConvProject(c.sessionId) || (c.linkedProgramId ? { program_name: c.linkedProgramId } : null);
            const programBadge = projInfo
              ? `<span class="conv-program-name" title="Project: ${escHtml(projInfo.program_name)}">${escHtml(projInfo.program_name)}</span>`
              : '';
            return `<div class="conv-item ${isActive ? 'active' : ''} ${isUnread ? 'unread' : ''}" onclick="switchConversation('${escJs(c.id)}')">
              <div class="conv-item-inner">
                <div class="conv-item-header">
                  ${unreadDot}
                  <span class="conv-item-title" style="${titleStyle}">${escHtml(c.title)}</span>
                </div>
                ${programBadge}
              </div>
              <button class="conv-delete-btn" title="Delete conversation" onclick="event.stopPropagation();deleteConvAction('${escJs(c.id)}')">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              </button>
            </div>`;
          }).join('');
      };
      list.innerHTML =
        renderGroup('Today',     groups.today) +
        renderGroup('Yesterday', groups.yesterday) +
        renderGroup('This Week', groups.thisWeek) +
        renderGroup('Older',     groups.older);
    }

    function updateConvTitleBar() {
      const conv = getActiveConv();
      const titleEl = document.getElementById('convActiveTitle');
      if (titleEl) titleEl.textContent = conv ? conv.title : 'New Chat';
      const sidEl = document.getElementById('sessionIdDisplay');
      if (sidEl && conv) sidEl.textContent = conv.id.slice(-12);
    }

    async function switchConversation(convId) {
      if (getActiveConvId() === convId) return;
      setActiveConvId(convId);
      updateConv(convId, { unread: false });
      renderConversationSidebar();
      updateConvTitleBar();
      renderMemoryBadge();
      loadConvMessages();
      if (isMobileLayout()) closeMobilePanels(false);
      await syncActiveConvHistory();
    }

    async function syncActiveConvHistory() {
      const sessionId = getActiveConvSessionId();
      if (!sessionId) return;

      const convs = loadConversations();
      const activeConv = convs.find(c => c.sessionId === sessionId);
      if (activeConv && activeConv.unread) {
        updateConv(activeConv.id, { unread: false });
        renderConversationSidebar();
      }

      try {
        const response = await api('GET', `/history?limit=100&session_id=${sessionId}`);
        console.log('[DEBUG] syncActiveConvHistory fetched response:', response);
        const chips = document.querySelectorAll('.welcome-chip');
        if (response && response.status === 'deleted') {
          console.log('[DEBUG] Server says deleted. Calling deleteConversation.');
          deleteConversation(getActiveConvId());
          const nextConv = loadConversations()[0];
          if (nextConv) switchConversation(nextConv.id);
          else newConversation();
          return;
        }

        const inputEl = document.getElementById('chatInput');
        if (sessionId && sessionId.startsWith('admin_msg_')) {
          if (inputEl) {
            inputEl.disabled = true;
            inputEl.placeholder = 'This channel is used for official communications from platform administrators. Replies are disabled.';
            inputEl.style.cursor = 'not-allowed';
          }
          chips.forEach(c => { c.style.opacity = '0.5'; c.style.cursor = 'not-allowed'; c.style.pointerEvents = 'none'; });
          // Trigger read receipt
          api('POST', '/user/admin-messages/read').catch(e => console.error(e));
        } else if (response && response.status === 'locked') {
          console.log('[DEBUG] Server says locked. Disabling input.');
          if (inputEl) {
            inputEl.disabled = true;
            inputEl.placeholder = 'Chat has been locked by admin';
            inputEl.style.cursor = 'not-allowed';
          }
          chips.forEach(c => { c.style.opacity = '0.5'; c.style.cursor = 'not-allowed'; c.style.pointerEvents = 'none'; });
        } else {
          console.log('[DEBUG] Server says active. Enabling input.');
          if (inputEl) {
            inputEl.disabled = false;
            inputEl.placeholder = 'Ask IPEM to write code, run programs, or just chat...';
            inputEl.style.cursor = 'text';
          }
          chips.forEach(c => { c.style.opacity = '1'; c.style.cursor = 'pointer'; c.style.pointerEvents = 'auto'; });
        }

        const dbHistory = response.messages || [];
        if (Array.isArray(dbHistory)) {
          saveChatHistory(dbHistory.map(r => ({ role: r.role, content: r.content, ts: new Date(r.created_at).getTime() })));
          renderMemoryBadge();
          loadConvMessages();
        }
      } catch (err) {
        console.error('[DEBUG] syncActiveConvHistory failed:', err);
      }
    }

    function loadConvMessages() {
      const messages = document.getElementById('chatMessages');
      const welcome  = document.getElementById('welcomeState');
      if (!messages) return;
      const history = loadChatHistory();
      // Clear chat
      messages.innerHTML = '';
      messages.appendChild(welcome);
      if (!history.length) {
        welcome.style.display = '';
        return;
      }
      welcome.style.display = 'none';
      history.forEach(m => addMessage(m.role === 'admin' ? 'admin' : (m.role === 'user' ? 'user' : 'ipem'), m.content, null, null, false));
      messages.scrollTop = messages.scrollHeight;
    }

    function newConversation() {
      const conv = createConversation('New Chat');
      setActiveConvId(conv.id);
      renderConversationSidebar();
      updateConvTitleBar();
      // Clear visible chat
      const messages = document.getElementById('chatMessages');
      const welcome  = document.getElementById('welcomeState');
      if (messages) { messages.innerHTML = ''; messages.appendChild(welcome); welcome.style.display = ''; }
      renderMemoryBadge();
      if (isMobileLayout()) closeMobilePanels(false);
    }

    async function deleteConvAction(convId) {
      const conv = loadConversations().find(c => c.id === convId);
      if (!conv || !await window.ipemDialog.confirm(`Delete "${conv.title}"?`, { title: 'Delete conversation', confirmText: 'Delete', danger: true })) return;
      // Clean up backend history
      api('DELETE', '/history?session_id=' + conv.sessionId).catch(() => {});
      const wasActive = getActiveConvId() === convId;
      const convs = loadConversations().filter(c => c.id !== convId);
      saveConversations(convs);
      if (wasActive) {
        // Switch to next conv or create new
        if (convs.length) {
          setActiveConvId(convs[0].id);
        } else {
          const newConv = createConversation('New Chat');
          setActiveConvId(newConv.id);
        }
        loadConvMessages();
      }
      renderConversationSidebar();
      updateConvTitleBar();
      renderMemoryBadge();
    }

    // ── AUTH ────────────────────────────────────────────────────────────────────
    function getAuthToken() { return localStorage.getItem('ipem_token'); }
    function getCurrentUser() {
      try { return JSON.parse(localStorage.getItem('ipem_user') || 'null'); }
      catch { return null; }
    }
    function clearAuth() {
      localStorage.removeItem('ipem_token');
      localStorage.removeItem('ipem_user');
    }
    async function checkAuth() {
      const token = getAuthToken();
      if (!token) { clearAuth(); renderUserInfo(); return false; }
      try {
        const data = await api('GET', '/auth/me');
        if (data?.offline) { renderUserInfo(); return true; }
        if (!data || data.error || !data.user) { clearAuth(); renderUserInfo(); return false; }
        localStorage.setItem('ipem_user', JSON.stringify(data.user));
        renderUserInfo();
        return true;
      } catch {
        renderUserInfo();
        return true;
      }
    }
    function openProfile() { window.location.href = getAuthToken() ? './profile.html' : './login.html'; }
    window.openProfile = openProfile;
    async function logout() {
      try { await api('POST', '/auth/logout'); } catch {}
      clearAuth(); window.location.href = './login.html';
    }
    window.logout = logout;
    function renderUserInfo() {
      const user = getCurrentUser();
      const avatar = document.getElementById('userAvatar');
      const nameEl = document.getElementById('userName');
      const adminLink = document.getElementById('adminPanelLink');
      const showHiddenToggle = document.getElementById('showHiddenToggle');
      const showHiddenToggleMobile = document.getElementById('showHiddenToggleMobile');

      if (adminLink) adminLink.style.display = 'none';
      if (showHiddenToggle) showHiddenToggle.style.display = 'none';
      if (showHiddenToggleMobile) showHiddenToggleMobile.style.display = 'none';

      if (!user) {
        if (avatar) avatar.textContent = 'AC';
        if (nameEl) nameEl.textContent = 'Account';
        return;
      }
      if (avatar) {
        const parts = (user.name || user.email || '?').trim().split(/\s+/).filter(Boolean);
        avatar.textContent = parts.length === 1 ? parts[0][0].toUpperCase() : (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
      }
      if (nameEl) nameEl.textContent = user.name || user.email?.split('@')[0] || 'User';

      const isAdmin = ['owner', 'admin', 'moderator'].includes(user.role);
      if (adminLink && isAdmin) {
        adminLink.style.display = 'flex';
      }
      if (showHiddenToggle && isAdmin) showHiddenToggle.style.display = 'flex';
      if (showHiddenToggleMobile && isAdmin) showHiddenToggleMobile.style.display = 'flex';
    }
    function hasClientAuthSession() {
      return !!getAuthToken();
    }
    function openAuthGateModal() {
      const modal = document.getElementById('authGateModal');
      if (!modal) return;
      modal.classList.add('open');
      document.body.classList.add('auth-gate-open');
      const primary = modal.querySelector('.auth-gate-primary');
      if (primary) setTimeout(() => primary.focus(), 80);
    }
    function closeAuthGateModal() {
      const modal = document.getElementById('authGateModal');
      if (!modal) return;
      modal.classList.remove('open');
      document.body.classList.remove('auth-gate-open');
      const input = document.getElementById('chatInput');
      if (input) input.focus();
    }
    function closeAuthGateOnBackdrop(event) {
      if (event.target === event.currentTarget) closeAuthGateModal();
    }
    function continueToAuthFlow() {
      const input = document.getElementById('chatInput');
      if (input && input.value.trim()) sessionStorage.setItem(PENDING_AUTH_DRAFT_KEY, input.value);
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `./signup.html?next=${next}`;
    }
    function restorePendingAuthDraft() {
      const draft = sessionStorage.getItem(PENDING_AUTH_DRAFT_KEY);
      if (!draft) return;
      const input = document.getElementById('chatInput');
      if (!input || input.value.trim()) return;
      input.value = draft;
      autoResize(input);
      sessionStorage.removeItem(PENDING_AUTH_DRAFT_KEY);
    }
    window.closeAuthGateModal = closeAuthGateModal;
    window.closeAuthGateOnBackdrop = closeAuthGateOnBackdrop;
    window.continueToAuthFlow = continueToAuthFlow;

    // ── LLM MODEL SELECTOR ──────────────────────────────────────────────────────
    const MODEL_STORAGE_KEY = 'ipem_selected_model';
    const AVAILABLE_MODELS = {
      fast: { label: 'Fast', icon: '⚡' },
      coder: { label: 'Coding', icon: '💻' },
      reasoning: { label: 'Reasoning', icon: '🧠' },
      analysis: { label: 'Analysis', icon: '📊' }
    };

    function getSelectedModel() {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY);
      return (saved && AVAILABLE_MODELS[saved]) ? saved : 'fast';
    }

    function updateModelPillUI(modelKey) {
      const activeKey = AVAILABLE_MODELS[modelKey] ? modelKey : 'fast';
      const model = AVAILABLE_MODELS[activeKey];
      const labelEl = document.getElementById('modelPillLabel');
      const iconEl = document.getElementById('modelPillIcon');
      if (labelEl) labelEl.textContent = model.label;
      if (iconEl) iconEl.textContent = model.icon;

      document.querySelectorAll('.model-option').forEach(el => {
        if (el.getAttribute('data-model') === activeKey) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });
    }

    function toggleModelDropdown(e) {
      if (e) {
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (typeof e.preventDefault === 'function') e.preventDefault();
      }
      const dropdown = document.getElementById('modelDropdown');
      const btn = document.getElementById('modelPillBtn');
      if (!dropdown) return;
      const isHidden = dropdown.classList.contains('hidden');
      if (isHidden) {
        dropdown.classList.remove('hidden');
        if (btn) btn.classList.add('open');
      } else {
        dropdown.classList.add('hidden');
        if (btn) btn.classList.remove('open');
      }
    }

    function selectModel(modelKey, e) {
      if (e) {
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (typeof e.preventDefault === 'function') e.preventDefault();
      }
      const targetModel = AVAILABLE_MODELS[modelKey] ? modelKey : 'fast';
      localStorage.setItem(MODEL_STORAGE_KEY, targetModel);
      updateModelPillUI(targetModel);

      const dropdown = document.getElementById('modelDropdown');
      const btn = document.getElementById('modelPillBtn');
      if (dropdown) dropdown.classList.add('hidden');
      if (btn) btn.classList.remove('open');
      notify(`Model switched to ${AVAILABLE_MODELS[targetModel].label}`, 'info');
    }

    function initModelSelector() {
      updateModelPillUI(getSelectedModel());

      document.querySelectorAll('.model-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const modelKey = opt.getAttribute('data-model') || 'fast';
          selectModel(modelKey, e);
        });
      });
    }

    window.toggleModelDropdown = toggleModelDropdown;
    window.selectModel = selectModel;
    window.getSelectedModel = getSelectedModel;

    document.addEventListener('click', (e) => {
      const wrap = document.getElementById('modelSelectorWrap');
      if (wrap && !wrap.contains(e.target)) {
        const dropdown = document.getElementById('modelDropdown');
        const btn = document.getElementById('modelPillBtn');
        if (dropdown) dropdown.classList.add('hidden');
        if (btn) btn.classList.remove('open');
      }
    });

    // ── INIT ────────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', async () => {
      initModelSelector();
      // Register Service Worker for preview proxying (ngrok bypass & asset authentication)
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
          .then(reg => {
            console.log('[Service Worker] Registered successfully:', reg.scope);
            // Trigger an immediate update check so the new SW is activated
            // as soon as the file changes, without waiting for next navigation.
            reg.update();
          })
          .catch(err => console.error('[Service Worker] Registration failed:', err));
      }

      await checkAuth();
      restorePendingAuthDraft();

      // Migrate legacy single-history to first conversation
      migrateLegacyHistory();

      // Ensure at least one conversation exists
      let convs = loadConversations();
      if (!convs.length) {
        const c = createConversation('New Chat');
        setActiveConvId(c.id);
      } else if (!getActiveConvId() || !convs.find(c => c.id === getActiveConvId())) {
        setActiveConvId(convs[0].id);
      }

      renderConversationSidebar();
      updateConvTitleBar();
      loadConvMessages();
      renderMemoryBadge();

      // Load conversation→project mappings from server (populates sidebar program name badges)
      loadConvProjectsFromServer().catch(() => {});


      syncResponsiveState();
      updateClock();
      setInterval(updateClock, 1000);
      setInterval(pollSessionStatus, 3000);
      setInterval(refreshAll, 15000);
      checkAgent();
      await checkN8n();
      setInterval(checkN8n, 10000);

      document.addEventListener('click', (e) => {
        const panel = document.getElementById('historyPanel');
        const historyTrigger = document.querySelector('.titlebar-memory');
        if (panel && panel.style.display !== 'none') {
          if (!panel.contains(e.target) && historyTrigger && !historyTrigger.contains(e.target)) closeHistoryPanel();
        }
        const menu = document.getElementById('fileContextMenu');
        if (menu && !menu.contains(e.target)) closeFileContextMenu();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('authGateModal')?.classList.contains('open')) {
          closeAuthGateModal();
          return;
        }
        if (e.key !== 'Escape') return;
        closeFileContextMenu(); closeHistoryPanel(); closeMobilePanels(false);
      });
      window.addEventListener('resize', syncResponsiveState);

      // Load history for active conversation from server DB
      await syncActiveConvHistory();
    });

    function migrateLegacyHistory() {
      try {
        const legacy = localStorage.getItem(LEGACY_HISTORY_KEY);
        if (!legacy) return;
        const messages = JSON.parse(legacy);
        if (!Array.isArray(messages) || !messages.length) { localStorage.removeItem(LEGACY_HISTORY_KEY); return; }
        // Put in current active conv if it's empty, otherwise create new
        const conv = getActiveConv();
        if (conv && !conv.messages.length) {
          updateConv(conv.id, { messages, title: 'Migrated Chat' });
        } else {
          const newConv = createConversation('Migrated Chat');
          updateConv(newConv.id, { messages });
        }
        localStorage.removeItem(LEGACY_HISTORY_KEY);
        localStorage.removeItem('ipem_session_id');
      } catch {}
    }

    window.addEventListener('beforeunload', (event) => {
      if (!editorState.dirty) return;
      event.preventDefault(); event.returnValue = '';
    });

    // ── CLOCK & RESPONSIVE ──────────────────────────────────────────────────────
    function updateClock() { document.getElementById('sb-time').textContent = new Date().toLocaleTimeString(); }
    function isMobileLayout() { return window.innerWidth <= MOBILE_BREAKPOINT; }
    function closeHistoryPanel() { const p = document.getElementById('historyPanel'); if (p) p.style.display = 'none'; }
    function closeMobilePanels(closeHistory = false) {
      document.body.classList.remove('mobile-sidebar-open', 'mobile-explorer-open');
      if (closeHistory) closeHistoryPanel();
    }
    function syncResponsiveState() {
      const mobile = isMobileLayout();
      document.body.classList.toggle('is-mobile', mobile);
      if (!mobile) closeMobilePanels(false);
    }

    // ── API ─────────────────────────────────────────────────────────────────────
    async function api(method, path, body = null) {
      const token = getAuthToken();
      const headers = {
        ...(window.IPEM_CONFIG?.DEFAULT_REQUEST_HEADERS || {}),
        'Content-Type': 'application/json'
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (method === 'GET') {
        path += (path.includes('?') ? '&' : '?') + 't=' + Date.now();
      }
      const opts = { method, headers, credentials: 'include' };
      if (body && method !== 'GET') opts.body = JSON.stringify(body);
      let res;
      try {
        res = await fetch(API_BASE + path, opts);
      } catch {
        return { error: 'NETWORK_ERROR', offline: true, message: 'Backend unavailable' };
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      if (res.status === 401) {
        clearAuth();
        renderUserInfo();
        return data || { error: 'UNAUTHORIZED', message: 'Authentication required' };
      }
      return data;
    }
    async function apiExternal(method, url, body) {
      try {
        const opts = { method, headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const r = await fetch(url, opts);
        return await r.json();
      } catch { return null; }
    }
    async function checkN8n() {
      try { const r = await api('GET', '/n8n-health'); updateWebhookRuntimeStatus(r?.status); }
      catch { updateWebhookRuntimeStatus(false); }
    }
    async function checkWebhookOnline() { const r = await api('GET', '/webhook-status'); return !!(r && r.status); }
    function extractResponseText(r) {
      if (!r) return '';
      const t = r.output || r.message || r.text || r.response || JSON.stringify(r);
      return typeof t === 'string' ? t : JSON.stringify(t);
    }
    function isDirectModeResponse(r) {
      const t = extractResponseText(r);
      return t.startsWith('[Direct mode]') || t.includes('To enable full AI responses');
    }
    function updateWebhookRuntimeStatus(isOnline) { webhookRuntimeOnline = !!isOnline; renderWebhookStatus(webhookRuntimeOnline); }
    function escJs(str) { return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
    function isDeletePending(key) { return deleteRequests.has(key); }
    function isRunnableFile(fn) { return RUNNABLE_FILE_EXTENSIONS.has((fn || '').split('.').pop().toLowerCase()); }
    function getPrimaryRunnableFile(p) { if (!p || !Array.isArray(p.files)) return ''; return p.files.find(isRunnableFile) || ''; }
    function hasFileInState(pn, fn) { const p = allPrograms.find(x => x.program_name === pn); return !!(p && Array.isArray(p.files) && p.files.includes(fn)); }
    function closeFileContextMenu() { const m = document.getElementById('fileContextMenu'); if (m) m.classList.remove('open'); fileContextTarget = null; }
    function updateModalActionsState() {
      const runBtn = document.getElementById('modalRunBtn');
      const deleteBtn = document.getElementById('modalDeleteBtn');
      const fileKey = modalProgram ? `file:${modalProgram.programName}:${modalProgram.filename}` : '';
      if (runBtn) runBtn.disabled = !!(modalProgram && !isRunnableFile(modalProgram.filename));
      if (deleteBtn) deleteBtn.disabled = !modalProgram || isDeletePending(fileKey);
    }
    function syncStateAfterProgramDeletion(programName) {
      if (activeSession && activeSession.program_name === programName) { activeSession = null; updateSessionUI(); }
      if (selectedProgram === programName) selectedProgram = null;
      if (editorState.open && editorState.programName === programName) closeEditor(true);
      if (modalProgram && modalProgram.programName === programName) closeModalDirect();
      const state = loadExpandedFolders();
      delete state[programName];
      saveExpandedFolders(state);
    }
    function syncStateAfterFileDeletion(programName, filename) {
      if (activeSession && activeSession.program_name === programName && activeSession.filename === filename) { activeSession = null; updateSessionUI(); }
      if (editorState.open && editorState.programName === programName && editorState.filename === filename) closeEditor(true);
      if (modalProgram && modalProgram.programName === programName && modalProgram.filename === filename) closeModalDirect();
    }
    async function refreshProgramsView() {
      await loadPrograms();
      if (currentExplorerTab === 'files') await loadFileTree();
      if (currentExplorerTab === 'sessions') await loadSessionsPanel();
    }

    // ── EDITOR ──────────────────────────────────────────────────────────────────
    function getEditorLanguage(fn) {
      return { py:'python',js:'javascript',ts:'typescript',java:'java',go:'go',rs:'rust',cpp:'cpp',c:'c',rb:'ruby',php:'php',json:'json',html:'html',css:'css',md:'markdown',txt:'plaintext' }[(fn||'').split('.').pop().toLowerCase()] || 'plaintext';
    }
    function setEditorLoading(state, text) {
      editorState.loading = !!state;
      const loading = document.getElementById('editorLoading'); const loadingText = document.getElementById('editorLoadingText');
      if (loading) loading.classList.toggle('hidden', !state);
      if (loadingText && text) loadingText.textContent = text;
    }
    function updateEditorChrome() {
      const nameEl = document.getElementById('editorFileName'); const stateEl = document.getElementById('editorDirtyState');
      const saveBtn = document.getElementById('editorSaveBtn'); const runBtn = document.getElementById('editorRunBtn');
      const deleteBtn = document.getElementById('editorDeleteBtn'); const emptyState = document.getElementById('editorEmptyState');
      const hasFile = !!(editorState.programName && editorState.filename);
      if (nameEl) nameEl.textContent = hasFile ? `${editorState.programName}/${editorState.filename}` : 'No file selected';
      if (stateEl) { stateEl.textContent = editorState.dirty ? 'Unsaved changes' : 'Saved'; stateEl.classList.toggle('dirty', editorState.dirty); }
      if (saveBtn) saveBtn.disabled = !editorState.dirty || editorState.saving || !hasFile;
      if (runBtn) runBtn.disabled = !hasFile || !isRunnableFile(editorState.filename);
      if (deleteBtn) deleteBtn.disabled = !hasFile || isDeletePending(`file:${editorState.programName}:${editorState.filename}`);
      if (emptyState) emptyState.classList.toggle('hidden', !!(hasFile && monacoEditor));
    }
    function setEditorDirtyState(isDirty) { editorState.dirty = !!isDirty; updateEditorChrome(); }
    async function ensureMonacoEditor() {
      if (monacoEditor) return monacoEditor;
      if (!monacoReady) {
        monacoReady = new Promise((resolve, reject) => {
          if (!window.require) { reject(new Error('Monaco loader unavailable')); return; }
          window.require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs' } });
          window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
        });
      }
      const monaco = await monacoReady;
      monaco.editor.defineTheme('ipem-dark', { base:'vs-dark', inherit:true, rules:[],
        colors: { 'editor.background':'#0a0a0f','editorLineNumber.foreground':'#5a5a72','editorLineNumber.activeForeground':'#a394ff','editorCursor.foreground':'#3dd68c','editor.selectionBackground':'#3b2f7c','editor.inactiveSelectionBackground':'#2a234f','editorIndentGuide.background1':'#1f1f30','editorIndentGuide.activeBackground1':'#3b3b57' }
      });
      editorModel = monaco.editor.createModel('', 'plaintext');
      monacoEditor = monaco.editor.create(document.getElementById('editorPane'), {
        model: editorModel, theme: 'ipem-dark', automaticLayout: true, minimap: { enabled: false },
        fontFamily: 'JetBrains Mono, monospace', fontSize: 13, lineHeight: 22, scrollBeyondLastLine: false,
        roundedSelection: true, padding: { top: 16, bottom: 16 }, tabSize: 2, insertSpaces: true
      });
      monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveEditorFile);
      monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => monacoEditor.trigger('keyboard','undo',null));
      monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => monacoEditor.trigger('keyboard','redo',null));
      editorModel.onDidChangeContent(() => { if (!editorState.open || editorState.loading) return; setEditorDirtyState(editorModel.getValue() !== editorState.originalContent); });
      updateEditorChrome();
      return monacoEditor;
    }
    async function confirmEditorExit(reason) {
      if (!editorState.dirty) return true;
      return window.ipemDialog.confirm(`You have unsaved changes. ${reason}`, {
        title: 'Unsaved changes', confirmText: 'Discard changes', cancelText: 'Keep editing', danger: true
      });
    }
    function enterEditorMode() { document.getElementById('chatWorkspace').classList.add('hidden'); document.getElementById('editorWorkspace').classList.remove('hidden'); editorState.open = true; updateEditorChrome(); }
    function resetEditorState() { editorState = { open:false,loading:false,saving:false,programName:null,filename:null,originalContent:'',dirty:false }; if (editorModel) editorModel.setValue(''); updateEditorChrome(); }
    function leaveEditorMode() { document.getElementById('editorWorkspace').classList.add('hidden'); document.getElementById('chatWorkspace').classList.remove('hidden'); editorViewState = monacoEditor ? monacoEditor.saveViewState() : null; resetEditorState(); }
    async function openEditor(programName, filename) {
      if (!filename) {
        const p = allPrograms.find(x => x.program_name === programName);
        if (p && Array.isArray(p.files)) {
          const showHidden = typeof showHiddenFilesState !== 'undefined' ? showHiddenFilesState : false;
          const visibleFiles = p.files.filter(f => !isHiddenFile(f, showHidden));
          filename = getPrimaryRunnableFile({ files: visibleFiles }) || visibleFiles[0] || '';
        } else {
          filename = '';
        }
      }
      if (!filename) { notify('No file available to open', 'error'); return; }
      if (editorState.open && (editorState.programName !== programName || editorState.filename !== filename)) { if (!await confirmEditorExit('Open another file?')) return; }
      selectedProgram = programName; closeMobilePanels(false); enterEditorMode(); setEditorLoading(true, 'Loading editor...');
      try {
        await ensureMonacoEditor();
        const data = await api('GET', `/read/${programName}/${filename}`);
        if (!data || data.error || typeof data.code !== 'string') { notify(data?.message || 'Could not load file', 'error'); leaveEditorMode(); return; }
        editorState.programName = programName; editorState.filename = filename; editorState.originalContent = data.code; editorState.dirty = false;
        monaco.editor.setModelLanguage(editorModel, getEditorLanguage(filename));
        editorState.loading = true; editorModel.setValue(data.code);
        if (editorViewState) monacoEditor.restoreViewState(editorViewState);
        monacoEditor.focus(); editorState.loading = false; updateEditorChrome();
      } catch (err) { notify(`Editor failed to load: ${err.message}`, 'error'); leaveEditorMode(); }
      finally { setEditorLoading(false); }
    }
    async function closeEditor(force = false) { if (!force && !await confirmEditorExit('Close the editor and discard them?')) return false; leaveEditorMode(); return true; }
    async function saveEditorFile() {
      if (!editorState.open || !editorState.programName || !editorState.filename || !editorState.dirty || editorState.saving) { if (editorState.open && !editorState.dirty) notify('No changes to save','info'); return; }
      editorState.saving = true; updateEditorChrome();
      try {
        const content = editorModel ? editorModel.getValue() : '';
        const response = await api('PUT', `/api/program/${encodeURIComponent(editorState.programName)}/file/${encodeURIComponent(editorState.filename)}`, { content });
        if (!response) { notify('Network error while saving file','error'); return; }
        if (response.error) { if (response.error==='FILE_NOT_FOUND') { notify('File no longer exists','error'); closeEditor(true); await refreshProgramsView(); return; } notify(response.message||'Could not save file','error'); return; }
        editorState.originalContent = content; setEditorDirtyState(false); notify('File saved','success'); await refreshProgramsView();
      } finally { editorState.saving = false; updateEditorChrome(); }
    }
    async function runFromEditor() {
      if (!editorState.open || !editorState.programName || !editorState.filename) return;
      if (editorState.dirty && !await confirmEditorExit('Run the last saved version instead?')) return;
      const { programName, filename } = editorState; closeEditor(true); await startProgram(programName, filename);
    }
    async function deleteCurrentEditorFile() {
      if (!editorState.open || !editorState.programName || !editorState.filename) return;
      const { programName, filename } = editorState; closeEditor(true); await deleteProgramFileAction(programName, filename);
    }

    // ── AGENT / REFRESH ─────────────────────────────────────────────────────────
    async function checkAgent() {
      const r = await api('GET', '/health');
      const dot = document.getElementById('agentDot'); const status = document.getElementById('agentStatus'); const endpointStatus = document.getElementById('endpointStatus');
      if (r && r.status) {
        dot.style.background = 'var(--green)'; dot.style.animation = 'pulse 2s infinite'; status.textContent = 'Agent online';
        if (endpointStatus) { endpointStatus.textContent = 'Server: online'; endpointStatus.style.color = 'var(--green)'; }
        setSbStatus('* Connected', 'var(--green)'); loadPrograms(); loadExplorerContent();
      } else {
        dot.style.background = 'var(--red)'; dot.style.animation = 'none'; status.textContent = 'Agent offline';
        if (endpointStatus) { endpointStatus.textContent = 'Server: offline'; endpointStatus.style.color = 'var(--red)'; }
        setSbStatus('* Offline', 'var(--red)');
      }
      renderWebhookStatus(webhookRuntimeOnline);
    }
    async function refreshAll() { await checkAgent(); await loadPrograms(); await loadExplorerContent(); await pollSessionStatus(); loadConvProjectsFromServer().catch(() => {}); }


    // ── PROGRAMS ────────────────────────────────────────────────────────────────
    async function loadPrograms() {
      const data = await api('GET', '/programs');
      if (!data || !Array.isArray(data)) return;
      allPrograms = data;
      if (selectedProgram && !allPrograms.some(p => p.program_name === selectedProgram)) selectedProgram = null;
      if (editorState.open && !hasFileInState(editorState.programName, editorState.filename)) { notify('Open file was removed','info'); closeEditor(true); }
      if (modalProgram && !hasFileInState(modalProgram.programName, modalProgram.filename)) closeModalDirect();
      document.getElementById('sb-programs').textContent = data.length + ' programs';
    }
    // No longer renders a programs sidebar — programs appear in explorer
    function applyProgramFilter() {} // no-op (no programs sidebar)

    async function quickRun(n) { if (isMobileLayout()) closeMobilePanels(false); sendQuick('run ' + n); }
    async function quickStop(n) {
      if (!activeSession) return;
      const r = await api('POST', '/execute/stop/' + activeSession.session_id);
      if (r) { activeSession = null; updateSessionUI(); notify('Program stopped','info'); await loadPrograms(); }
    }
    async function stopCurrentSession() {
      if (!activeSession) return;
      const r = await api('POST', '/execute/stop/' + activeSession.session_id);
      if (r) { activeSession = null; updateSessionUI(); addMessage('ipem','Program stopped.','casual',null,true); await loadPrograms(); }
    }
    async function deleteProgramAction(programName) {
      const key = `program:${programName}`;
      if (isDeletePending(key)) return;
      if (!await window.ipemDialog.confirm(`Delete program "${programName}" and all its files?`, { title: 'Delete program', confirmText: 'Delete', danger: true })) return;
      deleteRequests.add(key);
      try {
        const response = await api('DELETE', `/api/program/${encodeURIComponent(programName)}`);
        if (!response) { notify('Network error while deleting program','error'); return; }
        if (response.error && response.error !== 'PROGRAM_NOT_FOUND') { notify(response.message||'Could not delete program','error'); return; }
        syncStateAfterProgramDeletion(programName);
        if (response.invalidated_sessions?.length) notify('Running session stopped before deletion','info');
        allPrograms = allPrograms.filter(p => p.program_name !== programName);
        document.getElementById('sb-programs').textContent = allPrograms.length + ' programs';
        if (currentExplorerTab === 'files') await loadFileTree();
        if (currentExplorerTab === 'sessions') await loadSessionsPanel();
        notify(response.error === 'PROGRAM_NOT_FOUND' ? 'Program already deleted' : 'Program deleted','success');
      } finally { deleteRequests.delete(key); updateModalActionsState(); }
    }
    async function deleteProgramFileAction(programName, filename) {
      const key = `file:${programName}:${filename}`;
      if (isDeletePending(key)) return;
      if (!await window.ipemDialog.confirm(`Delete file "${filename}" from "${programName}"?`, { title: 'Delete file', confirmText: 'Delete', danger: true })) return;
      deleteRequests.add(key); updateModalActionsState(); closeFileContextMenu();
      try {
        const response = await api('DELETE', `/api/program/${encodeURIComponent(programName)}/file/${encodeURIComponent(filename)}`);
        if (!response) { notify('Network error while deleting file','error'); return; }
        if (response.error && response.error !== 'FILE_NOT_FOUND') { notify(response.message||'Could not delete file','error'); return; }
        syncStateAfterFileDeletion(programName, filename);
        if (response.invalidated_sessions?.length) notify('Running session stopped before deletion','info');
        const program = allPrograms.find(x => x.program_name === programName);
        if (program && Array.isArray(program.files)) { program.files = program.files.filter(x => x !== filename); const next = getPrimaryRunnableFile(program); program.language = next ? next.split('.').pop() : null; }
        if (currentExplorerTab === 'files') await loadFileTree();
        if (currentExplorerTab === 'sessions') await loadSessionsPanel();
        notify(response.error === 'FILE_NOT_FOUND' ? 'File already deleted' : 'File deleted','success');
      } finally { deleteRequests.delete(key); updateModalActionsState(); }
    }
    async function viewProgram(pn, fn) { return openEditor(pn, fn); }
    function closeModal(e) { if (e.target === document.getElementById('codeModal')) closeModalDirect(); }
    function closeModalDirect() { document.getElementById('codeModal').classList.remove('open'); modalProgram = null; }
    function runFromModal() { if (!modalProgram) return; const cur = modalProgram; closeModalDirect(); startProgram(cur.programName, cur.filename); }
    function deleteCurrentModalFile() { if (modalProgram) deleteProgramFileAction(modalProgram.programName, modalProgram.filename); }

    // ── EXPLORER: ALL PROGRAMS TREE ─────────────────────────────────────────────
    // Cache to avoid re-fetching unchanged data
    let _explorerCache = { programs: null, ts: 0 };
    const EXPLORER_CACHE_TTL = 8000; // 8s

    function switchExplorerTab(tab) {
      currentExplorerTab = tab;
      document.querySelectorAll('.explorer-tab').forEach(el => el.classList.toggle('active', el.textContent.toLowerCase() === tab));
      loadExplorerContent();
    }
    async function loadExplorerContent() {
      if (currentExplorerTab === 'files') await loadFileTree();
      else if (currentExplorerTab === 'memory') await loadMemoryPanel();
      else if (currentExplorerTab === 'sessions') await loadSessionsPanel();
    }

    async function loadFileTree() {
      const content = getExplorerContentElement();
      if (!content) return;
      // Use cached programs if fresh enough
      let programs = allPrograms;
      if (!programs.length) {
        const data = await api('GET', '/programs');
        if (data && Array.isArray(data)) { programs = data; allPrograms = data; }
      }
      if (!programs.length) { content.innerHTML = '<div class="programs-empty">No programs yet</div>'; return; }

      const expandedFolders = loadExpandedFolders();

      // Build collapsible tree: ALL programs + files
      content.innerHTML = programs.map(p => {
        const showHidden = typeof showHiddenFilesState !== 'undefined' ? showHiddenFilesState : false;
        const files = (p.files || []).filter(f => !isHiddenFile(f, showHidden));
        const primaryFile = getPrimaryRunnableFile({ ...p, files });
        const lang = p.language || (primaryFile ? primaryFile.split('.').pop() : '');
        const isRunning = activeSession && activeSession.program_name === p.program_name;
        const linkedConv = getConvByProgram(p.program_name);
        const deleting = isDeletePending(`program:${p.program_name}`);
        const isExpanded = !!expandedFolders[p.program_name];

        return `<div class="prog-tree-item">
          <div class="prog-tree-header" onclick="toggleProgramFolder('${escJs(p.program_name)}')">
            <svg class="prog-tree-chevron" id="chev-${escJs(p.program_name)}" style="${isExpanded ? 'transform: rotate(90deg);' : ''}" width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="file-icon">${lang === 'py' || lang === 'python' ? '🐍' : lang === 'js' || lang === 'javascript' ? '🟡' : '📁'}</span>
            <span class="prog-tree-name ${isRunning ? 'running' : ''}">${p.program_name}</span>
            ${isRunning ? '<div class="running-indicator" style="margin-left:auto;margin-right:4px;"></div>' : ''}
            <div class="prog-tree-actions">
              <button class="prog-btn prog-btn-run" style="padding:2px 6px;font-size:9px;" ${!primaryFile||deleting?'disabled':''} onclick="event.stopPropagation();quickRun('${escJs(p.program_name)}')">Run</button>
              ${linkedConv ? `<button class="prog-btn prog-btn-view" style="padding:2px 6px;font-size:9px;" onclick="event.stopPropagation();switchConversation('${escJs(linkedConv.id)}')">Chat</button>` : ''}
              <button class="prog-btn prog-btn-delete" style="padding:2px 6px;font-size:9px;" ${deleting?'disabled':''} onclick="event.stopPropagation();deleteProgramAction('${escJs(p.program_name)}')">${deleting?'…':'Del'}</button>
            </div>
          </div>
          <div class="prog-tree-files ${isExpanded ? '' : 'hidden'}" id="files-${escJs(p.program_name)}">
            ${files.length
              ? files.map(f => `<div class="file-tree-item indent" ondblclick="openEditor('${escJs(p.program_name)}','${escJs(f)}')" oncontextmenu="openFileContextMenu(event,'${escJs(p.program_name)}','${escJs(f)}')"><span class="file-icon">${fileIcon(f)}</span>${f}</div>`).join('')
              : '<div class="programs-empty" style="padding:8px 20px;font-size:11px;">No files</div>'}
          </div>
        </div>`;
      }).join('');
    }

    function toggleProgramFolder(programName) {
      const files = document.getElementById(`files-${programName}`);
      const chev  = document.getElementById(`chev-${programName}`);
      if (!files) return;
      const isHidden = files.classList.contains('hidden');

      const state = loadExpandedFolders();
      if (isHidden) {
        files.classList.remove('hidden');
        if (chev) chev.style.transform = 'rotate(90deg)';
        selectedProgram = programName;
        state[programName] = true;
      } else {
        files.classList.add('hidden');
        if (chev) chev.style.transform = '';
        state[programName] = false;
      }
      saveExpandedFolders(state);
    }

    function fileIcon(f) {
      return { py:'🐍',js:'🟡',ts:'🔷',go:'🐹',rs:'🦀',java:'☕',cpp:'⚡',c:'⚡',rb:'💎',php:'🐘',json:'📋',txt:'📄' }[f.split('.').pop()] || '📄';
    }
    function openFileContextMenu(event, programName, filename) {
      event.preventDefault(); fileContextTarget = { programName, filename };
      const menu = document.getElementById('fileContextMenu');
      if (!menu) return;
      document.getElementById('ctxRunBtn').disabled = !isRunnableFile(filename);
      document.getElementById('ctxDeleteBtn').disabled = isDeletePending(`file:${programName}:${filename}`);
      menu.style.left = `${event.clientX}px`; menu.style.top = `${event.clientY}px`; menu.classList.add('open');
    }
    function handleFileContextAction(action) {
      if (!fileContextTarget) return;
      const target = fileContextTarget; closeFileContextMenu();
      if (action === 'view') openEditor(target.programName, target.filename);
      else if (action === 'run') startProgram(target.programName, target.filename);
      else if (action === 'delete') deleteProgramFileAction(target.programName, target.filename);
    }
    async function loadMemoryPanel() {
      const data = await api('GET', '/memory'); const content = getExplorerContentElement();
      if (!content) return;
      if (!data) { content.innerHTML = '<div class="programs-empty">Could not load memory</div>'; return; }
      const entries = Object.entries(data);
      if (!entries.length) { content.innerHTML = '<div class="programs-empty">No facts stored yet</div>'; return; }
      content.innerHTML = '<div class="section-label">Stored Facts</div>' +
        entries.map(([k,v]) => `<div class="memory-item"><div class="memory-item-key">${k}</div><div class="memory-item-val">${typeof v === 'object' ? JSON.stringify(v) : v}</div></div>`).join('');
    }
    async function loadSessionsPanel() {
      const data = await api('GET', '/execute/sessions'); const content = getExplorerContentElement();
      if (!content) return;
      if (!data || !data.length) { content.innerHTML = '<div class="programs-empty">No active sessions</div>'; return; }
      content.innerHTML = '<div class="section-label">Active Sessions</div>' +
        data.map(s => `<div class="session-item ${s.running?'running':''}">
          <div class="session-item-header"><span class="session-name">${s.program_name}</span><span class="session-status ${s.running?'running':'stopped'}">${s.running?'LIVE':'DONE'}</span></div>
          <div class="session-meta">${s.session_id.slice(0,24)}...</div>
          ${s.running?`<button class="prog-btn prog-btn-stop" style="margin-top:6px;width:100%;" onclick="quickStopSession('${s.session_id}')">Stop Session</button>`:''}
        </div>`).join('');
    }
    async function quickStopSession(id) { await api('POST','/execute/stop/'+id); notify('Session stopped','info'); await loadSessionsPanel(); await pollSessionStatus(); }

    // ── SESSION POLLING ─────────────────────────────────────────────────────────
    async function pollSessionStatus() {
      try {
        const sessions = await api('GET', '/execute/sessions');
        activeSession = (sessions && sessions.length) ? (sessions.find(s => s.running) || null) : null;
        updateSessionUI();
        if (currentExplorerTab === 'sessions') loadSessionsPanel();

        // Check for admin messages
        if (hasClientAuthSession()) {
          const adminStatus = await api('GET', '/user/admin-messages/status');
          if (adminStatus) {
            if (adminStatus.deletedConvs && adminStatus.deletedConvs.length > 0) {
              adminStatus.deletedConvs.forEach(sessionId => {
                removeConversationLocally(sessionId);
              });
            }
            if (adminStatus.lockedConvs && adminStatus.lockedConvs.length > 0) {
              let changed = false;
              adminStatus.lockedConvs.forEach(sessionId => {
                const convs = loadConversations();
                const conv = convs.find(c => c.sessionId === sessionId);
                if (conv && conv.status !== 'locked') {
                  updateConv(conv.id, { status: 'locked' });
                  changed = true;
                  if (getActiveConvSessionId() === sessionId) {
                    syncActiveConvHistory(); // force UI update
                  }
                }
              });
              if (changed) renderConversationSidebar();
            }

            if (adminStatus.activeConvs && adminStatus.activeConvs.length > 0) {
              adminStatus.activeConvs.forEach(dbConv => {
                const convs = loadConversations();
                const conv = convs.find(c => c.sessionId === dbConv.session_id);
                if (conv) {
                  const localMsgCount = (conv.messages || []).length;
                  if (dbConv.message_count > localMsgCount) {
                    if (getActiveConvSessionId() === dbConv.session_id) {
                      syncActiveConvHistory();
                    }
                  }
                }
              });
            }

            if (adminStatus.unreadCount > 0) {
              const userContext = getCurrentUser();
              if (userContext) {
                const adminConvId = 'admin_msg_' + userContext.id;

                // Look for existing admin conversation locally
                let convs = loadConversations();
                let adminConv = convs.find(c => c.sessionId === adminConvId);

                if (!adminConv) {
                  adminConv = createConversation('Administrator Messages', adminConvId);
                  adminConv.status = 'active'; // Admin messages aren't locked by default
                  updateConv(adminConv.id, { status: 'active' });
                  renderConversationSidebar();
                }

                // Immediately switch to the Administration Messages conversation
                if (getActiveConvSessionId() !== adminConvId) {
                  updateConv(adminConv.id, { unread: true });
                  switchConversation(adminConv.id);
                } else {
                  syncActiveConvHistory();
                }
              }
            } else {
              const appTitle = document.getElementById('appTitle');
              if (appTitle && appTitle.textContent.includes('🔴')) {
                appTitle.textContent = 'IPEM';
              }
            }
          }
        }
      } catch (err) {
        console.error('Poll error', err);
      }
    }
    function updateSessionUI() {
      const banner = document.getElementById('activeSessionBanner'); const hint = document.getElementById('sessionHint');
      const modeHint = document.getElementById('modeHint'); const sb = document.getElementById('sb-session');
      if (activeSession) {
        banner.classList.remove('hidden');
        document.getElementById('activeSessionText').textContent = `${activeSession.program_name} · ${activeSession.session_id.slice(-8)}`;
        if (activeSession.waiting_for_input) { hint.classList.remove('hidden'); modeHint.textContent = 'Input mode'; modeHint.style.color = 'var(--blue)'; }
        else { hint.classList.add('hidden'); modeHint.textContent = 'Session active'; modeHint.style.color = 'var(--green)'; }
        sb.textContent = `Session: ${activeSession.program_name}`;
      } else {
        banner.classList.add('hidden'); hint.classList.add('hidden');
        modeHint.textContent = 'Chat mode'; modeHint.style.color = '';
        sb.textContent = 'No active session';
      }
    }

    // ── CHAT ────────────────────────────────────────────────────────────────────
    function handleKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
    function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; }

    async function sendMessage() {
      const inputEl = document.getElementById('chatInput');
      if (!inputEl) return;
      if (inputEl.disabled) return;
      const text = inputEl.value.trim();
      if (!text || isWaiting) return;
      if (!hasClientAuthSession()) {
        sessionStorage.setItem(PENDING_AUTH_DRAFT_KEY, inputEl.value);
        openAuthGateModal();
        return;
      }
      inputEl.value = ''; inputEl.style.height = '';
      hideWelcome();

      // Ensure active conversation exists
      if (!getActiveConvId() || !loadConversations().find(c => c.id === getActiveConvId())) {
        const c = createConversation('New Chat'); setActiveConvId(c.id);
        renderConversationSidebar(); updateConvTitleBar();
      }
      const convId = getActiveConvId();
      const isFirstMessage = loadChatHistory().length === 0;

      pushHistory('user', text);
      renderMemoryBadge();
      api('POST', '/history', { session_id: getActiveConvSessionId(), role: 'user', content: text });

      addMessage('user', text, null, null, true);
      setWaiting(true, text);

      const priorContext = buildContextArray().slice(0, -1);
      const contextString = buildContextString().split('\n').slice(0, -1).join('\n');

      const payload = {
        chatInput: text,
        message: text,
        sessionId: getActiveConvSessionId(),
        history: priorContext,
        context: contextString,
        model: getSelectedModel(),
        supportsAsyncChatJobs: true
      };

      let r = null;
      try { r = await api('POST', '/chat', payload); } catch (err) { console.error('API error:', err); }

      if (r === null || typeof r === 'undefined' || r.offline) {
        setWaiting(false);
        notify('⚠️ Failed to reach backend','error');
        return;
      }

      // If async job was queued, poll until completion
      if (r.pending && r.jobId) {
        r = await pollChatJob(r.jobId);
      }

      setWaiting(false);
      if (!r || r.offline) { notify('⚠️ Generation request failed', 'error'); return; }

      const assistantText = extractResponseText(r);
      if (!assistantText || assistantText === '""') { notify('Backend returned an empty chat response','error'); return; }
      updateWebhookRuntimeStatus(!isDirectModeResponse(r));

      pushHistory('assistant', assistantText);
      renderMemoryBadge();
      api('POST', '/history', { session_id: getActiveConvSessionId(), role: 'assistant', content: assistantText });

      // Auto-title on first exchange and refresh after later topic shifts.
      autoTitleConversation(convId, r, text);

      await handleN8NResponse(r, text);
    }

    async function pollChatJob(jobId) {
      const startTime = Date.now();
      const maxPollTime = 1800000; // 30 minutes max polling duration

      while (Date.now() - startTime < maxPollTime) {
        await new Promise(res => setTimeout(res, 2000));
        try {
          let jobRes = await api('GET', '/chat/job/' + jobId);
          if (typeof jobRes === 'string') {
            try { jobRes = JSON.parse(jobRes); } catch {}
          }
          if (jobRes && jobRes.ok) {
            if (jobRes.status === 'completed') {
              let resPayload = jobRes.result;
              if (typeof resPayload === 'string') {
                try { resPayload = JSON.parse(resPayload); } catch {}
              }
              return resPayload;
            }
            if (jobRes.status === 'failed') {
              return { output: `⚠️ Job failed: ${jobRes.error || 'Unknown error'}` };
            }
          }
        } catch (err) {
          console.warn('[Job Polling] Polling error:', err.message);
        }
      }
      return { output: '⏱️ Generation timed out after 30 minutes.' };
    }

    function sendQuick(text) { document.getElementById('chatInput').value = text; sendMessage(); }

    async function handleDirectAPI(userText) {
      updateWebhookRuntimeStatus(false);
      const lower = userText.toLowerCase();
      if (activeSession && activeSession.waiting_for_input) {
        const r = await api('POST', '/execute/input', { session_id: activeSession.session_id, input: userText });
        if (r) { renderExecutionResponse(r, true); await pollSessionStatus(); if (currentExplorerTab === 'sessions') loadSessionsPanel(); }
        else addMessage('ipem','Failed to send input to session.','casual',null,true);
        return;
      }
      if (lower === 'run it' || lower === 'run last' || lower === 'run') {
        const last = await api('GET', '/last-program');
        if (last && last.program_name) await startProgram(last.program_name, last.filename);
        else addMessage('ipem','No program to run. Generate one first!','casual',null,true);
        return;
      }
      const runMatch = lower.match(/^run\s+(\S+)/);
      if (runMatch) { await startProgram(runMatch[1]); return; }
      if (lower.includes('list') || lower.includes('programs') || lower.includes('what have')) {
        const programs = await api('GET', '/programs');
        if (programs && programs.length) addMessage('ipem',`Here are your programs:\n\n${programs.map((p,i)=>`${i+1}. ${p.program_name} (${p.language||'unknown'})`).join('\n')}`, 'casual',null,true);
        else addMessage('ipem','No programs yet.','casual',null,true);
        return;
      }
      if (lower.includes('memory') || lower.includes('what do you know') || lower.includes('my name')) {
        const mem = await api('GET', '/memory');
        if (mem && Object.keys(mem).length) renderMemoryMessage(mem);
        else addMessage('ipem',"I don't have any facts stored yet.",'casual',null,true);
        return;
      }
      if (lower === 'stop' || lower === 'cancel' || lower === 'kill') {
        if (activeSession) { await api('POST','/execute/stop/'+activeSession.session_id); activeSession = null; updateSessionUI(); addMessage('ipem','Program stopped.','casual',null,true); }
        else addMessage('ipem','No active session to stop.','casual',null,true);
        return;
      }
      addMessage('ipem',`n8n is unavailable right now.\n\nDirect mode: "run it", "list programs", "show memory", "stop"`,'casual',null,true);
    }

    async function startProgram(programName, filename) {
      if (isMobileLayout()) closeMobilePanels(false);
      addMessage('ipem', `Starting ${programName}...`, 'run', null, true);
      const r = await api('POST', '/execute/start', { program_name: programName, filename: filename || undefined });
      if (!r) { addMessage('ipem','Failed to start program.','casual',null,true); notify('Network error while starting program','error'); return; }
      if (r.error) {
        const message = r.error === 'FILE_DELETED' ? 'Execution failed because the file was removed.' : (r.message || 'Failed to start program.');
        addMessage('ipem', message, 'casual', null, true); notify(message, 'error');
        await refreshProgramsView(); await pollSessionStatus(); return;
      }

      // Link program to current conversation
      const convId = getActiveConvId();
      if (convId) linkProgramToConv(convId, programName);

      renderExecutionResponse(r, false);
      await pollSessionStatus(); await loadPrograms();
      if (currentExplorerTab === 'sessions') loadSessionsPanel();
      if (currentExplorerTab === 'files') loadFileTree();

      // ── PREVIEW DETECTION ──────────────────────────────────────────────────
      if (r.preview && r.preview_url && !r.error) {
        // Await the resolved backend base URL to avoid race condition where
        // API_BASE is still '/api' while the /backend-info fetch is in flight.
        const base = await resolvedApiBase();
        const rawUrl = r.preview_url.startsWith('http') ? r.preview_url : `${base}${r.preview_url}`;
        const previewUrl = sanitizePreviewUrl(rawUrl, base);
        renderPreviewCard({ type: 'html', program_name: programName, url: appendAuthTokenToUrl(previewUrl) });
      } else {
        // 1. Immediate HTML preview: if the program contains an HTML file, show it now
        //    without waiting for a server to start.
        const programData = allPrograms.find(x => x.program_name === programName);
        const htmlFile = programData?.files?.find(f =>
          f.endsWith('.html') || f.endsWith('.htm')
        );
        if (htmlFile && !r.error) {
          const base = await resolvedApiBase();
          const rawUrl = `${base}/preview/html/${encodeURIComponent(programName)}/${encodeURIComponent(htmlFile)}`;
          const previewUrl = sanitizePreviewUrl(rawUrl, base);
          renderPreviewCard({ type: 'html', program_name: programName, url: appendAuthTokenToUrl(previewUrl) });
        } else if (r.session_id && !r.program_finished) {
          // 2. Server preview: poll for a detected port in the process stdout
          //    (Flask, FastAPI, Express, http.server, etc.)
          pollForPreview(r.session_id, programName);
        }
      }
      // ────────────────────────────────────────────────────────────────────────────

      const outputText = (r.outputBuffer || r.initial_output || '').trim();
      const hasError = r.status === 'ERROR' || (r.stderr && r.stderr.trim()) ||
        /error|exception|traceback|syntaxerror/i.test(outputText);

      if (hasError && webhookRuntimeOnline) {
        const errorOutput = r.stderr || r.stdout || outputText || '';
        const fixMessage = `Fix the error in program "${programName}":\n\n${errorOutput}`;
        notify('Error detected — sending to n8n for auto-fix...', 'info');
        addMessage('ipem', '🔧 Error detected. Asking n8n to fix the code...', 'run', null, true);
        setWaiting(true, 'code');
        const payload = {
          chatInput: fixMessage,
          message: fixMessage,
          sessionId: getActiveConvSessionId(),
          history: buildContextArray(),
          context: buildContextString(),
          model: getSelectedModel()
        };
        let fixResult = null;
        try { fixResult = await api('POST', '/chat', payload); } catch (err) { console.error('Auto-fix error:', err); }
        setWaiting(false);
        if (fixResult) {
          const assistantText = extractResponseText(fixResult);
          pushHistory('assistant', assistantText); renderMemoryBadge();
          api('POST', '/history', { session_id: getActiveConvSessionId(), role: 'assistant', content: assistantText });
          await handleN8NResponse(fixResult, fixMessage);
          await loadPrograms(); await pollSessionStatus();
        } else {
          addMessage('ipem', '⚠️ Could not reach n8n for auto-fix. Check the error above.', 'casual', null, true);
        }
      }
    }

    // ── PREVIEW SYSTEM ──────────────────────────────────────────────────────────

    function sanitizePreviewUrl(url, base) {
      if (!url) return url;
      if (url.includes('host.docker.internal')) {
        try {
          const parsed = new URL(url);
          return `${base}${parsed.pathname}${parsed.search}`;
        } catch (e) {
          const idx = url.indexOf('/preview/');
          if (idx !== -1) return `${base}${url.slice(idx)}`;
        }
      }
      return url;
    }

    function appendAuthTokenToUrl(url) {
      const token = getAuthToken();
      if (!token) return url;
      try {
        const urlObj = new URL(url, window.location.origin);
        urlObj.searchParams.set('token', token);
        return urlObj.toString();
      } catch (e) {
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}token=${encodeURIComponent(token)}`;
      }
    }

    function getProxiedPreviewUrl(url) {
      if (!('serviceWorker' in navigator)) return url;
      try {
        let absUrl;
        if (url.startsWith('http://') || url.startsWith('https://')) {
          absUrl = new URL(url);
        } else {
          absUrl = new URL(url, window.location.origin);
        }

        const absUrlStr = absUrl.toString();
        let basePart = '';
        let filePart = '';

        const htmlMatch = absUrlStr.match(/(\/preview\/html\/[^\/]+\/)/);
        const portMatch = absUrlStr.match(/(\/preview\/port\/\d+\/)/);

        if (htmlMatch) {
          const idx = absUrlStr.indexOf(htmlMatch[1]) + htmlMatch[1].length;
          basePart = absUrlStr.slice(0, idx);
          filePart = absUrlStr.slice(idx);
        } else if (portMatch) {
          const idx = absUrlStr.indexOf(portMatch[1]) + portMatch[1].length;
          basePart = absUrlStr.slice(0, idx);
          filePart = absUrlStr.slice(idx);
        } else {
          const idx = absUrlStr.indexOf('/api');
          if (idx !== -1) {
            basePart = absUrlStr.slice(0, idx + 4) + '/';
            filePart = absUrlStr.slice(idx + 4);
          } else {
            basePart = absUrl.origin + '/';
            filePart = absUrl.pathname + absUrl.search;
          }
        }

        const encodedBase = encodeURIComponent(basePart);
        return `${window.location.origin}/proxy-preview/${encodedBase}/${filePart}`;
      } catch (e) {
        console.error('[SW PROXY] Failed to build proxied preview URL:', e);
        return url;
      }
    }

    /**
     * Poll GET /execute/preview/:session_id until a server port is detected.
     * Retries every 1.5 seconds for up to MAX_ATTEMPTS * 1.5s (~12s total).
     * Stops if the session is no longer active.
     */
    async function pollForPreview(sessionId, programName, attempt) {
      const MAX_ATTEMPTS = 8;
      const POLL_INTERVAL = 1500;
      if (attempt === undefined) attempt = 0;
      if (attempt >= MAX_ATTEMPTS) return;

      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      const info = await api('GET', `/execute/preview/${sessionId}`);
      if (info && info.preview && info.port) {
        // Server detected — build the proxied URL and show the preview card
        const base = await resolvedApiBase();
        const proxyUrl = `${base}/preview/port/${info.port}/`;
        renderPreviewCard({ type: 'server', program_name: programName, url: getProxiedPreviewUrl(appendAuthTokenToUrl(proxyUrl)), port: info.port });
        return;
      }

      // Check if session is still alive before trying again
      const sessions = await api('GET', '/execute/sessions');
      const stillRunning = Array.isArray(sessions) && sessions.some(
        s => s.session_id === sessionId && s.running
      );
      if (stillRunning) {
        pollForPreview(sessionId, programName, attempt + 1);
      }
    }

    /**
     * Render an iframe preview card as a chat message.
     * type: 'html' | 'server'
     * url: the fully-qualified URL to load in the iframe
     */
    function renderPreviewCard({ type, program_name, url, port }) {
      const previewId = 'preview_' + Date.now();
      const iframeId  = 'iframe_' + previewId;
      const badgeText = type === 'html' ? 'HTML' : `Server :${port}`;
      const badgeColor = type === 'html'
        ? 'var(--accent3)'
        : 'var(--green)';

      const html = `
        <div class="preview-card" id="${previewId}">
          <div class="preview-card-header">
            <div class="preview-card-title">
              <span class="preview-card-icon">🖥</span>
              <span class="preview-card-name">${escHtml(program_name)}</span>
              <span class="preview-card-badge" style="background:${badgeColor}20;color:${badgeColor};border-color:${badgeColor}40">${escHtml(badgeText)}</span>
            </div>
            <div class="preview-card-actions">
              <button class="preview-action-btn" onclick="reloadPreview('${previewId}')" title="Reload preview">
                <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M12 7A5 5 0 1 1 7 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M7 2l2-2M7 2l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Reload
              </button>
              <button class="preview-action-btn" onclick="openPreviewExternal('${escHtml(url)}')" title="Open in new tab">
                <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M6 2H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9 1h4v4M13 1L7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Open
              </button>
              <button class="preview-action-btn preview-close-btn" onclick="closePreview('${previewId}')" title="Close preview">✕</button>
            </div>
          </div>
          <div class="preview-frame-wrapper">
            <div class="preview-loading" id="loading_${previewId}">
              <div class="preview-spinner"></div>
              <span>Loading preview…</span>
            </div>
            <iframe
              id="${iframeId}"
              src="${escHtml(url)}"
              class="preview-iframe"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              title="${escHtml(program_name)} Preview"
              onload="document.getElementById('loading_${previewId}')?.remove()"
            ></iframe>
          </div>
        </div>
      `;
      addMessage('ipem', html, 'run', null, true, true);
      notify(`Preview ready for ${program_name}`, 'success');
    }

    function reloadPreview(previewId) {
      const iframe = document.getElementById('iframe_' + previewId);
      if (!iframe) return;
      // Re-add the loading indicator
      const wrapper = iframe.closest('.preview-frame-wrapper');
      if (wrapper && !wrapper.querySelector('.preview-loading')) {
        const loading = document.createElement('div');
        loading.className = 'preview-loading';
        loading.id = 'loading_' + previewId;
        loading.innerHTML = '<div class="preview-spinner"></div><span>Reloading…</span>';
        wrapper.insertBefore(loading, iframe);
      }
      iframe.src = iframe.src;
    }

    function openPreviewExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }

    function closePreview(previewId) {
      const card = document.getElementById(previewId);
      if (!card) return;
      card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      card.style.opacity = '0';
      card.style.transform = 'translateY(-4px) scale(0.99)';
      setTimeout(() => card.remove(), 220);
    }

    window.reloadPreview = reloadPreview;
    window.openPreviewExternal = openPreviewExternal;
    window.closePreview = closePreview;
    // ────────────────────────────────────────────────────────────────────────────

    function renderExecutionResponse(r, isInput) {
      const waiting = r.waiting_for_input; const output = r.initial_output || r.output || '';
      const finished = r.program_finished || r.status === 'SUCCESS' || r.status === 'ERROR';
      const statusIcon = waiting ? '⌨' : (finished ? (r.status==='SUCCESS'?'✓':'✗') : '▶');
      const statusClass = waiting ? 'input' : (finished ? (r.status==='SUCCESS'?'success':'error') : 'running');
      const statusText = waiting ? 'Waiting for input' : (finished ? r.status : 'Running');
      const html = `<div class="exec-card"><div class="exec-card-header"><div class="exec-status ${statusClass}"><span>${statusIcon}</span><span>${r.program_name||'Program'} — ${statusText}</span></div>${r.session_id?`<span style="font-size:10px;color:var(--text3);font-family:var(--mono);">${r.session_id.slice(-12)}</span>`:''}</div>${output?`<div class="exec-output">${escHtml(output)}</div>`:''}${waiting?`<div style="padding:8px 14px;font-size:12px;color:var(--blue);border-top:1px solid var(--border);">⌨ Type your response in the input below</div>`:''}</div>`;
      addMessage('ipem', html, 'run', null, false, true);
      if (waiting) notify('Program waiting for input','info');
      else if (finished && r.status==='SUCCESS') notify('Program completed successfully','success');
    }

    function renderMemoryMessage(mem) {
      const entries = Object.entries(mem).filter(([k]) => k !== 'active_session');
      if (!entries.length) { addMessage('ipem','No facts stored yet.','casual',null,true); return; }
      const html = `<div class="memory-card"><div class="memory-card-title">Stored Facts</div>${entries.map(([k,v])=>`<div class="memory-entry"><span class="memory-key">${k}</span><span class="memory-val">= ${typeof v==='object'?JSON.stringify(v):v}</span></div>`).join('')}</div>`;
      addMessage('ipem', html, 'memory', null, false, true);
    }

    // ── RUN BUTTON RENDERER ─────────────────────────────────────────────────────
    function renderRunButton(programName, projectType, entryFile) {
      const btnId = 'run_btn_' + Date.now();
      const typeLabel = projectType === 'static_html' ? 'HTML · CSS · JS'
        : projectType === 'node' ? 'Node.js'
        : projectType === 'flask' ? 'Python · Flask'
        : projectType === 'fastapi' ? 'Python · FastAPI'
        : (projectType || 'Project');
      const html = '<div class="run-ready-card">' +
        '<div class="run-ready-info">' +
          '<div class="run-ready-icon-wrap">' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
              '<circle cx="8" cy="8" r="6.5" stroke="var(--green,#4ade80)" stroke-width="1.2"/>' +
              '<path d="M6.5 5.5l5 2.5-5 2.5V5.5z" fill="var(--green,#4ade80)"/>' +
            '</svg>' +
          '</div>' +
          '<div>' +
            '<div class="run-ready-title">' + escHtml(programName) + '</div>' +
            '<div class="run-ready-type">' + escHtml(typeLabel) + ' · Ready to run</div>' +
          '</div>' +
        '</div>' +
        '<button id="' + btnId + '" class="run-ready-btn" onclick="handleRunBtnClick(' + "'" + escHtml(programName) + "','" + escHtml(entryFile) + "','" + btnId + "')" + '">' +
          '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M2.5 1.5l9 4.5-9 4.5V1.5z"/></svg>' +
          ' Run' +
        '</button>' +
      '</div>';
      addMessage('ipem', html, 'run', null, true, true);
    }
    window.handleRunBtnClick = async function(programName, entryFile, btnId) {
      const btn = document.getElementById(btnId);
      if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
      await startProgram(programName, entryFile || undefined);
    };
    // ─────────────────────────────────────────────────────────────────────────────

    async function handleN8NResponse(r, userText) {
      const data = Array.isArray(r) ? r[0] : r;
      const output = data?.output || data?.message || data?.text || JSON.stringify(r);
      updateWebhookRuntimeStatus(!isDirectModeResponse(r));
      addMessage('ipem', output, detectType(userText), null, true);

      // ── RUN BUTTON: show after successful project creation ──────────────────
      if (data && data.run_ready && data.program_name) {
        renderRunButton(data.program_name, data.project_type || '', data.entry_file || '');
      }
      // ────────────────────────────────────────────────────────────────────────

      // ── PREVIEW DETECTION IN CHAT RESPONSE ──────────────────────────────────
      if (data && data.preview && data.preview_url) {
        const programName = data.program_name || (userText.match(/run\s+(\S+)/) || [])[1] || '';
        const base = await resolvedApiBase();
        const rawUrl = data.preview_url.startsWith('http') ? data.preview_url : `${base}${data.preview_url}`;
        const previewUrl = sanitizePreviewUrl(rawUrl, base);
        renderPreviewCard({ type: 'html', program_name: programName, url: appendAuthTokenToUrl(previewUrl) });
      }
      // ────────────────────────────────────────────────────────────────────────

      // ── CONVERSATION LINKED PROJECT UPDATE ──────────────────────────────────
      if (data && data.program_name) {
        const activeConvId = getActiveConvId();
        if (activeConvId) {
          const convs = loadConversations();
          const idx = convs.findIndex(c => c.id === activeConvId);
          if (idx !== -1) {
            // Instantly cache the association in memory
            convProjectsCache[convs[idx].sessionId] = {
              program_name: data.program_name,
              project_type: data.project_type || 'single_file',
              language:     data.language || null
            };
            // Instantly update the linked program ID in localStorage
            if (convs[idx].linkedProgramId !== data.program_name) {
              convs[idx].linkedProgramId = data.program_name;
              saveConversations(convs);
              renderConversationSidebar();
            }
          }
        }
      }

      loadPrograms(); pollSessionStatus();
      // Reload conversation→project mappings so sidebar badges update immediately
      loadConvProjectsFromServer().catch(() => {});
      if (currentExplorerTab === 'files') loadFileTree();

    }

    function detectType(text) {
      const l = text.toLowerCase();
      if (l.includes('write')||l.includes('build')||l.includes('create')||l.includes('code')) return 'code';
      if (l.includes('run')||l.includes('execute')) return 'run';
      if (l.includes('remember')||l.includes('save')||l.includes('my name')) return 'memory';
      return 'casual';
    }

    // ── MESSAGE RENDERING ───────────────────────────────────────────────────────
    function addMessage(role, content, type, meta, scroll, isHTML) {
      document.getElementById('welcomeState').style.display = 'none';
      const container = document.getElementById('chatMessages');
      const typeLabels = { code:'CODE', run:'EXECUTE', memory:'MEMORY', casual:'CHAT', input:'INPUT' };
      const now = new Date().toLocaleTimeString('en', { hour:'2-digit', minute:'2-digit' });
      const div = document.createElement('div');
      div.className = `message ${role}`;

      let avatar = '';
      let senderName = '';
      if (role === 'ipem') {
        avatar = `<div class="msg-avatar ipem">IP</div>`;
        senderName = 'IPEM';
      } else if (role === 'admin') {
        avatar = `<div class="msg-avatar" style="background-color: var(--accent3); color: white;">A</div>`;
        senderName = 'IPEM Administration';
      } else {
        avatar = `<div class="msg-avatar user">U</div>`;
        senderName = 'You';
      }

      const badgeHtml = type ? `<span class="msg-type-badge badge-${type}">${typeLabels[type]||type.toUpperCase()}</span>` : '';
      const contentHtml = isHTML ? content : `<div style="white-space:pre-wrap;">${escHtml(content)}</div>`;
      div.innerHTML = `${avatar}<div class="msg-body"><div class="msg-header"><span class="msg-name">${senderName}</span>${badgeHtml}<span class="msg-time">${now}</span></div><div class="msg-content">${contentHtml}</div></div>`;

      if (role === 'admin') {
        div.style.backgroundColor = 'var(--bg-lighter)';
        div.style.borderLeft = '4px solid var(--accent3)';
        div.style.padding = '12px';
        div.style.borderRadius = '8px';
      }

      container.appendChild(div);
      if (scroll !== false) container.scrollTop = container.scrollHeight;
    }

    let waitingInterval = null;
    let waitingSeconds = 0;

    function addTypingIndicator(initialText) {
      const container = document.getElementById('chatMessages'); const div = document.createElement('div');
      div.className = 'message'; div.id = 'typingIndicator';
      const statusMsg = initialText || 'Generating response...';
      div.innerHTML = `<div class="msg-avatar ipem">IP</div><div class="msg-body"><div class="msg-content" style="padding:8px 16px;"><div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div><div id="typingStatusText" style="font-size:11px;color:var(--text3);margin-top:4px;">${statusMsg}</div></div></div>`;
      container.appendChild(div); container.scrollTop = container.scrollHeight;
    }
    function removeTypingIndicator() { const el = document.getElementById('typingIndicator'); if (el) el.remove(); }

    function setWaiting(state, promptText = '') {
      isWaiting = state;
      const sendBtn = document.getElementById('sendBtn');
      if (sendBtn) sendBtn.disabled = state;
      const wb = document.getElementById('waitingBanner');
      const wbText = wb ? wb.querySelector('.banner-text') || wb : null;

      if (waitingInterval) { clearInterval(waitingInterval); waitingInterval = null; }
      waitingSeconds = 0;

      if (state) {
        // Detect task type to show relevant status
        const taskType = (promptText && typeof detectType === 'function') ? detectType(promptText) : 'casual';

        let messages;
        let initialMsg;
        if (taskType === 'code') {
          initialMsg = '⚡ Generating code...';
          messages = [
            { after: 10, msg: '🤖 Analyzing requirements & routing model...' },
            { after: 25, msg: '⏳ Generating code... Large projects may take longer...' },
            { after: 50, msg: '🧠 Model is drafting files & logic... Please wait...' },
            { after: 90, msg: '☕ Large project in progress... Complex or local models take extra time...' },
          ];
        } else if (taskType === 'run') {
          initialMsg = '▶️ Running program...';
          messages = [
            { after: 10, msg: '⏳ Waiting for execution result...' },
            { after: 30, msg: '🔄 Program still running...' },
          ];
        } else if (taskType === 'memory') {
          initialMsg = '🧠 Saving to memory...';
          messages = [
            { after: 10, msg: '💾 Updating memory store...' },
          ];
        } else {
          // casual / default — no code-centric messages
          initialMsg = '💬 Thinking...';
          messages = [
            { after: 15, msg: '⏳ Still thinking...' },
            { after: 40, msg: '🔄 Taking a little longer than usual...' },
          ];
        }

        addTypingIndicator(initialMsg);
        if (wb) wb.classList.remove('hidden');

        waitingInterval = setInterval(() => {
          waitingSeconds += 3;
          const statusText = document.getElementById('typingStatusText');
          // Find the most applicable message for current elapsed time
          let msg = null;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (waitingSeconds >= messages[i].after) { msg = messages[i].msg; break; }
          }
          if (msg) {
            if (statusText) statusText.textContent = msg;
            if (wbText && wbText !== wb) wbText.textContent = msg;
          }
        }, 3000);
      } else {
        removeTypingIndicator();
        if (wb) wb.classList.remove('hidden');
        if (wb) wb.classList.add('hidden');
      }
    }
    function hideWelcome() { document.getElementById('welcomeState').style.display = 'none'; }

    async function clearChat() {
      if (!await window.ipemDialog.confirm('Clear this conversation? This will erase its messages and memory.', { title: 'Clear conversation', confirmText: 'Clear conversation', danger: true })) return;
      clearChatHistory();
      api('DELETE', '/history?session_id=' + getActiveConvSessionId());
      renderMemoryBadge();
      const messages = document.getElementById('chatMessages'); const welcome = document.getElementById('welcomeState');
      messages.innerHTML = ''; messages.appendChild(welcome); welcome.style.display = '';
      notify('Chat and memory cleared', 'info');
    }

    // ── MEMORY BADGE & HISTORY PANEL ───────────────────────────────────────────
    function renderMemoryBadge() {
      const h = loadChatHistory(); const badge = document.getElementById('memoryBadge');
      if (badge) { badge.textContent = h.length + ' turns'; badge.style.color = h.length > 0 ? 'var(--accent3)' : 'var(--text3)'; }
    }
    function toggleHistoryPanel() {
      const panel = document.getElementById('historyPanel'); if (!panel) return;
      const isOpen = panel.style.display !== 'none';
      if (isMobileLayout()) closeMobilePanels(false);
      panel.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) renderHistoryPanel();
    }
    function renderHistoryPanel() {
      const panel = document.getElementById('historyPanelContent'); if (!panel) return;
      const history = loadChatHistory();
      if (!history.length) { panel.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:12px;">No history yet.</div>'; return; }
      panel.innerHTML = history.slice(-20).reverse().map(t => `
        <div style="padding:8px 12px;border-bottom:1px solid var(--border);">
          <div style="font-size:10px;color:${t.role==='user'?'var(--accent3)':'var(--green)'};font-family:var(--mono);margin-bottom:3px;">${t.role==='user'?'YOU':'IPEM'} · ${new Date(t.ts).toLocaleTimeString()}</div>
          <div style="font-size:12px;color:var(--text2);white-space:pre-wrap;max-height:60px;overflow:hidden;">${escHtml((t.content||'').slice(0,180))}${t.content&&t.content.length>180?'...':''}</div>
        </div>`).join('');
    }
    function exportHistory() {
      const h = loadChatHistory();
      const blob = new Blob([JSON.stringify(h, null, 2)], { type:'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `ipem-history-${Date.now()}.json`; a.click();
      URL.revokeObjectURL(url); notify('History exported','success');
    }
    function renderWebhookStatus(isOnline) {
      const el = document.getElementById('webhookStatus'); const dot = document.getElementById('connDot');
      if (!el) return;
      el.style.color = isOnline ? 'var(--green)' : 'var(--red)';
      if (dot) dot.style.background = isOnline ? 'var(--green)' : 'var(--red)';
    }

    // ── UI HELPERS ──────────────────────────────────────────────────────────────
    function toggleSidebar() {
      if (isMobileLayout()) {
        const next = !document.body.classList.contains('mobile-sidebar-open');
        document.body.classList.toggle('mobile-sidebar-open', next);
        document.body.classList.remove('mobile-explorer-open');
        if (next) closeHistoryPanel(); return;
      }
      document.getElementById('sidebar').classList.toggle('collapsed');
    }
    window.toggleSidebar = toggleSidebar;
    function toggleExplorer() {
      if (isMobileLayout()) {
        const next = !document.body.classList.contains('mobile-explorer-open');
        document.body.classList.toggle('mobile-explorer-open', next);
        document.body.classList.remove('mobile-sidebar-open');
        if (next) closeHistoryPanel(); return;
      }
      document.getElementById('explorer').classList.toggle('collapsed');
    }
    window.toggleExplorer = toggleExplorer;
    function setSbStatus(text, color) { const el = document.getElementById('sb-status'); el.textContent = text; el.style.color = color || ''; }
    function notify(text, type = 'info') {
      const container = document.getElementById('notifContainer'); const div = document.createElement('div');
      div.className = `notif ${type}`; const icons = { success:'✓', error:'✗', info:'i' };
      div.innerHTML = `<span style="font-weight:600;font-family:var(--mono);font-size:11px;">${icons[type]||'i'}</span><span>${text}</span>`;
      container.appendChild(div); setTimeout(() => div.remove(), 3500);
    }
    function escHtml(str) {
      if (!str) return '';
      return str.toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
