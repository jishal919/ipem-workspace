/**
 * IPEM Control Center — Administrative Frontend Controller
 * Direct integration with Node.js/Express admin endpoints
 */

(function initAdminControlCenter() {
  const API_BASE = window.IPEM_CONFIG?.API_BASE_URL || '/api';
  let currentUser = null;
  let currentView = 'dashboard';

  // Polling handles for live refresh
  let dashboardPollInterval = null;
  let conversationsPollInterval = null;
  let activeViewPollInterval = null;

  // Pagination and filter states
  const states = {
    users: { limit: 50, offset: 0, search: '', role: '', status: '' },
    programs: { limit: 50, offset: 0, search: '', status: '', language: '' },
    conversations: { limit: 50, offset: 0, search: '', status: '' },
    audit: { limit: 50, offset: 0, search: '', action: '', targetType: '' }
  };

  // Selected resource IDs for drawers/modals
  let selectedUserId = null;
  let selectedProgramId = null;
  let selectedConvId = null;
  let selectedIncidentId = null;
  let selectedAlertId = null;

  // Drawer tab states
  const drawerTabs = {
    user: 'overview',
    program: 'overview',
    conv: 'overview'
  };

  /* ─── AUTHENTICATION GUARD ─── */
  function getToken() {
    return localStorage.getItem('ipem_token');
  }

  function clearAuth() {
    localStorage.removeItem('ipem_token');
    localStorage.removeItem('ipem_user');
  }

  function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
  }

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

  async function api(method, path, body = null) {
    const token = getToken();
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

    try {
      const res = await fetch(API_BASE + path, opts);
      if (res.status === 401) {
        clearAuth();
        window.location.href = './login.html';
        return null;
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }

      if (!res.ok) {
        throw { status: res.status, message: data?.error || data || 'API Error' };
      }
      return data;
    } catch (err) {
      console.error(`API Error: [${method}] ${path}`, err);
      showToast(err.message || 'Network communication failure', 'error');
      throw err;
    }
  }

  async function verifyAuth() {
    const token = getToken();
    if (!token) {
      window.location.href = './login.html';
      return;
    }

    try {
      const res = await api('GET', '/auth/me');
      if (!res || !res.ok || !res.user) {
        clearAuth();
        window.location.href = './login.html';
        return;
      }

      currentUser = res.user;
      if (!['owner', 'admin', 'moderator'].includes(currentUser.role)) {
        showToast('Unauthorized access. Admin privileges required.', 'error');
        setTimeout(() => { window.location.href = './index.html'; }, 2000);
        return;
      }

      // Render Admin Details in Sidebar
      document.getElementById('userNameText').textContent = currentUser.name || currentUser.email.split('@')[0];
      document.getElementById('userRoleText').textContent = currentUser.role;

      const initials = (currentUser.name || currentUser.email || '?')
        .trim().split(/\s+/).filter(Boolean)
        .map(p => p[0]).join('').slice(0, 2).toUpperCase();
      document.getElementById('avatarPill').textContent = initials;

      // Handle custom rules banner
      const userBanner = document.getElementById('user-permissions-banner');
      if (userBanner) {
        userBanner.style.display = currentUser.role === 'moderator' ? 'none' : 'flex';
      }

      // Start control center
      initRouter();
      initEvents();
    } catch {
      clearAuth();
      window.location.href = './login.html';
    }
  }

  /* ─── ROUTING & VIEW SWITCHING ─── */
  function initRouter() {
    const handleHash = () => {
      const hash = window.location.hash.replace('#', '');
      const validViews = [
        'dashboard', 'users', 'programs', 'conversations',
        'analytics-requests', 'analytics-activity', 'analytics-ai',
        'security-flags', 'security-incidents', 'security-ip',
        'infra-health', 'infra-metrics', 'infra-alerts',
        'admin-audit', 'admin-roles', 'admin-settings'
      ];
      const targetView = validViews.includes(hash) ? hash : 'dashboard';
      switchView(targetView);
    };

    window.addEventListener('hashchange', handleHash);
    handleHash();
  }

  function switchView(viewName) {
    currentView = viewName;

    // Toggle active sidebar items
    document.querySelectorAll('.sidebar .nav-item').forEach(item => {
      if (item.getAttribute('data-view') === viewName) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Toggle view containers
    document.querySelectorAll('.view-container').forEach(container => {
      if (container.id === `view-${viewName}`) {
        container.classList.add('active');
      } else {
        container.classList.remove('active');
      }
    });

    // Update Header
    const formattedTitle = viewName
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    document.getElementById('viewTitle').textContent = formattedTitle;
    document.getElementById('headerStatusText').textContent = `Manage and monitor ${viewName.replace('-', ' ')}`;

    // Load data specific to this view
    loadViewData(viewName);
  }

  function loadViewData(view) {
    // Stop dashboard polling when navigating away
    if (view !== 'dashboard' && dashboardPollInterval) {
      clearInterval(dashboardPollInterval);
      dashboardPollInterval = null;
    }
    // Stop conversations polling when navigating away
    if (view !== 'conversations' && conversationsPollInterval) {
      clearInterval(conversationsPollInterval);
      conversationsPollInterval = null;
    }
    // Stop active view polling when navigating away
    if (activeViewPollInterval) {
      clearInterval(activeViewPollInterval);
      activeViewPollInterval = null;
    }

    switch (view) {
      case 'dashboard':
        loadDashboardStats();
        if (!dashboardPollInterval) {
          dashboardPollInterval = setInterval(() => {
            if (currentView === 'dashboard') loadDashboardStats();
          }, 15000);
        }
        break;
      case 'users':
        loadUsersTable();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'users') loadUsersTable();
        }, 30000);
        break;
      case 'programs':
        loadProgramsTable();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'programs') loadProgramsTable();
        }, 30000);
        break;
      case 'conversations':
        loadConversationsTable();
        if (!conversationsPollInterval) {
          conversationsPollInterval = setInterval(() => {
            if (currentView === 'conversations') loadConversationsTable();
          }, 15000);
        }
        break;
      case 'analytics-requests':
        loadAnalyticsRequests();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'analytics-requests') loadAnalyticsRequests();
        }, 30000);
        break;
      case 'analytics-activity':
        loadAnalyticsActivity();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'analytics-activity') loadAnalyticsActivity();
        }, 30000);
        break;
      case 'analytics-ai':
        loadAnalyticsAi();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'analytics-ai') loadAnalyticsAi();
        }, 30000);
        break;
      case 'security-flags':
        loadSecurityFlags();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'security-flags') loadSecurityFlags();
        }, 30000);
        break;
      case 'security-incidents':
        loadSecurityIncidents();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'security-incidents') loadSecurityIncidents();
        }, 30000);
        break;
      case 'security-ip':
        loadSecurityIpIntel();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'security-ip') loadSecurityIpIntel();
        }, 30000);
        break;
      case 'infra-health':
        loadInfraHealth();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'infra-health') loadInfraHealth();
        }, 30000);
        break;
      case 'infra-metrics':
        loadInfraMetrics();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'infra-metrics') loadInfraMetrics();
        }, 30000);
        break;
      case 'infra-alerts':
        loadInfraAlerts();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'infra-alerts') loadInfraAlerts();
        }, 30000);
        break;
      case 'admin-audit':
        loadAuditTable();
        break;
      case 'admin-settings':
        loadAdminSettings();
        activeViewPollInterval = setInterval(() => {
          if (currentView === 'admin-settings') loadAdminSettings();
        }, 30000);
        break;
    }
  }

  window.refreshCurrentView = function () {
    const modal = showProgressModal(
      'Refreshing Dashboard...',
      'Please wait while the system updates the telemetry data.'
    );
    modal.setStatusText('Refreshing infrastructure...');

    setTimeout(() => {
      window.location.reload(true);
    }, 1000);
  };

  /* ─── VIEW 1: DASHBOARD STATS ─── */
  async function loadDashboardStats() {
    try {
      // Parallel fetches for stats, system health, and activity feed
      const [statsRes, healthRes, activityRes] = await Promise.allSettled([
        api('GET', '/admin/stats'),
        api('GET', '/admin/system/health'),
        api('GET', '/admin/activity?limit=15')
      ]);

      // ── KPI Stats Cards ──────────────────────────────────────────────────────
      if (statsRes.status === 'fulfilled' && statsRes.value?.ok) {
        const s = statsRes.value;
        const totalEl  = document.getElementById('stat-total-users');
        const onlineEl = document.getElementById('stat-online-users');
        const progsEl  = document.getElementById('stat-active-programs');
        const costEl   = document.getElementById('stat-ai-cost');
        const rpmEl    = document.getElementById('stat-rpm');
        const auditEl  = document.getElementById('stat-active-execs');

        if (totalEl)  totalEl.textContent  = s.totalUsers.toLocaleString();
        if (onlineEl) onlineEl.textContent  = s.onlineUsers.toLocaleString();
        if (progsEl)  progsEl.textContent   = s.totalPrograms.toLocaleString();
        if (costEl)   costEl.textContent    = `$${(s.aiCostToday || 0).toFixed(4)}`;
        if (rpmEl)    rpmEl.textContent     = s.requestsLastMinute.toLocaleString();
        if (auditEl)  auditEl.textContent   = (s.auditEventsToday || 0).toLocaleString();
      }

      // ── Infrastructure Health Mini-Widget ────────────────────────────────────
      if (healthRes.status === 'fulfilled' && healthRes.value?.ok) {
        const h = healthRes.value.health;
        // h.cpu   → number (percent)
        // h.mem   → { percent, used, total, free }
        // h.disk  → { percent, used, total, free }
        // h.db    → { ok, latencyMs }
        // h.redis → { ok, latencyMs | error }
        // h.litellm, h.ollama, h.n8n, h.google → { ok, latencyMs | error }
        const cpuVal  = h.cpu ?? 0;
        const memVal  = h.mem?.percent ?? 0;
        const diskVal = h.disk?.percent ?? 0;
        const dbStr   = h.db?.ok ? 'online' : 'offline';
        const redisStr = h.redis?.ok ? 'online' : 'offline';
        const ollamaStr = h.ollama?.ok ? 'online' : 'offline';
        const litellmStr = h.litellm?.ok ? 'online' : 'offline';
        const n8nStr  = h.n8n?.ok ? 'online' : 'offline';

        const healthGrid = document.getElementById('dashboard-health-widgets');
        if (healthGrid) {
          healthGrid.innerHTML = `
            ${renderGaugeWidget('CPU Usage', cpuVal, '%')}
            ${renderGaugeWidget('Memory Usage', memVal, '%')}
            ${renderGaugeWidget('Storage Usage', diskVal, '%')}
            <div style="display:flex; justify-content:space-between; margin-top: 10px;">
              <span>Database</span>
              <span class="badge ${dbStr === 'online' ? 'status-ok' : 'status-critical'}">${dbStr} ${h.db?.latencyMs ? '(' + h.db.latencyMs + 'ms)' : ''}</span>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span>Redis Cache</span>
              <span class="badge ${redisStr === 'online' ? 'status-ok' : 'status-critical'}">${redisStr}</span>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span>Ollama (Local)</span>
              <span class="badge ${ollamaStr === 'online' ? 'status-ok' : 'status-critical'}">${ollamaStr}</span>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span>LiteLLM Proxy</span>
              <span class="badge ${litellmStr === 'online' ? 'status-ok' : 'status-critical'}">${litellmStr}</span>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span>n8n Webhooks</span>
              <span class="badge ${n8nStr === 'online' ? 'status-ok' : 'status-critical'}">${n8nStr}</span>
            </div>
          `;
        }
      }

      // ── Live Activity Feed ───────────────────────────────────────────────────
      const feed = document.getElementById('dashboard-activity-feed');
      if (feed && activityRes.status === 'fulfilled' && activityRes.value?.ok) {
        const activities = activityRes.value.activities || [];
        if (activities.length === 0) {
          feed.innerHTML = '<div class="empty-state">No recent platform activity recorded.</div>';
        } else {
          feed.innerHTML = activities.map(act => `
            <div class="activity-item">
              <div class="activity-icon">${getActivityEmoji(act.activity_type)}</div>
              <div class="activity-details">
                <div class="activity-text">
                  <span class="activity-user">${act.user_email || 'System'}</span>
                  &nbsp;<span class="cell-bold">${(act.activity_type || '').replace(/_/g, ' ')}</span>
                  ${act.resource_name ? `<span style="color:var(--text-dark)"> · ${act.resource_type} <span class="cell-mono">${act.resource_name}</span></span>` : ''}
                </div>
                <div class="activity-time">${formatDate(act.timestamp)}${act.ip_address ? ' · ' + act.ip_address : ''}</div>
              </div>
            </div>
          `).join('');
        }
      }

    } catch (err) {
      console.error('[Dashboard] Failed to load metrics:', err);
    }
  }

  function renderGaugeWidget(name, val, suffix = '') {
    const displayVal = val !== undefined ? val.toFixed(1) : '—';
    let severityClass = '';
    if (val > 90) severityClass = 'critical';
    else if (val > 75) severityClass = 'warning';

    return `
      <div style="margin-bottom: 8px;">
        <div class="monitor-stats" style="margin-bottom: 4px;">
          <span>${name}</span>
          <span>${displayVal}${suffix}</span>
        </div>
        <div class="gauge-track">
          <div class="gauge-fill ${severityClass}" style="width: ${val ?? 0}%"></div>
        </div>
      </div>
    `;
  }

  function getActivityEmoji(type) {
    if (type.includes('LOGIN')) return '🔑';
    if (type.includes('CREATE')) return '➕';
    if (type.includes('DELETE')) return '🗑️';
    if (type.includes('EXECUTE')) return '⚡';
    if (type.includes('SUSPEND') || type.includes('BAN')) return '🚫';
    return '📝';
  }

  /* ─── VIEW 2: USERS LIST & DRAWER ─── */
  async function loadUsersTable() {
    const tbody = document.querySelector('#users-table tbody');
    tbody.innerHTML = '<tr><td colspan="7"><div class="skeleton skeleton-rect" style="height: 120px;"></div></td></tr>';

    try {
      const q = states.users;
      const res = await api('GET', `/admin/users?search=${encodeURIComponent(q.search)}&limit=${q.limit}&offset=${q.offset}`);

      let users = res.users || [];
      // Filter clientside by status/role since backend may have basic search only
      if (q.role) users = users.filter(u => u.role === q.role);
      if (q.status) users = users.filter(u => u.status === q.status);

      if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No users found.</div></td></tr>';
        return;
      }

      tbody.innerHTML = users.map(u => `
        <tr onclick="openUserDrawer(${u.id})" style="cursor:pointer;">
          <td class="cell-flex">
            <div class="avatar-pill">${(u.name || u.email)[0].toUpperCase()}</div>
            <div>
              <div class="cell-bold">${u.name || 'User'}</div>
              <div class="cell-mono" style="font-size: 11px;">${u.email}</div>
            </div>
          </td>
          <td><span class="badge badge-${u.role || 'user'}">${u.role || 'user'}</span></td>
          <td><span class="badge badge-${u.status || 'active'}">${u.status || 'active'}</span></td>
          <td>${formatDate(u.created_at)}</td>
          <td>${u.last_login ? formatDate(u.last_login) : 'Never'}</td>
          <td><span class="cell-mono" id="user-count-${u.id}">—</span></td>
          <td>
            <button class="btn btn-xs" onclick="event.stopPropagation(); openUserDrawer(${u.id})">Inspect</button>
          </td>
        </tr>
      `).join('');

      // Fetch program counts asynchronously to keep list rendering fast
      users.forEach(async (u) => {
        try {
          const progs = await api('GET', `/admin/programs?ownerId=${u.id}&limit=1`);
          const countEl = document.getElementById(`user-count-${u.id}`);
          if (countEl) countEl.textContent = progs.total ?? 0;
        } catch {}
      });

      document.getElementById('users-pagination-info').textContent = `Showing ${q.offset + 1}-${q.offset + users.length} users`;
      document.getElementById('users-prev-btn').disabled = q.offset === 0;
      document.getElementById('users-next-btn').disabled = users.length < q.limit;
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Error loading users directory.</div></td></tr>';
    }
  }

  window.openUserDrawer = async function (id) {
    selectedUserId = id;
    const drawer = document.getElementById('user-drawer');
    const backdrop = document.getElementById('user-drawer-backdrop');
    drawer.classList.add('open');
    backdrop.classList.add('open');

    // Reset fields
    document.getElementById('user-detail-name').textContent = 'Loading...';
    document.getElementById('user-detail-email').textContent = 'Loading...';
    document.getElementById('user-detail-id').textContent = '—';
    document.getElementById('user-detail-role').textContent = '—';
    document.getElementById('user-detail-status').textContent = '—';
    document.getElementById('user-detail-created').textContent = '—';
    document.getElementById('user-detail-lastlogin').textContent = '—';
    document.getElementById('user-detail-verified').textContent = '—';

    // Hide actions depending on user role
    const roleBtn = document.getElementById('user-action-role-btn');
    const statusBtn = document.getElementById('user-action-status-btn');
    const deleteBtn = document.getElementById('user-action-delete-btn');
    if (roleBtn) roleBtn.disabled = currentUser.role !== 'owner';
    if (statusBtn) statusBtn.disabled = !['owner', 'admin'].includes(currentUser.role);
    if (deleteBtn) {
      deleteBtn.style.display = 'none';
      deleteBtn.disabled = true;
    }

    try {
      const res = await api('GET', `/admin/users/${id}`);
      const u = res.user;

      document.getElementById('user-detail-name').textContent = u.name || '—';
      document.getElementById('user-detail-email').textContent = u.email || '—';
      document.getElementById('user-detail-id').textContent = u.id || '—';
      document.getElementById('user-detail-role').textContent = u.role || 'user';
      document.getElementById('user-detail-status').textContent = u.status || 'active';
      document.getElementById('user-detail-created').textContent = formatDate(u.created_at);
      document.getElementById('user-detail-lastlogin').textContent = u.last_login ? formatDate(u.last_login) : 'Never';
      document.getElementById('user-detail-verified').textContent = u.verified ? 'Yes' : 'No';

      if (deleteBtn && ['owner', 'admin'].includes(currentUser.role)) {
        deleteBtn.style.display = 'inline-block';
        if (u.role === 'owner' || u.id === currentUser.id) {
          deleteBtn.disabled = true;
        } else {
          deleteBtn.disabled = false;
        }
      }

      switchDrawerTab('user', drawerTabs.user);
    } catch (err) {
      showToast('Failed to load user profile.', 'error');
    }
  };

  window.closeUserDrawer = function () {
    document.getElementById('user-drawer').classList.remove('open');
    document.getElementById('user-drawer-backdrop').classList.remove('open');
  };

  /* Drawer Tab Switching */
  window.switchDrawerTab = function (resource, tabName) {
    console.log(`Selected tab for ${resource}: ${tabName} (before switching: ${drawerTabs[resource]})`);
    drawerTabs[resource] = tabName;
    const drawer = document.getElementById(`${resource}-drawer`);

    // Toggle active tab header
    drawer.querySelectorAll('.drawer-tab').forEach(tab => {
      if (tab.getAttribute('data-tab') === `${resource}-${tabName}`) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    // Toggle active tab content
    drawer.querySelectorAll('.drawer-tab-content').forEach(content => {
      if (content.id === `${resource}-tab-${tabName}`) {
        content.classList.add('active');
      } else {
        content.classList.remove('active');
      }
    });

    console.log(`Active tab for ${resource} is now: ${tabName}`);

    // Load drawer tab-specific content
    if (resource === 'user') {
      if (tabName === 'history') loadUserActivityTimeline();
      if (tabName === 'notes') loadUserNotes();
      if (tabName === 'messages') loadUserMessages();
      if (tabName === 'conversations') loadUserConversations();
      if (tabName === 'programs') loadUserPrograms();
    } else if (resource === 'program') {
      const progDrawer = document.getElementById('program-drawer');
      if (tabName === 'code') {
        progDrawer.classList.add('wide');
      } else {
        progDrawer.classList.remove('wide');
      }
      if (tabName === 'notes') loadProgramNotes();
      if (tabName === 'code') loadProgramCodeTab();
    } else if (resource === 'conv') {
      if (tabName === 'notes') loadConvNotes();
    }
  };

  async function loadUserActivityTimeline() {
    const timeline = document.getElementById('user-detail-activity-timeline');
    timeline.innerHTML = 'Loading activity...';

    try {
      const res = await api('GET', `/admin/activity/${selectedUserId}`);
      const logs = res.activities || [];
      if (logs.length === 0) {
        timeline.innerHTML = '<div class="empty-state">No recorded activities for this user.</div>';
        return;
      }

      timeline.innerHTML = logs.map(l => `
        <div class="timeline-node ${l.success ? 'success' : 'danger'}">
          <div class="timeline-header">
            <span>${l.activity_type.replace(/_/g, ' ')}</span>
            <span class="timeline-time">${formatDate(l.timestamp)}</span>
          </div>
          <div class="timeline-body">
            IP Address: ${l.ip_address || '—'} <br>
            ${l.resource_type ? `Target: ${l.resource_type} (${l.resource_name || l.resource_id})` : ''}
          </div>
        </div>
      `).join('');
    } catch {
      timeline.innerHTML = 'Failed to load activities.';
    }
  }

  // Admin Notes Management
  async function loadUserNotes() {
    const list = document.getElementById('user-notes-list');
    list.innerHTML = 'Loading notes...';
    try {
      const res = await api('GET', `/admin/notes?target_type=user&target_id=${selectedUserId}`);
      const notes = res.notes || [];
      if (notes.length === 0) {
        list.innerHTML = '<div class="empty-state">No administrative notes recorded.</div>';
        return;
      }
      list.innerHTML = notes.map(n => `
        <div class="note-card">
          <div class="note-header">
            <span class="note-author">${n.author_email || 'Admin'}</span>
            <span>${formatDate(n.created_at)}</span>
          </div>
          <div>${n.content}</div>
        </div>
      `).join('');
    } catch {
      list.innerHTML = 'Failed to load notes.';
    }
  }

  window.addUserNote = async function () {
    const input = document.getElementById('user-note-input');
    const note = input.value.trim();
    if (!note) return;

    try {
      await api('POST', '/admin/notes', {
        target_type: 'user',
        target_id: String(selectedUserId),
        content: note
      });
      input.value = '';
      showToast('Note added successfully.', 'success');
      loadUserNotes();
    } catch (err) {
      showToast('Failed to add note.', 'error');
    }
  };

  /* Direct Messages */
  async function loadUserMessages() {
    const list = document.getElementById('user-messages-list');
    list.innerHTML = '<div class="empty-state">Loading messages...</div>';

    try {
      const res = await api('GET', `/admin/users/${selectedUserId}/messages`);
      const msgs = res.messages;

      if (!msgs || msgs.length === 0) {
        list.innerHTML = '<div class="empty-state">No administrative messages found.</div>';
        return;
      }

      list.innerHTML = msgs.map(m => `
        <div class="note-card">
          <div class="note-header">
            <span class="note-author">${escapeHtml(m.sender_name || 'System')}</span>
            <span class="note-time" title="${new Date(m.created_at).toLocaleString()}">${timeAgo(m.created_at)}</span>
          </div>
          <div class="note-content" style="margin-bottom: 8px;">${escapeHtml(m.content)}</div>
          <div style="font-size: 11px; color: var(--text-muted); display: flex; gap: 12px;">
            <span><strong style="color: var(--text-main);">Status:</strong> ${m.status}</span>
            ${m.delivered_at ? `<span><strong>Delivered:</strong> ${timeAgo(m.delivered_at)}</span>` : ''}
            ${m.read_at ? `<span><strong>Read:</strong> ${timeAgo(m.read_at)}</span>` : ''}
          </div>
        </div>
      `).join('');
    } catch (err) {
      list.innerHTML = '<div class="empty-state text-danger">Failed to load messages</div>';
    }
  }

  window.sendAdminMessage = async function () {
    const input = document.getElementById('user-message-input');
    const msg = input.value.trim();
    if (!msg) return;

    try {
      await api('POST', `/admin/users/${selectedUserId}/messages`, { content: msg });
      input.value = '';
      showToast('Message sent to user successfully.', 'success');
      loadUserMessages();
    } catch (err) {
      console.error('sendAdminMessage error:', err);
      showToast(`Failed to send message: ${err.message || 'Unknown error'}`, 'error');
    }
  };

  /* User Status Updates (Ban/Suspend) */
  window.openChangeRoleModal = function () {
    const uRole = document.getElementById('user-detail-role').textContent;
    document.getElementById('change-role-select').value = uRole;
    document.getElementById('change-role-modal').classList.add('open');
  };

  window.closeChangeRoleModal = function () {
    document.getElementById('change-role-modal').classList.remove('open');
  };

  window.submitChangeRole = async function () {
    const role = document.getElementById('change-role-select').value;
    try {
      await api('PATCH', `/admin/users/${selectedUserId}/role`, { role });
      showToast('Role updated successfully.', 'success');
      closeChangeRoleModal();
      openUserDrawer(selectedUserId); // refresh
      loadUsersTable();
    } catch {}
  };

  window.openChangeStatusModal = function () {
    const uStatus = document.getElementById('user-detail-status').textContent;
    document.getElementById('change-status-select').value = uStatus;
    document.getElementById('change-status-reason').value = '';
    document.getElementById('change-status-modal').classList.add('open');
  };

  window.closeChangeStatusModal = function () {
    document.getElementById('change-status-modal').classList.remove('open');
  };

  window.submitChangeStatus = async function () {
    const status = document.getElementById('change-status-select').value;
    const reason = document.getElementById('change-status-reason').value.trim();

    try {
      await api('PATCH', `/admin/users/${selectedUserId}/status`, { status, reason });
      showToast('User status updated successfully.', 'success');
      closeChangeStatusModal();
      openUserDrawer(selectedUserId); // refresh
      loadUsersTable();
    } catch {}
  };

  window.deleteUserAccount = async function () {
    if (!await window.ipemDialog.confirm('Are you sure you want to completely delete this user? This will delete the user account, all associated database records, and all generated files/directories on disk.', {
      title: 'Delete user account', confirmText: 'Continue', danger: true
    })) {
      return;
    }
    const doubleConfirm = await window.ipemDialog.prompt('Please type DELETE (in capital letters) to confirm this action:', {
      title: 'Confirm permanent deletion', confirmText: 'Delete account', placeholder: 'Type DELETE', danger: true, required: true
    });
    if (doubleConfirm !== 'DELETE') {
      showToast('Deletion canceled. You must type DELETE to confirm.', 'warning');
      return;
    }
    try {
      await api('DELETE', `/admin/users/${selectedUserId}`);
      showToast('User account deleted successfully.', 'success');
      closeUserDrawer();
      loadUsersTable();
    } catch (err) {
      showToast('Failed to delete user account: ' + err.message, 'error');
    }
  };

  /* ─── VIEW 3: PROGRAMS LIST & MODERATION ─── */
  async function loadProgramsTable() {
    const tbody = document.querySelector('#programs-table tbody');
    tbody.innerHTML = '<tr><td colspan="8"><div class="skeleton skeleton-rect" style="height: 120px;"></div></td></tr>';

    try {
      const q = states.programs;
      const res = await api('GET', `/admin/programs?search=${encodeURIComponent(q.search)}&limit=${q.limit}&offset=${q.offset}`);

      const progs = res.programs || [];
      if (progs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">No programs found.</div></td></tr>';
        return;
      }

      tbody.innerHTML = progs.map(p => `
        <tr onclick="openProgramDrawer(${p.id})" style="cursor:pointer;">
          <td class="cell-bold">${p.name}</td>
          <td>
            <div class="cell-bold">${p.owner_name || 'User'}</div>
            <div class="cell-mono" style="font-size: 11px;">${p.owner_email || '—'}</div>
          </td>
          <td><span class="badge badge-user">${p.language || 'py'}</span></td>
          <td><span class="badge badge-${p.status === 'active' ? 'active' : 'suspended'}">${p.status || 'active'}</span></td>
          <td class="cell-mono">${p.executions_count ?? 0}</td>
          <td class="cell-mono">${p.success_rate ? `${p.success_rate.toFixed(1)}%` : '—'}</td>
          <td>${formatDate(p.updated_at || p.created_at)}</td>
          <td>
            <button class="btn btn-xs" onclick="event.stopPropagation(); openProgramDrawer(${p.id})">Manage</button>
          </td>
        </tr>
      `).join('');

      document.getElementById('programs-pagination-info').textContent = `Showing ${q.offset + 1}-${q.offset + progs.length} programs`;
      document.getElementById('programs-prev-btn').disabled = q.offset === 0;
      document.getElementById('programs-next-btn').disabled = progs.length < q.limit;
    } catch {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Error loading programs metadata.</div></td></tr>';
    }
  }

  window.openProgramDrawer = async function (id) {
    selectedProgramId = id;
    const drawer = document.getElementById('program-drawer');
    const backdrop = document.getElementById('program-drawer-backdrop');
    drawer.classList.add('open');
    backdrop.classList.add('open');

    try {
      const res = await api('GET', `/admin/programs/${id}`);
      const p = res.program;

      document.getElementById('program-detail-name').textContent = p.name || '—';
      document.getElementById('program-detail-lang').textContent = p.language || '—';
      document.getElementById('program-detail-owner').textContent = p.owner_user_id || '—';

      const statusText = p.status || 'active';
      let isLocked = false;
      try {
        if (p.metadata_json) {
          const meta = JSON.parse(p.metadata_json);
          isLocked = meta.locked === true;
        }
      } catch (e) {}
      document.getElementById('program-detail-status').textContent = isLocked ? `${statusText} (Locked)` : statusText;

      switchDrawerTab('program', drawerTabs.program);
    } catch {
      showToast('Failed to load program details.', 'error');
    }
  };

  window.closeProgramDrawer = function () {
    const drawer = document.getElementById('program-drawer');
    drawer.classList.remove('open');
    drawer.classList.remove('wide');
    document.getElementById('program-drawer-backdrop').classList.remove('open');
    closeUserDrawer();
  };

  window.toggleProgramStatus = async function () {
    const curStatus = document.getElementById('program-detail-status').textContent;
    const nextStatus = curStatus.includes('active') ? 'suspended' : 'active';
    try {
      await api('PATCH', `/admin/programs/${selectedProgramId}/status`, { status: nextStatus });
      showToast('Program status toggled.', 'success');
      openProgramDrawer(selectedProgramId);
      loadProgramsTable();
    } catch {}
  };

  window.toggleProgramLock = async function () {
    const curStatus = document.getElementById('program-detail-status').textContent;
    const locked = curStatus.includes('Locked');
    const endpoint = locked ? `/admin/programs/${selectedProgramId}/unlock` : `/admin/programs/${selectedProgramId}/lock`;

    try {
      await api('POST', endpoint);
      showToast(locked ? 'Execution unlocked.' : 'Execution locked.', 'success');
      openProgramDrawer(selectedProgramId);
      loadProgramsTable();
    } catch {}
  };

  window.deleteProgram = async function () {
    if (!await window.ipemDialog.confirm('Are you sure you want to delete this program?', { title: 'Delete program', confirmText: 'Delete', danger: true })) return;
    try {
      await api('DELETE', `/admin/programs/${selectedProgramId}`);
      showToast('Program deleted.', 'success');
      closeProgramDrawer();
      loadProgramsTable();
    } catch {}
  };

  async function loadProgramNotes() {
    const list = document.getElementById('program-notes-list');
    list.innerHTML = 'Loading notes...';
    try {
      const res = await api('GET', `/admin/notes?target_type=program&target_id=${selectedProgramId}`);
      const notes = res.notes || [];
      list.innerHTML = notes.length === 0
        ? '<div class="empty-state">No admin notes for this program.</div>'
        : notes.map(n => `
          <div class="note-card">
            <div class="note-header">
              <span class="note-author">${n.author_email || 'Admin'}</span>
              <span>${formatDate(n.created_at)}</span>
            </div>
            <div>${n.content}</div>
          </div>
        `).join('');
    } catch { list.innerHTML = 'Error loading notes.'; }
  }

  window.addProgramNote = async function () {
    const input = document.getElementById('program-note-input');
    const note = input.value.trim();
    if (!note) return;
    try {
      await api('POST', '/admin/notes', { target_type: 'program', target_id: String(selectedProgramId), content: note });
      input.value = '';
      loadProgramNotes();
    } catch {}
  };

  /* ─── VIEW 4: CONVERSATIONS LIST & MODERATION ─── */
  async function loadConversationsTable() {
    const tbody = document.querySelector('#conversations-table tbody');
    tbody.innerHTML = '<tr><td colspan="7"><div class="skeleton skeleton-rect" style="height: 120px;"></div></td></tr>';

    try {
      const q = states.conversations;
      const res = await api('GET', `/admin/conversations?search=${encodeURIComponent(q.search)}&limit=${q.limit}&offset=${q.offset}`);

      const convs = res.conversations || [];
      if (convs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No conversations found.</div></td></tr>';
        return;
      }

      tbody.innerHTML = convs.map(c => `
        <tr onclick="openConvDrawer(${c.id})" style="cursor:pointer;">
          <td class="cell-bold">${c.title || 'Untitled Session'}</td>
          <td>
            <div class="cell-bold">${c.user_name || 'User'}</div>
            <div class="cell-mono" style="font-size: 11px;">${c.user_email || '—'}</div>
          </td>
          <td class="cell-mono">${c.messages_count ?? 0}</td>
          <td><span class="badge badge-${c.status === 'active' ? 'active' : 'suspended'}">${c.status || 'active'}</span></td>
          <td>${formatDate(c.created_at)}</td>
          <td>${formatDate(c.last_message_at || c.updated_at || c.created_at)}</td>
          <td>
            <button class="btn btn-xs" onclick="event.stopPropagation(); openConvDrawer(${c.id})">Manage</button>
          </td>
        </tr>
      `).join('');

      document.getElementById('conversations-pagination-info').textContent = `Showing ${q.offset + 1}-${q.offset + convs.length} conversations`;
      document.getElementById('conversations-prev-btn').disabled = q.offset === 0;
      document.getElementById('conversations-next-btn').disabled = convs.length < q.limit;
    } catch {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Error loading conversations.</div></td></tr>';
    }
  }

  window.openConvDrawer = async function (id) {
    selectedConvId = id;
    const drawer = document.getElementById('conv-drawer');
    const backdrop = document.getElementById('conv-drawer-backdrop');
    drawer.classList.add('open');
    backdrop.classList.add('open');

    try {
      const res = await api('GET', `/admin/conversations/${id}`);
      const c = res.conversation;

      document.getElementById('conv-detail-title').textContent = c.title || 'Untitled Session';
      document.getElementById('conv-detail-owner').textContent = c.user_id || '—';
      document.getElementById('conv-detail-session').textContent = c.session_id || '—';
      document.getElementById('conv-detail-status').textContent = c.status || 'active';

      const adminMsgSection = document.getElementById('conv-admin-message-section');
      adminMsgSection.style.display = 'block';
      selectedUserId = c.user_id; // For sending the message

      switchDrawerTab('conv', drawerTabs.conv);
      loadAdminConvMessages();
    } catch {
      showToast('Failed to load conversation details.', 'error');
    }
  };

  window.closeConvDrawer = function () {
    document.getElementById('conv-drawer').classList.remove('open');
    document.getElementById('conv-drawer-backdrop').classList.remove('open');
    closeUserDrawer();
  };

  window.sendAdminMessageFromConv = async function () {
    const input = document.getElementById('conv-admin-message-input');
    const msg = input.value.trim();
    if (!msg) return;

    try {
      await api('POST', `/admin/conversations/${selectedConvId}/messages`, { content: msg });
      input.value = '';
      document.getElementById('conv-admin-message-chars').textContent = '0/5000';
      showToast('Message sent inline successfully.', 'success');
      loadAdminConvMessages();
    } catch (err) {
      console.error('sendAdminMessageFromConv error:', err);
      showToast(`Failed to send message: ${err.message || 'Unknown error'}`, 'error');
    }
  };

  async function loadAdminConvMessages() {
    const msgList = document.getElementById('conv-messages-list');
    if (!msgList) return;
    msgList.innerHTML = '<div class="empty-state">Loading transcript...</div>';
    try {
      const res = await api('GET', `/admin/conversations/${selectedConvId}`);
      const msgs = res.messages || [];
      if (msgs.length === 0) {
        msgList.innerHTML = '<div class="empty-state">No messages in this conversation.</div>';
      } else {
        msgList.innerHTML = msgs.map(m => {
          let roleLabel = 'IPEM';
          let roleColor = 'var(--blue)';
          let bgColor = 'rgba(255, 255, 255, 0.01)';
          let borderStyle = '1px solid var(--border)';

          if (m.role === 'admin') {
            roleLabel = 'ADMIN';
            roleColor = 'var(--red)';
            bgColor = 'rgba(239, 108, 108, 0.05)';
            borderStyle = '1px solid rgba(239, 108, 108, 0.2)';
          } else if (m.role === 'user') {
            roleLabel = 'USER';
            roleColor = 'var(--accent)';
            bgColor = 'rgba(255, 255, 255, 0.03)';
          } else if (m.role === 'system') {
            roleLabel = 'SYSTEM';
            roleColor = 'var(--amber)';
            bgColor = 'rgba(255, 255, 255, 0.02)';
            borderStyle = '1px solid rgba(245, 158, 11, 0.2)';
          } else if (m.role === 'assistant' || m.role === 'ipem') {
            roleLabel = 'IPEM';
            roleColor = 'var(--blue)';
            bgColor = 'rgba(255, 255, 255, 0.01)';
          }

          const timeStr = new Date(m.created_at).toLocaleString();

          return `
            <div style="padding: 10px; background: ${bgColor}; border: ${borderStyle}; border-radius: var(--radius); margin-bottom: 8px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 11px;">
                <span style="font-weight: 600; color: ${roleColor}; font-family: var(--mono);">${roleLabel}</span>
                <span style="color: var(--text-dark);">${timeStr}</span>
              </div>
              <div style="font-size: 12px; color: var(--text-light); white-space: pre-wrap; line-height: 1.4;">${escapeHtml(m.content)}</div>
            </div>
          `;
        }).join('');

        // Scroll to the bottom
        setTimeout(() => {
          msgList.scrollTop = msgList.scrollHeight;
        }, 50);
      }
    } catch (err) {
      msgList.innerHTML = '<div class="empty-state text-danger">Failed to load transcript.</div>';
    }
  }

  window.toggleConvStatus = async function () {
    const curStatus = document.getElementById('conv-detail-status').textContent;
    const nextStatus = curStatus.includes('active') ? 'locked' : 'active';
    try {
      const res = await api('PATCH', `/admin/conversations/${selectedConvId}/status`, { status: nextStatus });
      if (res.error) throw new Error(res.error);
      showToast('Conversation status toggled.', 'success');
      openConvDrawer(selectedConvId);
      loadConversationsTable();
    } catch {}
  };

  window.deleteConv = async function () {
    if (!await window.ipemDialog.confirm('Are you sure you want to delete this conversation?', { title: 'Delete conversation', confirmText: 'Delete', danger: true })) return;
    try {
      const res = await api('DELETE', `/admin/conversations/${selectedConvId}`);
      if (res.error) throw new Error(res.error);
      showToast('Conversation deleted.', 'success');
      closeConvDrawer();
      loadConversationsTable();
    } catch (err) {
      showToast('Failed to delete conversation: ' + err.message, 'error');
    }
  };

  async function loadConvNotes() {
    const list = document.getElementById('conv-notes-list');
    list.innerHTML = 'Loading notes...';
    try {
      const res = await api('GET', `/admin/notes?target_type=conversation&target_id=${selectedConvId}`);
      const notes = res.notes || [];
      list.innerHTML = notes.length === 0
        ? '<div class="empty-state">No admin notes for this conversation.</div>'
        : notes.map(n => `
          <div class="note-card">
            <div class="note-header">
              <span class="note-author">${n.author_email || 'Admin'}</span>
              <span>${formatDate(n.created_at)}</span>
            </div>
            <div>${n.content}</div>
          </div>
        `).join('');
    } catch { list.innerHTML = 'Error loading notes.'; }
  }

  window.addConvNote = async function () {
    const input = document.getElementById('conv-note-input');
    const note = input.value.trim();
    if (!note) return;
    try {
      await api('POST', '/admin/notes', { target_type: 'conversation', target_id: String(selectedConvId), content: note });
      input.value = '';
      loadConvNotes();
    } catch {}
  };

  /* ─── VIEW 5: REQUESTS ANALYTICS ─── */
  async function loadAnalyticsRequests() {
    try {
      const res = await api('GET', '/admin/analytics/requests');
      const sum = res.summary || {};

      document.getElementById('requests-stat-total').textContent = sum.totalRequests ?? 0;
      document.getElementById('requests-stat-avg-latency').textContent = sum.averageLatencyMs ? `${sum.averageLatencyMs.toFixed(0)} ms` : '—';
      document.getElementById('requests-stat-error-rate').textContent = sum.errorRatePercentage ? `${sum.errorRatePercentage.toFixed(1)}%` : '0.0%';

      // Populate endpoints tables
      const endpointsRes = await api('GET', '/admin/analytics/endpoints');
      const topTbody = document.querySelector('#requests-top-endpoints-table tbody');
      const slowTbody = document.querySelector('#requests-slowest-endpoints-table tbody');

      topTbody.innerHTML = (endpointsRes.topEndpoints || []).map(e => `
        <tr>
          <td class="cell-bold">${e.route}</td>
          <td><span class="badge badge-user">${e.method}</span></td>
          <td class="cell-mono">${e.count}</td>
          <td class="cell-mono">${e.avgLatency ? `${e.avgLatency.toFixed(0)} ms` : '—'}</td>
        </tr>
      `).join('');

      slowTbody.innerHTML = (endpointsRes.slowestEndpoints || []).map(e => `
        <tr>
          <td class="cell-bold">${e.route}</td>
          <td><span class="badge badge-user">${e.method}</span></td>
          <td class="cell-mono">${e.avgLatency ? `${e.avgLatency.toFixed(0)} ms` : '—'}</td>
          <td class="cell-mono">${e.count}</td>
        </tr>
      `).join('');

    } catch (err) {
      console.error('Requests analytics load failed', err);
    }
  }

  /* ─── VIEW 6: USER ACTIVITY ANALYTICS ─── */
  async function loadAnalyticsActivity() {
    try {
      const res = await api('GET', '/admin/analytics/activity');
      const tbody = document.querySelector('#activity-top-users-table tbody');

      const users = res.mostActiveUsers || [];
      if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No user activity recorded.</div></td></tr>';
        return;
      }

      tbody.innerHTML = users.map(u => `
        <tr>
          <td>
            <div class="cell-bold">${u.name || 'User'}</div>
            <div class="cell-mono" style="font-size: 11px;">${u.email}</div>
          </td>
          <td class="cell-mono">${u.activityCount ?? 0}</td>
          <td class="cell-mono">${u.programsCreated ?? 0}</td>
          <td class="cell-mono">${u.executions ?? 0}</td>
          <td>${u.last_login ? formatDate(u.last_login) : '—'}</td>
        </tr>
      `).join('');
    } catch {}
  }

  /* ─── VIEW 7: AI USAGE & REAL-TIME ANALYTICS ─── */
  let currentAiTimelineRange = '7d';
  let currentAiTimelineData = [];
  let currentAiRecentRequests = [];

  window.setAiTimelineRange = function(range) {
    currentAiTimelineRange = range;
    ['24h', '7d', '30d', 'all'].forEach(r => {
      const btn = document.getElementById(`range-btn-${r}`);
      if (btn) {
        if (r === range) {
          btn.className = 'btn btn-xs btn-primary ai-range-btn';
        } else {
          btn.className = 'btn btn-xs btn-secondary ai-range-btn';
        }
      }
    });
    fetchAiTimelineData();
  };

  async function fetchAiTimelineData() {
    try {
      const res = await api('GET', `/admin/ai/timeline?range=${currentAiTimelineRange}`);
      currentAiTimelineData = res?.series || [];
      renderAiTimelineChart();
    } catch(err) {
      console.error('[AI Timeline]', err);
    }
  }

  window.renderAiTimelineChart = function() {
    const container = document.getElementById('ai-chart-tokens');
    const labelsEl = document.getElementById('ai-chart-labels');
    const metricSelect = document.getElementById('ai-timeline-metric');
    if (!container) return;

    const metric = metricSelect ? metricSelect.value : 'requests';

    if (!currentAiTimelineData || currentAiTimelineData.length === 0) {
      container.innerHTML = '<div class="empty-state" style="width:100%;">No telemetry recorded for this timeframe.</div>';
      if (labelsEl) labelsEl.innerHTML = '<span>Start</span><span>End</span>';
      return;
    }

    const data = currentAiTimelineData;
    let maxVal = 1;

    data.forEach(d => {
      const val = metric === 'cost' ? (d.cost || 0) : metric === 'tokens' ? (d.tokens || 0) : metric === 'latency' ? (d.latency || 0) : (d.requests || 0);
      if (val > maxVal) maxVal = val;
    });

    container.innerHTML = data.map(d => {
      const rawVal = metric === 'cost' ? (d.cost || 0) : metric === 'tokens' ? (d.tokens || 0) : metric === 'latency' ? (d.latency || 0) : (d.requests || 0);
      const heightPct = Math.max(4, Math.min(100, (rawVal / maxVal) * 100));

      let displayStr = '';
      if (metric === 'cost') displayStr = `$${rawVal.toFixed(4)}`;
      else if (metric === 'latency') displayStr = `${Math.round(rawVal)} ms`;
      else displayStr = rawVal.toLocaleString();

      return `
        <div class="chart-bar" style="height: ${heightPct}%; flex: 1; min-width: 8px; position: relative;">
          <div class="chart-bar-tooltip">${d.time_point}: ${displayStr} (${(d.requests || 0)} reqs, ${(d.tokens || 0).toLocaleString()} tok)</div>
        </div>
      `;
    }).join('');

    if (labelsEl && data.length > 0) {
      labelsEl.innerHTML = `
        <span>${data[0].time_point}</span>
        <span>${data[Math.floor(data.length / 2)].time_point}</span>
        <span>${data[data.length - 1].time_point}</span>
      `;
    }
  };

  async function loadAnalyticsAi() {
    try {
      const [summaryRes, providersRes, modelsRes, litellmRes, ollamaRes, groqRes, healthRes, costsRes, recentRes] = await Promise.all([
        api('GET', '/admin/ai/summary'),
        api('GET', '/admin/ai/providers'),
        api('GET', '/admin/ai/models'),
        api('GET', '/admin/ai/litellm'),
        api('GET', '/admin/ai/ollama'),
        api('GET', '/admin/ai/groq'),
        api('GET', '/admin/ai/health'),
        api('GET', '/admin/ai/costs'),
        api('GET', '/admin/ai/recent?limit=50')
      ]);

      // 1. Summary Cards (12 Cards)
      const s = summaryRes?.summary || {};
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };

      setVal('ai-stat-reqs-24h', (s.total_requests_24h || 0).toLocaleString());
      setVal('ai-stat-reqs-all', (s.total_requests_all_time || 0).toLocaleString());
      setVal('ai-stat-succ-reqs', (s.successful_requests || 0).toLocaleString());
      setVal('ai-stat-fail-reqs', (s.failed_requests || 0).toLocaleString());
      setVal('ai-stat-success-rate', `${s.success_rate || 100}%`);
      setVal('ai-stat-avg-latency', `${s.avg_latency_ms || 0} ms`);
      setVal('ai-stat-total-tokens', (s.total_tokens || 0).toLocaleString());
      setVal('ai-stat-prompt-tokens', (s.prompt_tokens || 0).toLocaleString());
      setVal('ai-stat-completion-tokens', (s.completion_tokens || 0).toLocaleString());
      setVal('ai-stat-total-cost', s.total_cost > 0 ? `$${s.total_cost.toFixed(4)}` : '$0.00 (Free Provider)');
      setVal('ai-stat-cost-today', s.cost_today > 0 ? `$${s.cost_today.toFixed(4)}` : '$0.00 (Free Provider)');
      setVal('ai-stat-cost-month', s.cost_month > 0 ? `$${s.cost_month.toFixed(4)}` : '$0.00 (Free Provider)');

      // 2. LiteLLM Gateway Card
      const lBadge = document.getElementById('litellm-status-badge');
      if (lBadge) {
        lBadge.className = litellmRes?.status === 'Running' ? 'badge badge-success' : 'badge badge-danger';
        lBadge.textContent = litellmRes?.status || 'Offline';
      }
      setVal('litellm-reqs', (litellmRes?.total_requests || 0).toLocaleString());
      setVal('litellm-latency', `${litellmRes?.avg_response_time_ms || 0} ms`);
      setVal('litellm-providers-count', (litellmRes?.configured_providers_count || 0).toString());
      setVal('litellm-routing', litellmRes?.routing_strategy || 'simple-shuffle');

      const litellmListEl = document.getElementById('litellm-models-list');
      if (litellmListEl) {
        const models = litellmRes?.configured_models || [];
        if (models.length === 0) {
          litellmListEl.innerHTML = '<div style="color:var(--text-dark);">No configured models in litellm_config.yaml</div>';
        } else {
          litellmListEl.innerHTML = models.map(m => `
            <div>• <strong style="color:var(--text-bright);">${m.alias}</strong> → ${m.target_model} (order:${m.order})</div>
          `).join('');
        }
      }

      // 3. Ollama Card
      const oBadge = document.getElementById('ollama-status-badge');
      if (oBadge) {
        oBadge.className = ollamaRes?.status === 'Running' ? 'badge badge-success' : 'badge badge-danger';
        oBadge.textContent = ollamaRes?.status || 'Offline';
      }
      setVal('ollama-models-count', (ollamaRes?.available_models_count || 0).toString());
      setVal('ollama-active-count', (ollamaRes?.active_models?.length || 0).toString());
      setVal('ollama-reqs', (ollamaRes?.number_of_requests || 0).toLocaleString());
      setVal('ollama-latency', `${ollamaRes?.avg_latency_ms || 0} ms`);

      const ollamaListEl = document.getElementById('ollama-models-list');
      if (ollamaListEl) {
        const downloaded = ollamaRes?.downloaded_models || [];
        if (downloaded.length === 0) {
          ollamaListEl.innerHTML = '<div style="color:var(--text-dark);">No downloaded models found in Ollama</div>';
        } else {
          ollamaListEl.innerHTML = downloaded.map(m => `
            <div>• <strong style="color:var(--text-bright);">${m.name}</strong> (${m.size_mb} MB) [${m.details?.parameter_size || 'local'}]</div>
          `).join('');
        }
      }

      // 4. Groq Card
      setVal('groq-reqs', (groqRes?.requests || 0).toLocaleString());
      setVal('groq-latency', `${groqRes?.avg_latency_ms || 0} ms`);

      // 5. Provider Health Table
      const healthTbody = document.querySelector('#ai-provider-health-table tbody');
      if (healthTbody) {
        const healthList = healthRes?.health || [];
        if (healthList.length === 0) {
          healthTbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">No provider health data.</div></td></tr>';
        } else {
          healthTbody.innerHTML = healthList.map(h => `
            <tr>
              <td class="cell-bold">${h.provider}</td>
              <td><span class="badge ${h.status === 'Healthy' ? 'badge-success' : 'badge-danger'}">${h.status}</span></td>
              <td class="cell-mono">${h.avg_latency_ms} ms</td>
              <td><span style="font-size:11px;color:var(--text-dark);">${h.rate_limit_remaining}</span></td>
              <td class="cell-mono" style="font-size:11px;color:${h.last_error !== 'None' ? 'var(--danger)' : 'var(--text-dark)'};">${h.last_error}</td>
              <td class="cell-mono" style="font-size:11px;">${h.last_success}</td>
            </tr>
          `).join('');
        }
      }

      // 6. Provider Usage Table
      const providerTbody = document.querySelector('#ai-provider-usage-table tbody');
      if (providerTbody) {
        const providers = providersRes?.providers || [];
        if (providers.length === 0) {
          providerTbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No provider activity recorded.</div></td></tr>';
        } else {
          providerTbody.innerHTML = providers.map(p => `
            <tr>
              <td class="cell-bold">${p.provider}</td>
              <td class="cell-mono">${(p.request_count || 0).toLocaleString()}</td>
              <td class="cell-mono">${(p.total_tokens || 0).toLocaleString()}</td>
              <td class="cell-mono">${p.avg_latency_ms} ms</td>
              <td class="cell-mono" style="color:${p.is_free ? 'var(--success)' : 'inherit'}; font-weight:${p.is_free ? '600' : 'normal'};">
                ${p.is_free ? 'Free ($0.00)' : `$${(p.estimated_cost || 0).toFixed(4)}`}
              </td>
            </tr>
          `).join('');
        }
      }

      // 7. Model Usage Table
      const modelTbody = document.querySelector('#ai-model-dist-table tbody');
      if (modelTbody) {
        const models = modelsRes?.models || [];
        if (models.length === 0) {
          modelTbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No model usage recorded.</div></td></tr>';
        } else {
          modelTbody.innerHTML = models.map(m => `
            <tr>
              <td class="cell-bold">${m.model || '—'} <span style="font-size:10px;color:var(--text-dark)">(${m.provider || '—'})</span></td>
              <td class="cell-mono">${(m.request_count || 0).toLocaleString()}</td>
              <td class="cell-mono">${(m.total_tokens || 0).toLocaleString()}</td>
              <td class="cell-mono">${m.success_rate}%</td>
              <td class="cell-mono" style="color:${m.is_free ? 'var(--success)' : 'inherit'}; font-weight:${m.is_free ? '600' : 'normal'};">
                ${m.is_free ? 'Free' : `$${(m.total_cost || 0).toFixed(4)}`}
              </td>
            </tr>
          `).join('');
        }
      }

      // 8. Cost Breakdown Table
      const costTbody = document.querySelector('#ai-cost-breakdown-table tbody');
      if (costTbody) {
        const byUser = costsRes?.by_user || [];
        const byConv = costsRes?.by_conversation || [];
        const byModel = costsRes?.by_model || [];

        let rowsHtml = '';
        byModel.forEach(m => {
          rowsHtml += `
            <tr>
              <td><span class="badge badge-info">Model</span></td>
              <td class="cell-bold">${m.model}</td>
              <td class="cell-mono" style="font-size:11px;">${m.provider}</td>
              <td class="cell-mono">—</td>
              <td class="cell-mono">$${(m.total_cost || 0).toFixed(4)}</td>
            </tr>
          `;
        });
        byUser.forEach(u => {
          rowsHtml += `
            <tr>
              <td><span class="badge badge-secondary">User</span></td>
              <td class="cell-bold">${u.user_email || u.user_name || 'User ' + u.user_id}</td>
              <td class="cell-mono" style="font-size:11px;">ID: ${u.user_id}</td>
              <td class="cell-mono">—</td>
              <td class="cell-mono">$${(u.total_cost || 0).toFixed(4)}</td>
            </tr>
          `;
        });
        byConv.slice(0, 10).forEach(c => {
          rowsHtml += `
            <tr>
              <td><span class="badge">Session</span></td>
              <td class="cell-bold">${c.conversation_title || c.session_id}</td>
              <td class="cell-mono" style="font-size:11px;">${c.user_email || 'Session'}</td>
              <td class="cell-mono">${c.request_count}</td>
              <td class="cell-mono">$${(c.total_cost || 0).toFixed(4)}</td>
            </tr>
          `;
        });

        costTbody.innerHTML = rowsHtml || '<tr><td colspan="5"><div class="empty-state">No cost data available.</div></td></tr>';
      }

      // 9. Recent Activity Log Table
      const recentTbody = document.querySelector('#ai-recent-activity-table tbody');
      currentAiRecentRequests = recentRes?.requests || [];

      if (recentTbody) {
        if (currentAiRecentRequests.length === 0) {
          recentTbody.innerHTML = '<tr><td colspan="12"><div class="empty-state">No recent activity recorded.</div></td></tr>';
        } else {
          recentTbody.innerHTML = currentAiRecentRequests.map(r => `
            <tr style="cursor:pointer;" onclick="openAiRequestDetailModal(${r.id})">
              <td class="cell-mono" style="font-size:11px;">${r.timestamp ? r.timestamp.slice(5, 16) : '—'}</td>
              <td class="cell-bold" style="font-size:11px;">${r.user_email || 'User ' + r.user_id}</td>
              <td class="cell-mono" style="font-size:11px;">${r.session_id ? r.session_id.slice(-8) : '—'}</td>
              <td style="font-size:11px;">${r.provider}</td>
              <td class="cell-mono" style="font-size:11px;">${r.model}</td>
              <td class="cell-mono">${r.prompt_length || 0}</td>
              <td class="cell-mono">${r.completion_length || 0}</td>
              <td class="cell-mono">${r.latency_ms} ms</td>
              <td class="cell-mono">${r.total_tokens}</td>
              <td><span class="badge ${r.success ? 'badge-success' : 'badge-danger'}" style="font-size:10px;">${r.success ? 'Success' : 'Error'}</span></td>
              <td class="cell-mono" style="font-size:11px; color:${r.is_free ? 'var(--success)' : 'inherit'};">${r.cost_display}</td>
              <td><button class="btn btn-xs btn-secondary" onclick="event.stopPropagation(); openAiRequestDetailModal(${r.id});">Inspect</button></td>
            </tr>
          `).join('');
        }
      }

      // Fetch Timeline
      await fetchAiTimelineData();

    } catch (err) {
      console.error('[AI Analytics]', err);
    }
  }

  /* ─── VIEW 8: SECURITY FLAGS ─── */
  async function loadSecurityFlags() {
    const tbody = document.querySelector('#security-flags-table tbody');
    tbody.innerHTML = '<tr><td colspan="7"><div class="skeleton skeleton-rect" style="height: 120px;"></div></td></tr>';

    try {
      const res = await api('GET', '/admin/security/flags');
      const flags = res.flags || [];
      if (flags.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No active security flags reported.</div></td></tr>';
        return;
      }

      tbody.innerHTML = flags.map(f => `
        <tr>
          <td><span class="badge badge-${f.severity === 'high' ? 'high' : f.severity === 'medium' ? 'medium' : 'low'}">${f.severity}</span></td>
          <td class="cell-bold">${f.type.replace(/_/g, ' ')}</td>
          <td>${f.user_email || '—'}</td>
          <td class="cell-mono">${f.ip_address || '—'}</td>
          <td>${formatDate(f.timestamp)}</td>
          <td><span class="badge ${f.resolved ? 'badge-active' : 'badge-suspended'}">${f.resolved ? 'Resolved' : 'Open'}</span></td>
          <td>
            ${f.resolved ? '—' : `<button class="btn btn-xs btn-primary" onclick="resolveFlag(${f.id})">Resolve</button>`}
          </td>
        </tr>
      `).join('');
    } catch {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Error loading security center.</div></td></tr>';
    }
  }

  window.resolveFlag = async function (id) {
    try {
      await api('POST', `/admin/security/flags/${id}/resolve`);
      showToast('Security flag resolved.', 'success');
      loadSecurityFlags();
    } catch {}
  };

  /* ─── VIEW 9: SECURITY INCIDENTS ─── */
  async function loadSecurityIncidents() {
    const tbody = document.querySelector('#security-incidents-table tbody');
    tbody.innerHTML = '<tr><td colspan="7"><div class="skeleton skeleton-rect" style="height: 120px;"></div></td></tr>';

    try {
      const res = await api('GET', '/admin/security/incidents');
      const incidents = res.incidents || [];
      if (incidents.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No security threats detected.</div></td></tr>';
        return;
      }

      tbody.innerHTML = incidents.map(i => `
        <tr onclick="openIncidentDrawer(${i.id})" style="cursor:pointer;">
          <td><span class="badge badge-${i.severity === 'HIGH' ? 'high' : i.severity === 'MEDIUM' ? 'medium' : 'low'}">${i.severity}</span></td>
          <td class="cell-mono">#${i.id}</td>
          <td class="cell-bold">${i.title}</td>
          <td>${i.user_id ? `User ID #${i.user_id}` : 'System'}</td>
          <td><span class="badge ${i.status === 'resolved' ? 'badge-active' : 'badge-suspended'}">${i.status}</span></td>
          <td>${formatDate(i.timestamp)}</td>
          <td>
            <button class="btn btn-xs" onclick="event.stopPropagation(); openIncidentDrawer(${i.id})">Inspect</button>
          </td>
        </tr>
      `).join('');
    } catch {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Error loading incidents database.</div></td></tr>';
    }
  }

  window.openIncidentDrawer = async function (id) {
    selectedIncidentId = id;
    const drawer = document.getElementById('incident-drawer');
    const backdrop = document.getElementById('incident-drawer-backdrop');
    drawer.classList.add('open');
    backdrop.classList.add('open');

    try {
      const res = await api('GET', '/admin/security/incidents');
      const incident = res.incidents.find(i => i.id === id);

      document.getElementById('incident-detail-id').textContent = `#${incident.id}`;
      document.getElementById('incident-detail-severity').textContent = incident.severity;
      document.getElementById('incident-detail-title').textContent = incident.title;
      document.getElementById('incident-detail-userid').textContent = incident.user_id || 'System-wide';
      document.getElementById('incident-detail-status').textContent = incident.status;
      document.getElementById('incident-detail-time').textContent = formatDate(incident.timestamp);
      document.getElementById('incident-detail-desc').textContent = incident.description;

      const resolveBtn = document.getElementById('incident-resolve-action-btn');
      const textarea = document.getElementById('incident-resolution-notes');

      if (incident.status === 'resolved') {
        resolveBtn.style.display = 'none';
        textarea.disabled = true;
        textarea.value = incident.resolution_notes || 'Resolved without remarks.';
      } else {
        resolveBtn.style.display = 'block';
        textarea.disabled = false;
        textarea.value = '';
      }
    } catch {
      showToast('Failed to load incident details.', 'error');
    }
  };

  window.closeIncidentDrawer = function () {
    document.getElementById('incident-drawer').classList.remove('open');
    document.getElementById('incident-drawer-backdrop').classList.remove('open');
    closeUserDrawer();
  };

  window.resolveIncidentAction = async function () {
    const notes = document.getElementById('incident-resolution-notes').value.trim();
    try {
      await api('POST', `/admin/security/incidents/${selectedIncidentId}/resolve`, { notes });
      showToast('Incident resolved successfully.', 'success');
      closeIncidentDrawer();
      loadSecurityIncidents();
    } catch {}
  };

  /* ─── VIEW 10: IP INTEL & BANS ─── */
  async function loadSecurityIpIntel() {
    const tbody = document.querySelector('#security-ip-rules-table tbody');
    tbody.innerHTML = '<tr><td colspan="7"><div class="skeleton skeleton-rect" style="height: 80px;"></div></td></tr>';

    try {
      const res = await api('GET', '/admin/security/reputation');
      const reps = res.reputations || [];

      if (reps.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No IP reputation data tracked yet.</div></td></tr>';
        return;
      }

      tbody.innerHTML = reps.map(r => `
        <tr>
          <td class="cell-mono">${r.ip}</td>
          <td class="cell-mono">${r.is_vpn ? 'VPN ' : ''}${r.is_proxy ? 'Proxy ' : ''}${r.is_datacenter ? 'Datacenter ' : ''}${(!r.is_vpn && !r.is_proxy && !r.is_datacenter) ? 'Clean' : ''}</td>
          <td><span class="badge ${r.is_banned ? 'badge-banned' : 'badge-user'}">${r.is_banned ? 'Banned' : 'Allowed'}</span></td>
          <td class="cell-mono">${r.flag_count ?? 0}</td>
          <td class="cell-mono">${r.incident_count ?? 0}</td>
          <td>${formatDate(r.last_seen)}</td>
          <td>
            ${r.is_banned
              ? `<button class="btn btn-xs btn-primary" onclick="unbanIPAddress('${r.ip}')">Unban</button>`
              : `<button class="btn btn-xs btn-danger" onclick="banIPAddressQuick('${r.ip}')">Ban</button>`}
          </td>
        </tr>
      `).join('');
    } catch {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Error loading reputations.</div></td></tr>';
    }
  }

  window.searchIPReputation = async function () {
    const ip = document.getElementById('security-ip-query').value.trim();
    if (!ip) return;

    try {
      const res = await api('GET', `/admin/security/ip/${ip}`);
      const details = document.getElementById('ip-info-card');
      const grid = document.getElementById('ip-details-grid');

      details.style.display = 'block';
      document.getElementById('ip-card-title').textContent = `IP Analysis: ${ip}`;

      const rep = res.reputation || {};
      const ban = res.ban || {};

      grid.innerHTML = `
        <div class="detail-item"><span class="detail-label">Country</span><span class="detail-value">${rep.country || '—'}</span></div>
        <div class="detail-item"><span class="detail-label">City</span><span class="detail-value">${rep.city || '—'}</span></div>
        <div class="detail-item"><span class="detail-label">ASN Group</span><span class="detail-value">${rep.asn || '—'}</span></div>
        <div class="detail-item"><span class="detail-label">Proxy Indicator</span><span class="detail-value">${rep.is_proxy ? 'Yes' : 'No'}</span></div>
        <div class="detail-item"><span class="detail-label">VPN Indicator</span><span class="detail-value">${rep.is_vpn ? 'Yes' : 'No'}</span></div>
        <div class="detail-item"><span class="detail-label">Datacenter Host</span><span class="detail-value">${rep.is_datacenter ? 'Yes' : 'No'}</span></div>
        <div class="detail-item"><span class="detail-label">Ban Status</span><span class="detail-value">${ban.ip ? `Banned (Expires: ${formatDate(ban.expires_at)})` : 'Active / Allowed'}</span></div>
        <div class="detail-item"><span class="detail-label">Ban Reason</span><span class="detail-value">${ban.reason || '—'}</span></div>
      `;
    } catch {
      showToast('IP reputation lookup failed.', 'error');
    }
  };

  window.openBanIPModal = function () {
    document.getElementById('ban-ip-address').value = '';
    document.getElementById('ban-ip-reason').value = '';
    document.getElementById('ip-ban-modal').classList.add('open');
  };

  window.closeBanIPModal = function () {
    document.getElementById('ip-ban-modal').classList.remove('open');
  };

  window.submitBanIP = async function () {
    const ip = document.getElementById('ban-ip-address').value.trim();
    const reason = document.getElementById('ban-ip-reason').value.trim();
    if (!ip) return;

    try {
      await api('POST', '/admin/security/ip/ban', { ip, reason, duration_seconds: 86400 * 7 }); // 1 week default ban
      showToast(`IP ${ip} banned.`, 'success');
      closeBanIPModal();
      loadSecurityIpIntel();
    } catch {}
  };

  window.banIPAddressQuick = async function (ip) {
    if (!await window.ipemDialog.confirm(`Are you sure you want to ban ${ip}?`, { title: 'Ban IP address', confirmText: 'Ban IP', danger: true })) return;
    try {
      await api('POST', '/admin/security/ip/ban', { ip, reason: 'Quick banned via Control Center', duration_seconds: 86400 * 7 });
      showToast(`IP ${ip} banned.`, 'success');
      loadSecurityIpIntel();
    } catch {}
  };

  window.unbanIPAddress = async function (ip) {
    try {
      await api('POST', '/admin/security/ip/unban', { ip });
      showToast(`IP ${ip} unbanned.`, 'success');
      loadSecurityIpIntel();
    } catch {}
  };

  /* ─── VIEW 11: INFRASTRUCTURE & METRICS ─── */
  const restartingServices = new Set();

  function getServiceCardHtml(key, name, svc, canRestart) {
    const isOk = svc?.ok === true;
    const statusClass = isOk ? 'status-ok' : 'status-critical';
    const statusLabel = isOk ? '✓ Online' : '✕ Offline';
    const latency = svc?.latencyMs != null ? `${svc.latencyMs}ms` : '—';
    const errorDetail = !isOk && svc?.error ? svc.error : '';
    const uptime = svc?.uptime ? `Uptime: ${svc.uptime}` : 'Uptime: —';

    let restartBtn = '';
    const currentUser = JSON.parse(localStorage.getItem('ipem_user') || '{}');
    const isAuthorized = ['owner', 'admin'].includes(currentUser.role);

    if (canRestart && isAuthorized) {
      const disabledAttr = restartingServices.has(key) ? 'disabled' : '';
      const btnText = restartingServices.has(key) ? 'Restarting...' : 'Restart';
      restartBtn = `<button class="btn btn-danger btn-xs" style="width:100%;margin-top:auto;justify-content:center;" id="restart-btn-${key}" onclick="restartService('${key}')" ${disabledAttr}>${btnText}</button>`;
    }

    const isRestarting = restartingServices.has(key);
    const cardClass = isRestarting ? 'monitor-card service-card loading' : 'monitor-card service-card';
    const displayStatus = isRestarting ? '⟳ Restarting...' : statusLabel;
    const displayStatusClass = isRestarting ? 'status-warning' : statusClass;

    return `
      <div class="${cardClass}" id="service-card-${key}">
        <div class="monitor-header">
          <span class="monitor-name">${name}</span>
          <span class="monitor-status-pill ${displayStatusClass}" id="status-pill-${key}">${displayStatus}</span>
        </div>
        <div style="font-size: 16px; font-weight: 600; margin: 4px 0;" id="latency-${key}">${latency}</div>
        <div style="font-size: 11px; color: var(--text-dark); margin-bottom: 8px;" id="uptime-${key}">${uptime}</div>
        <div class="text-danger" style="font-size: 10px; margin-bottom: 8px; word-break: break-all; min-height: 12px;" id="error-${key}">${errorDetail ? errorDetail.slice(0, 80) : ''}</div>
        ${restartBtn}
      </div>
    `;
  }

  function updateServiceCardUI(key, state, errorMsg = '') {
    const card = document.getElementById(`service-card-${key}`);
    const pill = document.getElementById(`status-pill-${key}`);
    const btn = document.getElementById(`restart-btn-${key}`);
    const errDiv = document.getElementById(`error-${key}`);

    if (state === 'restarting') {
      if (card) card.classList.add('loading');
      if (pill) {
        pill.textContent = '⟳ Restarting...';
        pill.className = 'monitor-status-pill status-warning';
      }
      if (btn) {
        btn.textContent = 'Restarting...';
        btn.disabled = true;
      }
      if (errDiv) errDiv.textContent = '';
    } else if (state === 'failed') {
      if (card) card.classList.remove('loading');
      if (pill) {
        pill.textContent = '✕ Failed to Restart';
        pill.className = 'monitor-status-pill status-critical';
      }
      if (btn) {
        btn.textContent = 'Restart';
        btn.disabled = false;
      }
      if (errDiv) errDiv.textContent = errorMsg.slice(0, 80);
    }
  }

  function updateServiceCardFromHealthData(key, health) {
    const svc = health[key];
    if (!svc) return;
    const pill = document.getElementById(`status-pill-${key}`);
    const latencyDiv = document.getElementById(`latency-${key}`);
    const uptimeDiv = document.getElementById(`uptime-${key}`);
    const errDiv = document.getElementById(`error-${key}`);

    if (!restartingServices.has(key)) {
      const isOk = svc.ok === true;
      if (pill) {
        pill.textContent = isOk ? '✓ Online' : '✕ Offline';
        pill.className = isOk ? 'monitor-status-pill status-ok' : 'monitor-status-pill status-critical';
      }
      if (errDiv) {
        errDiv.textContent = !isOk && svc.error ? svc.error.slice(0, 80) : '';
      }
    }
    if (latencyDiv) {
      latencyDiv.textContent = svc.latencyMs != null ? `${svc.latencyMs}ms` : '—';
    }
    if (uptimeDiv && svc.uptime) {
      uptimeDiv.textContent = `Uptime: ${svc.uptime}`;
    }
  }

  // Inject custom CSS styles for the restart/confirm modals
  (function injectModalStyles() {
    const styleId = 'restart-modal-styles';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .restart-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(10, 11, 15, 0.95);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999;
        backdrop-filter: blur(8px);
        animation: restart-fadeIn 0.3s ease forwards;
        user-select: none;
      }
      .restart-modal-content {
        background: #161920;
        border: 1px solid #2a2f3a;
        border-radius: 12px;
        padding: 40px;
        max-width: 480px;
        width: 90%;
        text-align: center;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
        transform: scale(0.9);
        animation: restart-scaleUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      }
      .restart-spinner {
        width: 50px;
        height: 50px;
        border: 3px solid rgba(0, 242, 254, 0.1);
        border-top-color: #00f2fe;
        border-radius: 50%;
        margin: 0 auto 24px auto;
        animation: restart-spin 1s linear infinite;
      }
      .restart-title {
        font-size: 20px;
        font-weight: 600;
        color: #ffffff;
        margin-bottom: 12px;
        font-family: var(--sans);
      }
      .restart-subtitle {
        font-size: 14px;
        color: #a0aec0;
        margin-bottom: 30px;
        line-height: 1.5;
        white-space: pre-line;
        font-family: var(--sans);
      }
      .restart-status-text {
        font-size: 13px;
        font-family: var(--mono);
        color: #00f2fe;
        letter-spacing: 0.5px;
        min-height: 20px;
      }
      .confirm-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(10, 11, 15, 0.75);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99998;
        backdrop-filter: blur(4px);
        animation: restart-fadeIn 0.2s ease forwards;
        user-select: none;
      }
      .confirm-modal-content {
        background: #161920;
        border: 1px solid #2a2f3a;
        border-radius: 12px;
        padding: 30px;
        max-width: 420px;
        width: 90%;
        box-shadow: 0 15px 30px rgba(0, 0, 0, 0.5);
        transform: scale(0.95);
        animation: restart-scaleUp 0.2s ease forwards;
      }
      .confirm-title {
        font-size: 18px;
        font-weight: 600;
        color: #ffffff;
        margin-bottom: 12px;
        font-family: var(--sans);
      }
      .confirm-body {
        font-size: 14px;
        color: #a0aec0;
        line-height: 1.5;
        margin-bottom: 24px;
        font-family: var(--sans);
      }
      .confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
      }
      .confirm-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        border: none;
        font-family: var(--sans);
      }
      .confirm-btn-primary {
        background: #ff4a4a;
        color: #ffffff;
      }
      .confirm-btn-primary:hover {
        background: #ff2a2a;
      }
      .confirm-btn-secondary {
        background: #2a2f3a;
        color: #a0aec0;
      }
      .confirm-btn-secondary:hover {
        background: #3a3f4a;
        color: #ffffff;
      }
      @keyframes restart-fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes restart-scaleUp {
        from { transform: scale(0.95); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
      }
      @keyframes restart-spin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  })();

  function showConfirmModal(title, message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal-content">
        <h3 class="confirm-title">${escapeHtml(title)}</h3>
        <p class="confirm-body">${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="confirm-btn confirm-btn-secondary" id="confirm-cancel-btn">Cancel</button>
          <button class="confirm-btn confirm-btn-primary" id="confirm-yes-btn">Restart</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#confirm-cancel-btn').addEventListener('click', close);
    overlay.querySelector('#confirm-yes-btn').addEventListener('click', () => {
      close();
      onConfirm();
    });
  }

  function showProgressModal(title, subtitle) {
    const overlay = document.createElement('div');
    overlay.className = 'restart-modal-overlay';
    overlay.innerHTML = `
      <div class="restart-modal-content">
        <div class="restart-spinner"></div>
        <h3 class="restart-title">${escapeHtml(title)}</h3>
        <p class="restart-subtitle">${escapeHtml(subtitle).replace(/\n/g, '<br>')}</p>
        <div class="restart-status-text" id="restart-status-text">Starting...</div>
      </div>
    `;

    document.body.appendChild(overlay);

    return {
      setStatusText: (text) => {
        const el = overlay.querySelector('#restart-status-text');
        if (el) el.textContent = text;
      },
      close: () => overlay.remove()
    };
  }

  window.restartService = async function(serviceName) {
    if (restartingServices.has(serviceName)) return;

    if (serviceName === 'nodeServer') {
      showConfirmModal(
        'Restart Main Server?',
        'This will temporarily interrupt all API requests and active operations.',
        async () => {
          const modal = showProgressModal(
            'Restarting Main Server...',
            'The main server is restarting.\nDuring this time APIs may become temporarily unavailable.'
          );

          const statuses = [
            'Stopping services...',
            'Restarting server...',
            'Waiting for server...',
            'Almost ready...'
          ];

          let currentStatusIdx = 0;
          const statusInterval = setInterval(() => {
            if (currentStatusIdx < statuses.length - 1) {
              currentStatusIdx++;
              modal.setStatusText(statuses[currentStatusIdx]);
            }
          }, 1000);

          modal.setStatusText(statuses[0]);

          // Fire-and-forget request
          api('POST', `/admin/services/${serviceName}/restart`).catch(() => {});

          setTimeout(() => {
            clearInterval(statusInterval);
            modal.setStatusText('Restart complete. Refreshing dashboard...');

            setTimeout(() => {
              window.location.reload(true);
            }, 500);
          }, 5000);
        }
      );
      return;
    }

    restartingServices.add(serviceName);
    updateServiceCardUI(serviceName, 'restarting');

    const pollInterval = setInterval(async () => {
      try {
        const res = await api('GET', '/admin/system/health');
        if (res?.ok && res.health) {
          updateServiceCardFromHealthData(serviceName, res.health);
        }
      } catch {}
    }, 1500);

    try {
      const res = await api('POST', `/admin/services/${serviceName}/restart`);
      clearInterval(pollInterval);
      restartingServices.delete(serviceName);

      if (res?.success) {
        showToast(`Service ${serviceName} restarted successfully in ${res.downtimeMs}ms`, 'success');
        loadInfraHealth();
      } else {
        showToast(`Failed to restart ${serviceName}: ${res?.error || 'Unknown error'}`, 'error');
        updateServiceCardUI(serviceName, 'failed', res?.error || 'Service failed to recover within timeout');
      }
    } catch (err) {
      clearInterval(pollInterval);
      restartingServices.delete(serviceName);
      showToast(`Error restarting service: ${err.message}`, 'error');
      updateServiceCardUI(serviceName, 'failed', err.message);
    }
  };

  async function loadInfraHealth() {
    const container = document.getElementById('health-grid-details');
    if (!container) return;
    container.innerHTML = '<div class="empty-state">Collecting infrastructure telemetry…</div>';

    try {
      const res = await api('GET', '/admin/system/health');
      if (!res?.ok || !res.health) {
        container.innerHTML = '<div class="empty-state">Health endpoint unavailable.</div>';
        return;
      }
      const h = res.health;

      const cpuVal   = typeof h.cpu === 'number' ? h.cpu : 0;
      const memVal   = h.mem?.percent ?? 0;
      const diskVal  = h.disk?.percent ?? 0;

      container.innerHTML = `
        <div class="monitor-card">
          <div class="monitor-header">
            <span class="monitor-name">CPU</span>
            <span class="monitor-status-pill ${cpuVal > 90 ? 'status-critical' : cpuVal > 70 ? 'status-warning' : 'status-ok'}">Active</span>
          </div>
          ${renderGaugeWidget('Core utilization', cpuVal, '%')}
          ${h.cpuSpeed ? `<div style="font-size:11px;color:var(--text-dark);margin-top:4px">Clock Speed: ${h.cpuSpeed} GHz</div>` : ''}
        </div>

        <div class="monitor-card">
          <div class="monitor-header">
            <span class="monitor-name">Network Speed</span>
            <span class="monitor-status-pill status-ok">Active</span>
          </div>
          <div style="padding: 12px 0;">
            <div style="display:flex; justify-content:space-between; margin-bottom:12px; align-items:center;">
              <span style="font-size:12px; color:var(--text-dark);">⬇ Download:</span>
              <span style="font-weight:600; font-family:var(--mono); color:var(--text-light); font-size:13px;">${formatNetworkSpeed(h.network?.rxSpeed)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:12px; color:var(--text-dark);">⬆ Upload:</span>
              <span style="font-weight:600; font-family:var(--mono); color:var(--text-light); font-size:13px;">${formatNetworkSpeed(h.network?.txSpeed)}</span>
            </div>
          </div>
        </div>

        <div class="monitor-card">
          <div class="monitor-header">
            <span class="monitor-name">Memory (RAM)</span>
            <span class="monitor-status-pill ${memVal > 90 ? 'status-critical' : memVal > 70 ? 'status-warning' : 'status-ok'}">Active</span>
          </div>
          ${renderGaugeWidget('Physical RAM allocation', memVal, '%')}
          <div style="font-size:11px;color:var(--text-dark);margin-top:4px">${h.mem?.used ? formatBytes(h.mem.used) + ' / ' + formatBytes(h.mem.total) : ''}</div>
        </div>

        <div class="monitor-card">
          <div class="monitor-header">
            <span class="monitor-name">Disk Storage</span>
            <span class="monitor-status-pill ${diskVal > 90 ? 'status-critical' : diskVal > 75 ? 'status-warning' : 'status-ok'}">Active</span>
          </div>
          ${renderGaugeWidget('Filesystem usage', diskVal, '%')}
          <div style="font-size:11px;color:var(--text-dark);margin-top:4px">${h.disk?.used ? formatBytes(h.disk.used) + ' / ' + formatBytes(h.disk.total) : ''}</div>
        </div>

        ${getServiceCardHtml('nodeServer', 'Main Server (Node.js)', h.nodeServer, true)}
        ${getServiceCardHtml('db', 'SQLite Database', h.db, false)}
        ${getServiceCardHtml('redis', 'Redis Cache', h.redis, true)}
        ${getServiceCardHtml('ollama', 'Ollama (Local LLM)', h.ollama, true)}
        ${getServiceCardHtml('litellm', 'LiteLLM Proxy', h.litellm, true)}
        ${getServiceCardHtml('n8n', 'n8n Webhooks', h.n8n, true)}
        ${getServiceCardHtml('google', 'Google OAuth', h.google, false)}
      `;
    } catch (err) {
      console.error('[InfraHealth]', err);
      if (container) container.innerHTML = '<div class="empty-state">Error loading infrastructure status.</div>';
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(1) + ' ' + units[i];
  }

  function formatNetworkSpeed(bytesPerSec) {
    if (bytesPerSec === undefined || bytesPerSec === null) return '—';
    if (bytesPerSec < 1024) return bytesPerSec + ' B/s';
    const kb = bytesPerSec / 1024;
    if (kb < 1024) return kb.toFixed(1) + ' KB/s';
    const mb = kb / 1024;
    return mb.toFixed(1) + ' MB/s';
  }

  async function loadInfraMetrics() {
    const container = document.getElementById('infra-metrics-chart');
    container.innerHTML = 'Loading history...';

    try {
      const res = await api('GET', '/admin/system/metrics?metricName=cpu_usage_percent');
      const metrics = res.metrics || [];
      if (metrics.length === 0) {
        container.innerHTML = '<div class="empty-state">No metrics recorded yet.</div>';
      } else {
        const maxVal = Math.max(...metrics.map(m => m.metric_value || 1));
        container.innerHTML = metrics.map(m => {
          const heightPct = ((m.metric_value || 0) / maxVal) * 100;
          return `
            <div class="chart-bar" style="height: ${heightPct}%;">
              <div class="chart-bar-tooltip">${formatDate(m.timestamp)}: ${m.metric_value.toFixed(1)}%</div>
            </div>
          `;
        }).join('');
      }
    } catch {}
  }

  async function loadInfraAlerts() {
    const tbody = document.querySelector('#infra-alerts-table tbody');
    tbody.innerHTML = '<tr><td colspan="6"><div class="skeleton skeleton-rect" style="height: 120px;"></div></td></tr>';

    try {
      const res = await api('GET', '/admin/system/alerts?resolved=0');
      const alerts = res.alerts || [];

      if (alerts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">No open infrastructure alerts.</div></td></tr>';
        return;
      }

      tbody.innerHTML = alerts.map(a => `
        <tr>
          <td><span class="badge badge-${a.severity === 'CRITICAL' ? 'high' : 'medium'}">${a.severity}</span></td>
          <td class="cell-bold">${a.title}</td>
          <td>${a.description}</td>
          <td><span class="badge badge-suspended">Open</span></td>
          <td>${formatDate(a.timestamp)}</td>
          <td>
            <button class="btn btn-xs btn-primary" onclick="resolveInfraAlert(${a.id})">Resolve</button>
          </td>
        </tr>
      `).join('');
    } catch {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">Error loading alerts database.</div></td></tr>';
    }
  }

  window.resolveInfraAlert = async function (id) {
    try {
      await api('POST', `/admin/system/alerts/${id}/resolve`);
      showToast('Infrastructure alert resolved.', 'success');
      loadInfraAlerts();
    } catch {}
  };

  /* ─── VIEW 12: AUDIT LOGS ─── */
  async function loadAuditTable() {
    const tbody = document.querySelector('#audit-table tbody');
    tbody.innerHTML = '<tr><td colspan="7"><div class="skeleton skeleton-rect" style="height: 120px;"></div></td></tr>';

    try {
      const q = states.audit;
      const res = await api('GET', `/admin/audit?limit=${q.limit}&offset=${q.offset}&action=${q.action}`);

      const logs = res.logs || [];
      if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No audit logs found.</div></td></tr>';
        return;
      }

      tbody.innerHTML = logs.map(l => `
        <tr onclick="openAuditDrawer(${l.id})" style="cursor:pointer;">
          <td class="cell-mono">${formatDate(l.timestamp)}</td>
          <td class="cell-bold">${l.actor_email || 'System'}</td>
          <td><span class="badge badge-user">${l.action}</span></td>
          <td>${l.target_type ? `${l.target_type} (${l.target_id})` : '—'}</td>
          <td class="cell-mono">${l.ip_address || '—'}</td>
          <td><span class="badge ${l.success ? 'badge-active' : 'badge-suspended'}">${l.success ? 'Success' : 'Fail'}</span></td>
          <td>
            <button class="btn btn-xs" onclick="event.stopPropagation(); openAuditDrawer(${l.id})">Inspect</button>
          </td>
        </tr>
      `).join('');

      document.getElementById('audit-pagination-info').textContent = `Showing ${q.offset + 1}-${q.offset + logs.length} logs`;
      document.getElementById('audit-prev-btn').disabled = q.offset === 0;
      document.getElementById('audit-next-btn').disabled = logs.length < q.limit;
    } catch {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Error loading audit trail database.</div></td></tr>';
    }
  }

  window.openAuditDrawer = async function (id) {
    const drawer = document.getElementById('audit-drawer');
    const backdrop = document.getElementById('audit-drawer-backdrop');
    drawer.classList.add('open');
    backdrop.classList.add('open');

    try {
      const res = await api('GET', `/admin/audit/${id}`);
      const log = res.log;

      document.getElementById('audit-detail-id').textContent = `#${log.id}`;
      document.getElementById('audit-detail-time').textContent = formatDate(log.timestamp);
      document.getElementById('audit-detail-actor').textContent = `${log.actor_email} (${log.actor_role})`;
      document.getElementById('audit-detail-action').textContent = log.action;
      document.getElementById('audit-detail-ip').textContent = log.ip_address || '—';
      document.getElementById('audit-detail-severity').textContent = log.severity || 'INFO';
      document.getElementById('audit-detail-old').textContent = log.old_value || '—';
      document.getElementById('audit-detail-new').textContent = log.new_value || '—';

      document.getElementById('audit-detail-metadata').textContent = log.metadata_json
        ? JSON.stringify(JSON.parse(log.metadata_json), null, 2)
        : '{}';
    } catch {
      showToast('Failed to load audit record details.', 'error');
    }
  };

  window.closeAuditDrawer = function () {
    document.getElementById('audit-drawer').classList.remove('open');
    document.getElementById('audit-drawer-backdrop').classList.remove('open');
    closeUserDrawer();
  };

  /* ─── VIEW 13: SETTINGS ─── */
  async function loadAdminSettings() {
    try {
      const res = await api('GET', '/admin/system/health');
      const h = res.health;

      document.getElementById('settings-uptime-val').textContent = h.uptime ? formatUptime(h.uptime) : '—';
      document.getElementById('settings-docker-status').textContent = h.docker || 'offline';
    } catch {}
  }

  function formatUptime(sec) {
    const d = Math.floor(sec / (3600 * 24));
    const h = Math.floor((sec % (3600 * 24)) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  }

  /* ─── CONTROLLER: UNIVERSAL SEARCH PALETTE (Ctrl+K) ─── */
  window.openSearchPalette = function () {
    const backdrop = document.getElementById('search-palette-backdrop');
    backdrop.classList.add('open');
    const input = document.getElementById('search-palette-input');
    input.value = '';
    input.focus();
    document.getElementById('search-palette-results').innerHTML = '<div class="empty-state">Type query to search platform records...</div>';
  };

  window.closeSearchPalette = function () {
    document.getElementById('search-palette-backdrop').classList.remove('open');
  };

  let searchTimeout = null;
  window.triggerGlobalSearch = function () {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      const q = document.getElementById('search-palette-input').value.trim();
      const results = document.getElementById('search-palette-results');
      if (q.length < 2) {
        results.innerHTML = '<div class="empty-state">Type query to search platform records...</div>';
        return;
      }

      results.innerHTML = '<div class="empty-state">Searching...</div>';
      try {
        const res = await api('GET', `/admin/search?q=${encodeURIComponent(q)}`);

        let html = '';

        // Group 1: Users
        if (res.users?.length > 0) {
          html += '<div class="search-section-title">Users</div>';
          html += res.users.map(u => `
            <a class="search-row" onclick="closeSearchPalette(); openUserDrawer(${u.id})">
              <div class="search-row-icon">👤</div>
              <div class="search-row-text">
                <div class="search-row-title">${u.name || 'User'}</div>
                <div class="search-row-sub">${u.email}</div>
              </div>
            </a>
          `).join('');
        }

        // Group 2: Programs
        if (res.programs?.length > 0) {
          html += '<div class="search-section-title">Programs</div>';
          html += res.programs.map(p => `
            <a class="search-row" onclick="closeSearchPalette(); openProgramDrawer(${p.id})">
              <div class="search-row-icon">⚡</div>
              <div class="search-row-text">
                <div class="search-row-title">${p.name}</div>
                <div class="search-row-sub">${p.language || 'py'} · Status: ${p.status}</div>
              </div>
            </a>
          `).join('');
        }

        // Group 3: Conversations
        if (res.conversations?.length > 0) {
          html += '<div class="search-section-title">Conversations</div>';
          html += res.conversations.map(c => `
            <a class="search-row" onclick="closeSearchPalette(); openConvDrawer(${c.id})">
              <div class="search-row-icon">💬</div>
              <div class="search-row-text">
                <div class="search-row-title">${c.title || 'Untitled Session'}</div>
                <div class="search-row-sub">Session: ${c.session_id}</div>
              </div>
            </a>
          `).join('');
        }

        // Group 4: Incidents
        if (res.incidents?.length > 0) {
          html += '<div class="search-section-title">Security Incidents</div>';
          html += res.incidents.map(i => `
            <a class="search-row" onclick="closeSearchPalette(); openIncidentDrawer(${i.id})">
              <div class="search-row-icon">⚠️</div>
              <div class="search-row-text">
                <div class="search-row-title">${i.title}</div>
                <div class="search-row-sub">${i.severity} · Status: ${i.status}</div>
              </div>
            </a>
          `).join('');
        }

        if (html === '') {
          results.innerHTML = '<div class="empty-state">No matching records found.</div>';
        } else {
          results.innerHTML = html;
        }
      } catch {
        results.innerHTML = '<div class="empty-state">Search operation failed.</div>';
      }
    }, 300);
  };

  /* Keyboard binding: Ctrl+K for search palette */
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openSearchPalette();
    }
    if (e.key === 'Escape') {
      closeSearchPalette();
    }
  });

  /* ─── EVENT HANDLERS & LISTENERS ─── */
  function initEvents() {
    // Sidebar Navigation Click Handlers
    document.querySelectorAll('.sidebar .nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = item.getAttribute('data-view');
        window.location.hash = view;
      });
    });

    // Logout Button Click
    document.getElementById('sidebarLogout').addEventListener('click', () => {
      clearAuth();
      window.location.href = './login.html';
    });

    // Paging: Users
    document.getElementById('users-prev-btn').addEventListener('click', () => {
      if (states.users.offset >= states.users.limit) {
        states.users.offset -= states.users.limit;
        loadUsersTable();
      }
    });
    document.getElementById('users-next-btn').addEventListener('click', () => {
      states.users.offset += states.users.limit;
      loadUsersTable();
    });

    // Filters: Users
    const uSearch = document.getElementById('user-search-query');
    uSearch.addEventListener('input', () => {
      states.users.search = uSearch.value;
      states.users.offset = 0;
      loadUsersTable();
    });

    const uRole = document.getElementById('user-filter-role');
    uRole.addEventListener('change', () => {
      states.users.role = uRole.value;
      states.users.offset = 0;
      loadUsersTable();
    });

    const uStatus = document.getElementById('user-filter-status');
    uStatus.addEventListener('change', () => {
      states.users.status = uStatus.value;
      states.users.offset = 0;
      loadUsersTable();
    });

    // Paging: Programs
    document.getElementById('programs-prev-btn').addEventListener('click', () => {
      if (states.programs.offset >= states.programs.limit) {
        states.programs.offset -= states.programs.limit;
        loadProgramsTable();
      }
    });
    document.getElementById('programs-next-btn').addEventListener('click', () => {
      states.programs.offset += states.programs.limit;
      loadProgramsTable();
    });

    const pSearch = document.getElementById('programs-search-query');
    pSearch.addEventListener('input', () => {
      states.programs.search = pSearch.value;
      states.programs.offset = 0;
      loadProgramsTable();
    });

    // Paging: Conversations
    document.getElementById('conversations-prev-btn').addEventListener('click', () => {
      if (states.conversations.offset >= states.conversations.limit) {
        states.conversations.offset -= states.conversations.limit;
        loadConversationsTable();
      }
    });
    document.getElementById('conversations-next-btn').addEventListener('click', () => {
      states.conversations.offset += states.conversations.limit;
      loadConversationsTable();
    });

    const cSearch = document.getElementById('conversations-search-query');
    cSearch.addEventListener('input', () => {
      states.conversations.search = cSearch.value;
      states.conversations.offset = 0;
      loadConversationsTable();
    });

    // Paging: Audit Logs
    document.getElementById('audit-prev-btn').addEventListener('click', () => {
      if (states.audit.offset >= states.audit.limit) {
        states.audit.offset -= states.audit.limit;
        loadAuditTable();
      }
    });
    document.getElementById('audit-next-btn').addEventListener('click', () => {
      states.audit.offset += states.audit.limit;
      loadAuditTable();
    });

    const aSearch = document.getElementById('audit-search-query');
    aSearch.addEventListener('input', () => {
      states.audit.search = aSearch.value;
      states.audit.offset = 0;
      loadAuditTable();
    });
  }

  /* ─── UTILITY HELPERS ─── */
  function formatDate(isoString) {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return isoString;
    }
  }

  function timeAgo(dateString) {
    if (!dateString) return '—';
    try {
      const date = new Date(dateString);
      const seconds = Math.floor((new Date() - date) / 1000);
      let interval = Math.floor(seconds / 31536000);
      if (interval >= 1) return interval + " year" + (interval > 1 ? "s" : "") + " ago";
      interval = Math.floor(seconds / 2592000);
      if (interval >= 1) return interval + " month" + (interval > 1 ? "s" : "") + " ago";
      interval = Math.floor(seconds / 86400);
      if (interval >= 1) return interval + " day" + (interval > 1 ? "s" : "") + " ago";
      interval = Math.floor(seconds / 3600);
      if (interval >= 1) return interval + " hour" + (interval > 1 ? "s" : "") + " ago";
      interval = Math.floor(seconds / 60);
      if (interval >= 1) return interval + " minute" + (interval > 1 ? "s" : "") + " ago";
      if (seconds < 10) return "just now";
      return Math.floor(seconds) + " seconds ago";
    } catch {
      return dateString;
    }
  }

  function showToast(text, type = 'info') {
    const container = document.getElementById('admin-toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = text;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    }, 3500);
  }

  /* ─── USER PROFILE → CONVERSATIONS TAB ─── */
  async function loadUserConversations() {
    const list = document.getElementById('user-conversations-list');
    list.innerHTML = '<div class="empty-state">Loading conversations...</div>';

    const searchVal = document.getElementById('user-conversations-search').value.trim();
    try {
      const url = `/admin/conversations?userId=${selectedUserId}&search=${encodeURIComponent(searchVal)}&limit=100`;
      const res = await api('GET', url);
      const convs = res.conversations || [];

      if (convs.length === 0) {
        list.innerHTML = '<div class="empty-state">No conversations found.</div>';
        return;
      }

      list.innerHTML = convs.map(c => `
        <div class="user-conv-card" onclick="openConvDrawer(${c.id})">
          <div class="user-conv-header">
            <span class="user-conv-title">${escapeHtml(c.title || 'Untitled Session')}</span>
            <span class="badge badge-${c.status === 'active' ? 'active' : 'suspended'}">${escapeHtml(c.status || 'active')}</span>
          </div>
          <div class="user-conv-meta">
            <span>${c.messages_count ?? 0} messages</span>
            <span>Last active: ${timeAgo(c.last_activity || c.last_message_at || c.updated_at || c.created_at)}</span>
          </div>
          <div class="user-conv-date">
            Created: ${formatDate(c.created_at)}
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error(err);
      list.innerHTML = '<div class="empty-state">Error loading conversations.</div>';
    }
  }
  window.loadUserConversations = loadUserConversations;

  /* ─── USER PROFILE → PROGRAMS TAB ─── */
  async function loadUserPrograms() {
    const list = document.getElementById('user-programs-list');
    list.innerHTML = '<div class="empty-state">Loading programs...</div>';

    const searchVal = document.getElementById('user-programs-search').value.trim();
    try {
      const url = `/admin/users/${selectedUserId}/programs?search=${encodeURIComponent(searchVal)}&limit=100`;
      const res = await api('GET', url);
      const progs = res.programs || [];

      if (progs.length === 0) {
        list.innerHTML = '<div class="empty-state">No programs created by this user.</div>';
        return;
      }

      list.innerHTML = progs.map(p => `
        <div class="user-prog-card" onclick="openProgramDrawer(${p.id})">
          <div class="user-prog-header">
            <span class="user-prog-title">${escapeHtml(p.name || 'Untitled Program')}</span>
            <span class="badge badge-${p.status === 'active' ? 'active' : 'suspended'}">${escapeHtml(p.status || 'active')}</span>
          </div>
          <div class="user-prog-meta">
            <span>Language: ${escapeHtml(p.language || 'Plaintext')}</span>
            <span>Created: ${formatDate(p.created_at)}</span>
            ${p.updated_at ? `<span>Modified: ${formatDate(p.updated_at)}</span>` : ''}
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error(err);
      list.innerHTML = '<div class="empty-state">Error loading programs.</div>';
    }
  }
  window.loadUserPrograms = loadUserPrograms;

  /* ─── PROGRAM CODE VIEWER & Monaco Editor Setup ─── */
  let adminMonacoEditor = null;
  let adminEditorModel = null;
  let adminMonacoReady = null;
  let adminEditorReadOnly = true;
  let currentProgramOwnerId = null;
  let currentProgramName = null;
  let currentProgramFiles = [];
  let collapsedFolders = { '/root': false };
  let currentSelectedFilePath = null;

  function getEditorLanguage(fn) {
    return { py:'python',js:'javascript',ts:'typescript',java:'java',go:'go',rs:'rust',cpp:'cpp',c:'c',rb:'ruby',php:'php',json:'json',html:'html',css:'css',md:'markdown',txt:'plaintext' }[(fn||'').split('.').pop().toLowerCase()] || 'plaintext';
  }

  async function ensureAdminMonacoEditor() {
    if (adminMonacoEditor) return adminMonacoEditor;
    if (!adminMonacoReady) {
      adminMonacoReady = new Promise((resolve, reject) => {
        if (!window.require) { reject(new Error('Monaco loader unavailable')); return; }
        window.require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs' } });
        window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
      });
    }
    const monaco = await adminMonacoReady;

    try {
      monaco.editor.defineTheme('ipem-dark', { base:'vs-dark', inherit:true, rules:[],
        colors: { 'editor.background':'#0a0a0f','editorLineNumber.foreground':'#5a5a72','editorLineNumber.activeForeground':'#a394ff','editorCursor.foreground':'#3dd68c','editor.selectionBackground':'#3b2f7c','editor.inactiveSelectionBackground':'#2a234f','editorIndentGuide.background1':'#1f1f30','editorIndentGuide.activeBackground1':'#3b3b57' }
      });
    } catch (_) {}

    adminEditorModel = monaco.editor.createModel('', 'plaintext');
    adminMonacoEditor = monaco.editor.create(document.getElementById('program-code-editor-pane'), {
      model: adminEditorModel, theme: 'ipem-dark', automaticLayout: true, minimap: { enabled: false },
      fontFamily: 'JetBrains Mono, monospace', fontSize: 13, lineHeight: 22, scrollBeyondLastLine: false,
      roundedSelection: true, padding: { top: 16, bottom: 16 }, tabSize: 2, insertSpaces: true,
      readOnly: true
    });
    return adminMonacoEditor;
  }

  function buildTree(files) {
    const root = { name: '', type: 'folder', children: {}, path: '' };

    files.forEach(filePath => {
      const isDir = filePath.endsWith('/');
      const cleanPath = isDir ? filePath.slice(0, -1) : filePath;
      const parts = cleanPath.split('/');

      let current = root;
      let currentPath = '';

      parts.forEach((part, index) => {
        if (!part) return;
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const isLast = index === parts.length - 1;

        if (!current.children[part]) {
          current.children[part] = {
            name: part,
            type: (isLast && !isDir) ? 'file' : 'folder',
            children: {},
            path: isDir && isLast ? currentPath + '/' : currentPath
          };
        }
        current = current.children[part];
      });
    });

    return root;
  }

  function renderTreeNode(node, depth = 0, isRoot = false) {
    if (isRoot) {
      const childrenKeys = Object.keys(node.children).sort((a, b) => {
        const aNode = node.children[a];
        const bNode = node.children[b];
        if (aNode.type !== bNode.type) {
          return aNode.type === 'folder' ? -1 : 1;
        }
        return a.localeCompare(b);
      });

      return childrenKeys.map(key => renderTreeNode(node.children[key], depth)).join('');
    }

    const isFolder = node.type === 'folder';
    const indentClass = depth > 0 ? `style="padding-left: ${depth * 12}px;"` : '';
    const nodePathEscaped = node.path.replace(/'/g, "\\'");

    const canDelete = ['owner', 'admin'].includes(currentUser.role);

    const deleteBtnHtml = canDelete ? `
      <div class="tree-actions" style="margin-left: auto;">
        <button class="tree-btn" onclick="event.stopPropagation(); deleteTreeNodeAction('${nodePathEscaped}', '${node.type}')" title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </div>
    ` : '';

    if (isFolder) {
      const isCollapsed = collapsedFolders[node.path] !== false;
      const chevronClass = isCollapsed ? '' : 'open';
      const subfolderDisplay = isCollapsed ? 'style="display: none;"' : '';

      const childrenHtml = Object.keys(node.children).length > 0
        ? `<div id="subfolder-${node.path}" ${subfolderDisplay}>
            ${Object.keys(node.children).sort((a, b) => {
              const aNode = node.children[a];
              const bNode = node.children[b];
              if (aNode.type !== bNode.type) {
                return aNode.type === 'folder' ? -1 : 1;
              }
              return a.localeCompare(b);
            }).map(key => renderTreeNode(node.children[key], depth + 1)).join('')}
          </div>`
        : `<div id="subfolder-${node.path}" ${subfolderDisplay} class="programs-empty" style="padding-left: ${(depth + 1) * 12}px; font-size: 11px;">Empty folder</div>`;

      return `
        <div class="tree-folder-wrapper">
          <div class="tree-item tree-folder" ${indentClass} onclick="toggleTreeFolder('${nodePathEscaped}')" title="${escapeHtml(node.name)}">
            <svg class="tree-chevron ${chevronClass}" id="chev-tree-${node.path}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
            <span class="tree-icon">📁</span>
            <span class="tree-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
            ${deleteBtnHtml}
          </div>
          ${childrenHtml}
        </div>
      `;
    } else {
      const isActive = node.path === currentSelectedFilePath;
      const activeClass = isActive ? 'active' : '';
      const ext = node.name.split('.').pop().toLowerCase();
      const icon = { py:'🐍',js:'🟡',ts:'🔷',go:'🐹',rs:'🦀',java:'☕',cpp:'⚡',c:'⚡',rb:'💎',php:'🐘',json:'📋',txt:'📄' }[ext] || '📄';

      return `
        <div class="tree-item tree-file ${activeClass}" ${indentClass} onclick="selectTreeFile('${nodePathEscaped}')" title="${escapeHtml(node.name)}">
          <span class="tree-icon">${icon}</span>
          <span class="tree-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
          ${deleteBtnHtml}
        </div>
      `;
    }
  }

  function renderDirectoryTree() {
    const container = document.getElementById('program-ide-explorer');
    if (!container) return;

    if (!currentProgramFiles.length) {
      container.innerHTML = '<div class="programs-empty" style="padding: 16px; font-size:12px;">No files in program.</div>';
      return;
    }

    const tree = buildTree(currentProgramFiles);
    const rootNode = renderTreeNode(tree, 0, true);

    const isRootCollapsed = collapsedFolders['/root'] === true;
    const rootChevronClass = isRootCollapsed ? '' : 'open';
    const rootContentDisplay = isRootCollapsed ? 'style="display: none;"' : '';

    const canDelete = ['owner', 'admin'].includes(currentUser.role);
    const rootDeleteBtnHtml = canDelete ? `
      <div class="tree-actions" style="margin-left: auto;">
        <button class="tree-btn" onclick="event.stopPropagation(); deleteTreeNodeAction('/root', 'program')" title="Delete Program Folder">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </div>
    ` : '';

    container.innerHTML = `
      <div class="tree-folder-wrapper">
        <div class="tree-item tree-folder" style="font-weight: 600; color: var(--text);" onclick="toggleTreeFolder('/root')" title="${escapeHtml(currentProgramName)}/">
          <svg class="tree-chevron ${rootChevronClass}" id="chev-tree-/root" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
          <span class="tree-icon">📂</span>
          <span class="tree-name" title="${escapeHtml(currentProgramName)}/">${escapeHtml(currentProgramName)}/</span>
          ${rootDeleteBtnHtml}
        </div>
        <div id="subfolder-/root" ${rootContentDisplay}>
          ${rootNode}
        </div>
      </div>
    `;
  }

  function toggleTreeFolder(path) {
    const el = document.getElementById(`subfolder-${path}`);
    const chev = document.getElementById(`chev-tree-${path}`);
    if (!el) return;
    const isHidden = el.style.display === 'none';
    el.style.display = isHidden ? 'block' : 'none';
    if (chev) {
      if (isHidden) chev.classList.add('open');
      else chev.classList.remove('open');
    }
    collapsedFolders[path] = !isHidden;
  }
  window.toggleTreeFolder = toggleTreeFolder;

  async function selectTreeFile(path) {
    currentSelectedFilePath = path;

    // Update active class in explorer
    document.querySelectorAll('.tree-file').forEach(el => el.classList.remove('active'));
    renderDirectoryTree();

    // Display file name
    document.getElementById('program-code-filename-display').textContent = path;

    await loadProgramFileContent();
  }
  window.selectTreeFile = selectTreeFile;

  async function deleteTreeNodeAction(filePath, type) {
    let msg = '';
    if (type === 'program') {
      let filesCount = 0;
      let foldersCount = 0;
      currentProgramFiles.forEach(f => {
        if (f.endsWith('/')) foldersCount++;
        else filesCount++;
      });
      msg = `Delete folder "${currentProgramName}/"?\n\nThis will permanently delete:\n* ${filesCount} files\n* ${foldersCount} folders\n\nAre you sure you want to delete this program?`;
    } else if (type === 'folder') {
      let filesCount = 0;
      let foldersCount = 0;
      const prefix = filePath.endsWith('/') ? filePath : filePath + '/';
      currentProgramFiles.forEach(f => {
        if (f.startsWith(prefix) && f !== prefix) {
          if (f.endsWith('/')) foldersCount++;
          else filesCount++;
        }
      });
      msg = `Delete folder "${filePath}"?\n\nThis will permanently delete:\n* ${filesCount} files\n* ${foldersCount} folders`;
    } else {
      msg = `Delete file "${filePath}"?`;
    }

    if (!await window.ipemDialog.confirm(msg, { title: 'Confirm deletion', confirmText: 'Delete', danger: true })) return;

    try {
      if (type === 'program') {
        const url = `/api/program/${encodeURIComponent(currentProgramName)}?userId=${currentProgramOwnerId}`;
        const res = await api('DELETE', url);
        if (res && (res.status === 'deleted' || res.ok)) {
          showToast('Program deleted successfully.', 'success');
          closeProgramDrawer();
          if (window.loadUserPrograms) window.loadUserPrograms();
          if (window.loadProgramsTable) window.loadProgramsTable();
        } else {
          showToast(res?.message || 'Failed to delete program.', 'error');
        }
        return;
      }

      const isFolder = type === 'folder';
      const url = `/api/program/${encodeURIComponent(currentProgramName)}/file/${encodeURIComponent(filePath)}?userId=${currentProgramOwnerId}`;
      const res = await api('DELETE', url);
      if (res && res.status === 'deleted') {
        showToast(`${isFolder ? 'Folder' : 'File'} deleted successfully.`, 'success');

        if (currentSelectedFilePath === filePath || (isFolder && currentSelectedFilePath.startsWith(filePath))) {
          currentSelectedFilePath = null;
          document.getElementById('program-code-filename-display').textContent = 'No file selected';
          if (adminEditorModel) adminEditorModel.setValue('');
        }

        await loadProgramCodeTab();

        if (!currentProgramFiles.length) {
          showToast('No files remaining.', 'info');
        }
      } else {
        showToast(res?.message || 'Failed to delete.', 'error');
      }
    } catch (err) {
      showToast('Error deleting: ' + err.message, 'error');
    }
  }
  window.deleteTreeNodeAction = deleteTreeNodeAction;

  async function loadProgramCodeTab() {
    try {
      const res = await api('GET', `/admin/programs/${selectedProgramId}`);
      const p = res.program;
      currentProgramName = p.name;
      currentProgramOwnerId = p.owner_user_id;
      currentProgramFiles = (p.files || []).filter(f => !isHiddenFile(f));

      // Reset selected file if not set or no longer valid
      const onlyFiles = currentProgramFiles.filter(f => !f.endsWith('/'));
      if (onlyFiles.length > 0) {
        if (!currentSelectedFilePath || !onlyFiles.includes(currentSelectedFilePath)) {
          currentSelectedFilePath = onlyFiles.find(f => f === 'index.js' || f === 'main.js' || f === 'app.js') || onlyFiles[0];
        }
      } else {
        currentSelectedFilePath = null;
      }

      document.getElementById('program-code-filename-display').textContent = currentSelectedFilePath || 'No file selected';

      // Build collapsible tree
      renderDirectoryTree();

      // Authorization check for editing
      const editToggleBtn = document.getElementById('program-code-edit-toggle-btn');
      const saveBtn = document.getElementById('program-code-save-btn');
      if (['owner', 'admin'].includes(currentUser.role)) {
        editToggleBtn.style.display = 'inline-block';
      } else {
        editToggleBtn.style.display = 'none';
      }

      // Reset to read-only initially on load
      adminEditorReadOnly = true;
      editToggleBtn.textContent = 'Enable Editing';
      saveBtn.style.display = 'none';

      if (currentSelectedFilePath) {
        await loadProgramFileContent();
      } else {
        await ensureAdminMonacoEditor();
        adminEditorModel.setValue('// No files remaining.');
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to load program files.', 'error');
    }
  }
  window.loadProgramCodeTab = loadProgramCodeTab;

  async function loadProgramFileContent() {
    const filename = currentSelectedFilePath;
    if (!filename) return;

    await ensureAdminMonacoEditor();
    adminMonacoEditor.updateOptions({ readOnly: adminEditorReadOnly });

    try {
      const url = `/read/${encodeURIComponent(currentProgramName)}/${encodeURIComponent(filename)}?userId=${currentProgramOwnerId}`;
      const data = await api('GET', url);
      if (data && data.code !== undefined) {
        adminEditorModel.setValue(data.code);
        if (window.monaco) {
          window.monaco.editor.setModelLanguage(adminEditorModel, getEditorLanguage(filename));
        }
      } else {
        adminEditorModel.setValue('// Error loading file contents.');
      }
    } catch (err) {
      console.error(err);
      adminEditorModel.setValue('// Failed to load file: ' + err.message);
    }
  }
  window.loadProgramFileContent = loadProgramFileContent;

  function toggleProgramCodeEditing() {
    const editToggleBtn = document.getElementById('program-code-edit-toggle-btn');
    const saveBtn = document.getElementById('program-code-save-btn');

    adminEditorReadOnly = !adminEditorReadOnly;
    if (adminMonacoEditor) {
      adminMonacoEditor.updateOptions({ readOnly: adminEditorReadOnly });
    }

    if (adminEditorReadOnly) {
      editToggleBtn.textContent = 'Enable Editing';
      saveBtn.style.display = 'none';
    } else {
      editToggleBtn.textContent = 'Disable Editing';
      saveBtn.style.display = 'inline-block';
    }
  }
  window.toggleProgramCodeEditing = toggleProgramCodeEditing;

  async function saveProgramCodeChanges() {
    const filename = currentSelectedFilePath;
    if (!filename) return;

    const content = adminEditorModel ? adminEditorModel.getValue() : '';
    const saveBtn = document.getElementById('program-code-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const url = `/api/program/${encodeURIComponent(currentProgramName)}/file/${encodeURIComponent(filename)}?userId=${currentProgramOwnerId}`;
      const response = await api('PUT', url, { content });
      if (response && response.success) {
        showToast('File saved successfully.', 'success');
        toggleProgramCodeEditing();
      } else {
        showToast(response?.message || 'Failed to save file.', 'error');
      }
    } catch (err) {
      showToast('Failed to save file: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  }
  window.saveProgramCodeChanges = saveProgramCodeChanges;

  // Verify auth on startup
  verifyAuth();
})();
