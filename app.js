// --- CONSTANTS ---
const API_URL = "https://script.google.com/macros/s/AKfycbwm2pHn9-iSFOVmBDu1skr1sjexKV385mo5BkzwWdKxEi6k9RQJeRojuIimqUiLWVaVdg/exec";
const SESSION_DURATION = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_ID = "default-session";

// --- Firebase Helpers ---
let firebaseDatabase = null;
let systemSettingsRef = null;
let questionsRef = null;
let questionsListenerUnsubscribe = null;

// --- Timer Helpers ---
let timerInterval = null;
let sessionTimerRef = null;

// Wait for Firebase to be initialized
function waitForFirebase() {
    return new Promise((resolve, reject) => {
        const checkFirebase = () => {
            if (window.firebaseDatabase && window.firebaseRef && window.firebaseOnValue && window.firebaseSet && window.firebasePush) {
                firebaseDatabase = window.firebaseDatabase;
                systemSettingsRef = window.firebaseRef(firebaseDatabase, 'systemSettings');
                resolve();
            } else {
                setTimeout(checkFirebase, 100);
            }
        };
        checkFirebase();
    });
}

async function startSessionTimer(sessionId) {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    if (!sessionId) return;

    await waitForFirebase();
    const sessionRef = window.firebaseRef(firebaseDatabase, `sessions/${sessionId}`);

    // Check if createdAt exists, if not set it
    window.firebaseOnValue(sessionRef, async (snapshot) => {
        const sessionData = snapshot.val();
        let createdAt;
        if (!sessionData || !sessionData.createdAt) {
            createdAt = Date.now();
            await window.firebaseSet(sessionRef, { ...sessionData, createdAt: createdAt });
        } else {
            createdAt = sessionData.createdAt;
        }

        const totalDuration = 12 * 60 * 60 * 1000; // 12 hours in ms
        const timerElement = document.getElementById('session-timer');
        if (timerElement) {
            timerElement.style.display = 'inline-block';
        }

        // Timer function
        const updateTimer = async () => {
            const expiryTime = createdAt + totalDuration;
            let sisaWaktu = expiryTime - Date.now();

            if (sisaWaktu <= 0) {
                // Clear all questions in this session
                const questionsRef = window.firebaseRef(firebaseDatabase, `sessions/${sessionId}/questions`);
                await window.firebaseSet(questionsRef, null);

                // Reset createdAt to now to start new 12-hour cycle
                const newCreatedAt = Date.now();
                await window.firebaseSet(sessionRef, { ...sessionData, createdAt: newCreatedAt });

                return;
            }

            // Convert to HH:MM:SS
            const totalSeconds = Math.floor(sisaWaktu / 1000);
            const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
            const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
            const seconds = (totalSeconds % 60).toString().padStart(2, '0');

            if (timerElement) {
                timerElement.textContent = `${hours}:${minutes}:${seconds}`;
            }
        };

        // Run immediately and then every second
        updateTimer();
        timerInterval = setInterval(updateTimer, 1000);
    }, { onlyOnce: true });
}

// --- STATE ---
let sessions = {};
let users = [];
let systemSettings = JSON.parse(localStorage.getItem("qa_system_settings")) || {
  appName: "TanyaAja",
  primaryColor: "#ea580c",
  logoUrl: "assets/img/logo.png",
  landingTitle: "Gabung ke Sesi Q&A",
  landingSubtitle: "Masukkan kode sesi unik untuk mulai berdiskusi dan memberikan suara.",
  landingBgUrl: "assets/img/login-bg.jpg",
  loginBgUrl: "assets/img/login-bg.jpg",
  // Landing Right Settings
  landingRightTitle: "Make your event Interactive.",
  landingRightSubtitle: "Platform Q&A real-time untuk seminar, workshop, dan konferensi profesional.",
  landingRightBadge: "Trusted by 500+ Events",
  // Login Right Settings
  loginRightTitle: "Q&A EVENT - HARPER HOTEL PALEMBANG",
  loginRightSubtitle: "Kelola event Anda dengan mudah. Buat sesi baru, bagikan kode, dan pantau jalannya diskusi secara real-time.",
  appFont: "Plus Jakarta Sans"
};
let currentUser = JSON.parse(localStorage.getItem("currentUser")) || null;
let currentSessionId = getSessionFromUrl() || "";
let isAdmin = currentUser && (currentUser.role === "admin" || currentUser.role === "user");
let activeReactionQuestionId = null;
let lastQuestionsJson = ""; // Untuk mendeteksi perubahan data
let lastQuestionCountPerSession = {}; // Track last question count per session
let notificationTimeout = null; // Timeout for reminder notifications
let notificationRepeatCount = 0; // Count of reminder notifications

// Create a notification sound
const notificationSound = new Audio('https://drive.google.com/uc?export=download&id=1FYJtZOmN3XXtKRUjnworwq1p58pcT7cb');
function playNotificationSound() {
  notificationSound.currentTime = 0;
  notificationSound.play();
}

// --- APP INITIALIZATION ---
document.addEventListener("DOMContentLoaded", () => {
  applySystemSettings();
  initApp();
});

async function loadSystemSettings() {
  await waitForFirebase();
  
  // Listen for real-time changes from Firebase
  window.firebaseOnValue(systemSettingsRef, (snapshot) => {
    const data = snapshot.val();
    if (data) {
      systemSettings = { ...systemSettings, ...data };
      localStorage.setItem("qa_system_settings", JSON.stringify(systemSettings));
      applySystemSettings();
    }
  }, (error) => {
    console.error("Error listening to Firebase changes:", error);
    // Fallback to Google Apps Script if Firebase fails
    loadFromGoogleAppsScript();
  });
  
  // Also try to load from Google Apps Script for initial data
  loadFromGoogleAppsScript();
}

async function loadFromGoogleAppsScript() {
  try {
    const response = await fetch(`${API_URL}?action=get_system_settings`);
    const settings = await response.json();
    if (settings && !settings.status) {
      systemSettings = { ...systemSettings, ...settings };
      localStorage.setItem("qa_system_settings", JSON.stringify(systemSettings));
      applySystemSettings();
      // Also update Firebase with this data if needed
      if (systemSettingsRef) {
        window.firebaseSet(systemSettingsRef, systemSettings);
      }
    }
  } catch (e) {
    console.error("Error loading system settings from Google Apps Script:", e);
  }
}

async function initApp() {
  await loadSystemSettings();
  await loadUsers();
  await loadSessions();
  applySystemSettings();
  updateAdminUI();
  if (window.location.hash) {
    currentSessionId = getSessionFromUrl(); // Already uppercase
    if (isAdmin) {
      showAdminQADashboard(currentSessionId);
    } else {
      showParticipantView(currentSessionId);
    }
  } else {
    if (isAdmin) {
      showMasterDashboard();
    } else {
      showLandingPage();
    }
  }
  lucide.createIcons();
}

async function loadUsers() {
  try {
    const response = await fetch(`${API_URL}?action=get_users`);
    users = await response.json();
  } catch (e) {
    console.error("Error loading users:", e);
  }
}

async function loadSessions() {
  try {
    await waitForFirebase();
    const sessionsRef = window.firebaseRef(firebaseDatabase, 'sessions');
    window.firebaseOnValue(sessionsRef, (snapshot) => {
      const data = snapshot.val();
      sessions = {};
      if (data) {
        Object.keys(data).forEach(key => {
          sessions[key] = data[key];
        });
      }
      renderAdminSessions();
    });
  } catch (e) {
    console.error("Error loading sessions:", e);
  }
}

function applySystemSettings() {
  // Apply colors
  document.documentElement.style.setProperty("--main-primary", systemSettings.primaryColor);
  
  // Apply Font
  document.body.style.fontFamily = `'${systemSettings.appFont}', sans-serif`;
  
  // Apply texts
  const appNames = document.querySelectorAll(".app-name-text");
  appNames.forEach(el => el.textContent = systemSettings.appName || "TanyaAja");
  
  const landingTitle = document.getElementById("landing-main-title");
  if (landingTitle) landingTitle.textContent = systemSettings.landingTitle || "Gabung ke Sesi Q&A";
  
  const landingSubtitle = document.getElementById("landing-main-subtitle");
  if (landingSubtitle) landingSubtitle.textContent = systemSettings.landingSubtitle || "Masukkan kode sesi unik untuk mulai berdiskusi dan memberikan suara.";

  // Apply Landing Right
  const rightTitle = document.getElementById("landing-right-title");
  if (rightTitle) {
    const titleText = systemSettings.landingRightTitle || "Make your event Interactive.";
    rightTitle.innerHTML = titleText.replace("Interactive.", `<span class="main-text-primary">Interactive.</span>`);
  }
  
  const rightSubtitle = document.getElementById("landing-right-subtitle");
  if (rightSubtitle) rightSubtitle.textContent = systemSettings.landingRightSubtitle || "Platform Q&A real-time untuk seminar, workshop, dan konferensi profesional.";
  
  const rightBadge = document.getElementById("landing-right-badge-text");
  if (rightBadge) rightBadge.textContent = systemSettings.landingRightBadge || "Trusted by 500+ Events";

  // Apply Login Right
  const loginRightTitle = document.getElementById("login-right-title");
  if (loginRightTitle) loginRightTitle.textContent = systemSettings.loginRightTitle || "Q&A EVENT - HARPER HOTEL PALEMBANG";
  
  const loginRightSubtitle = document.getElementById("login-right-subtitle");
  if (loginRightSubtitle) loginRightSubtitle.textContent = systemSettings.loginRightSubtitle || "Manage your events with ease. Create new sessions, share codes, and monitor discussions in real-time.";

  // Apply Logo
  const logos = document.querySelectorAll(".app-logo-img");
  logos.forEach(img => img.src = systemSettings.logoUrl || "assets/img/logo.png");

  // Apply Backgrounds
  const landingBgs = document.querySelectorAll(".landing-bg-image");
  landingBgs.forEach(el => el.style.backgroundImage = `url(${systemSettings.landingBgUrl || systemSettings.loginBgUrl || "assets/img/login-bg.jpg"})`);

  const loginBgs = document.querySelectorAll(".login-bg-image");
  loginBgs.forEach(el => el.style.backgroundImage = `url(${systemSettings.loginBgUrl || "assets/img/login-bg.jpg"})`);
}

async function saveSystemSettings() {
  // Simpan ke LOKAL TERLEBIH DAHULU agar langsung tampil
  localStorage.setItem("qa_system_settings", JSON.stringify(systemSettings));
  applySystemSettings();
  
  // Save to Firebase for real-time sync
  try {
    await waitForFirebase();
    window.firebaseSet(systemSettingsRef, systemSettings);
    console.log("Settings saved to Firebase successfully!");
  } catch (e) {
    console.error("Error saving to Firebase:", e);
  }
  
  // Also save to Google Apps Script for backup
  try {
    console.log("Saving system settings to Google Apps Script...");
    const params = new URLSearchParams();
    params.append("action", "save_system_settings");
    params.append("settings", JSON.stringify(systemSettings));
    await fetch(`${API_URL}?${params.toString()}`);
    console.log("Settings saved to Google Apps Script successfully!");
  } catch (e) {
    console.error("Error saving to Google Apps Script:", e);
    // Tidak usah alert, karena sudah tersimpan lokal dan Firebase
  }
}

function showSystemSettings() {
  if (currentUser && currentUser.role !== "admin") return alert("Hanya Admin yang bisa mengakses menu ini.");
  
  // Reset to first tab
  switchSettingsTab("branding");

  document.getElementById("sys-set-app-name").value = systemSettings.appName;
  document.getElementById("sys-set-primary-color").value = systemSettings.primaryColor;
  document.getElementById("sys-set-logo-url").value = systemSettings.logoUrl;
  document.getElementById("sys-set-landing-title").value = systemSettings.landingTitle;
  document.getElementById("sys-set-landing-subtitle").value = systemSettings.landingSubtitle;
  
  // Landing Right
  document.getElementById("sys-set-right-title").value = systemSettings.landingRightTitle;
  document.getElementById("sys-set-right-subtitle").value = systemSettings.landingRightSubtitle;
  document.getElementById("sys-set-right-badge").value = systemSettings.landingRightBadge;
  document.getElementById("sys-set-landing-bg-url").value = systemSettings.landingBgUrl || "";
  
  // Login Right
  document.getElementById("sys-set-login-right-title").value = systemSettings.loginRightTitle || "";
  document.getElementById("sys-set-login-right-subtitle").value = systemSettings.loginRightSubtitle || "";
  document.getElementById("sys-set-login-bg-url").value = systemSettings.loginBgUrl;
  
  document.getElementById("sys-set-font").value = systemSettings.appFont;
  
  document.getElementById("system-settings-modal").classList.remove("hidden");
  lucide.createIcons();
}

function switchSettingsTab(tabId) {
  // Hide all sections
  const sections = document.querySelectorAll(".settings-section");
  sections.forEach(s => s.classList.add("hidden"));

  // Show active section
  const activeSection = document.getElementById(`settings-section-${tabId}`);
  if (activeSection) activeSection.classList.remove("hidden");

  // Update buttons
  const buttons = document.querySelectorAll(".settings-tab-btn");
  buttons.forEach(btn => {
    btn.classList.remove("active", "bg-white", "shadow-sm", "text-slate-900", "border", "border-slate-100");
    btn.classList.add("text-slate-400");
  });

  const activeBtn = document.getElementById(`tab-btn-${tabId}`);
  if (activeBtn) {
    activeBtn.classList.add("active", "bg-white", "shadow-sm", "text-slate-900", "border", "border-slate-100");
    activeBtn.classList.remove("text-slate-400");
  }
  
  lucide.createIcons();
}

function hideSystemSettings() {
  document.getElementById("system-settings-modal").classList.add("hidden");
}

async function confirmSaveSystemSettings() {
  systemSettings = {
    appName: document.getElementById("sys-set-app-name").value.trim(),
    primaryColor: document.getElementById("sys-set-primary-color").value,
    logoUrl: document.getElementById("sys-set-logo-url").value.trim(),
    landingTitle: document.getElementById("sys-set-landing-title").value.trim(),
    landingSubtitle: document.getElementById("sys-set-landing-subtitle").value.trim(),
    
    landingRightTitle: document.getElementById("sys-set-right-title").value.trim(),
    landingRightSubtitle: document.getElementById("sys-set-right-subtitle").value.trim(),
    landingRightBadge: document.getElementById("sys-set-right-badge").value.trim(),
    landingBgUrl: document.getElementById("sys-set-landing-bg-url").value.trim(),
    
    loginRightTitle: document.getElementById("sys-set-login-right-title").value.trim(),
    loginRightSubtitle: document.getElementById("sys-set-login-right-subtitle").value.trim(),
    loginBgUrl: document.getElementById("sys-set-login-bg-url").value.trim(),
    
    appFont: document.getElementById("sys-set-font").value
  };
  await saveSystemSettings();
  hideSystemSettings();
  alert("Pengaturan berhasil disimpan!");
}

function handleFileUpload(input, targetField) {
  if (input.files && input.files[0]) {
    const file = input.files[0];
    const reader = new FileReader();

    reader.onload = function(e) {
      const base64Data = e.target.result;
      
      // Map targetField to corresponding input ID
      let inputId = "";
      if (targetField === "logoUrl") inputId = "sys-set-logo-url";
      if (targetField === "loginBgUrl") inputId = "sys-set-login-bg-url";
      if (targetField === "landingBgUrl") inputId = "sys-set-landing-bg-url";

      if (inputId) {
        document.getElementById(inputId).value = base64Data;
        console.log(`Image processed as Base64 for ${targetField}`);
      }
    };

    reader.readAsDataURL(file);
  }
}

// --- NAVIGATION & VIEWS ---

function showLandingPage() {
  hideAllPages();
  document.getElementById("landing-page").classList.remove("hidden");
  lucide.createIcons();
}

async function showMasterDashboard() {
  if (!isAdmin) return showLandingPage();
  if (currentUser.role !== "admin") return showSessionManagement();
  hideAllPages();
  await loadSessions(); // Refresh sessions
  document.getElementById("master-dashboard").classList.remove("hidden");
  updateAdminUI();
  lucide.createIcons();
}

function showAdminAuthPage() {
  hideAllPages();
  document.getElementById("admin-auth-page").classList.remove("hidden");
  lucide.createIcons();
}

function hideAdminAuthPage() {
  showLandingPage();
}

async function showSessionManagement() {
  if (!isAdmin) return showLandingPage();
  hideAllPages();
  await loadSessions(); // Refresh sessions
  document.getElementById("session-management-page").classList.remove("hidden");
  
  // Role-based UI visibility
  const isSuper = currentUser.role === "admin";
  const createBtn = document.querySelector('button[onclick="showCreateSessionModal()"]');
  if (createBtn) createBtn.style.display = isSuper ? "flex" : "none";

  const settingsBtn = document.getElementById("nav-settings-btn");
  if (settingsBtn) settingsBtn.style.display = isSuper ? "block" : "none";

  renderAdminSessions();
  lucide.createIcons();
}

// --- USER MANAGEMENT ---

async function showUserManagement() {
  if (currentUser.role !== "admin") {
    return alert("Hanya Admin yang bisa mengakses menu ini.");
  }
  await loadUsers();
  document.getElementById("user-management-modal").classList.remove("hidden");
  selectRoleInModal("user"); // Default role
  renderUsers();
  lucide.createIcons();
}

function hideUserManagement() {
  document.getElementById("user-management-modal").classList.add("hidden");
}

function selectRoleInModal(role) {
  document.getElementById("new-user-role").value = role;
  
  // Reset all buttons
  const btns = document.querySelectorAll(".role-selector-btn");
  btns.forEach(btn => {
    btn.classList.remove("border-slate-900", "bg-slate-50", "ring-2", "ring-slate-900/10");
    btn.classList.add("bg-white", "border-slate-100");
  });

  // Highlight selected
  const activeBtn = document.getElementById(`role-btn-${role}`);
  if (activeBtn) {
    activeBtn.classList.remove("bg-white", "border-slate-100");
    activeBtn.classList.add("border-slate-900", "bg-slate-50", "ring-2", "ring-slate-900/10");
  }
}

async function addUser() {
  const username = document.getElementById("new-user-username").value.trim();
  const password = document.getElementById("new-user-password").value.trim();
  const role = document.getElementById("new-user-role").value;

  if (!username || !password) return alert("Username dan Password harus diisi.");
  
  try {
    const params = new URLSearchParams({ action: "add_user", username, password, role });
    const response = await fetch(`${API_URL}?${params.toString()}`);
    const result = await response.json();
    
    if (result.status === "success") {
      await loadUsers();
      renderUsers();
      
      // Reset form
      document.getElementById("new-user-username").value = "";
      document.getElementById("new-user-password").value = "";
      selectRoleInModal("user"); // Reset to default role
    } else {
      alert(result.message);
    }
  } catch (e) {
    alert("Gagal menambah user.");
  }
}

function renderUsers() {
  const container = document.getElementById("user-list-container");
  const countBadge = document.getElementById("user-count-badge");
  
  if (countBadge) countBadge.textContent = `${(users || []).length} USER`;

  if (container) {
    container.innerHTML = (users || []).map(u => `
      <div class="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-2xl hover:border-slate-200 transition-all group">
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 ${u.role === "admin" ? "bg-purple-50 text-purple-600" : "bg-blue-50 text-blue-600"} rounded-xl flex items-center justify-center">
            <i data-lucide="${u.role === "admin" ? "shield-check" : "message-square"}" class="w-6 h-6"></i>
          </div>
          <div>
            <h5 class="font-black text-slate-900">${escapeHtml(u.username)}</h5>
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-black uppercase tracking-widest ${u.role === "admin" ? "text-purple-500" : "text-blue-500"}">
                ${u.role === "admin" ? "Admin" : "User"}
              </span>
              <span class="w-1 h-1 bg-slate-200 rounded-full"></span>
              <span class="text-[10px] font-bold text-slate-400 uppercase">Aktif</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          ${u.username !== "admin" ? `
            <button onclick="deleteUser('${u.username}')" class="p-2.5 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all">
              <i data-lucide="trash-2" class="w-5 h-5"></i>
            </button>
          ` : `
            <span class="px-3 py-1 bg-slate-50 text-slate-400 text-[10px] font-black rounded-lg uppercase">System Default</span>
          `}
        </div>
      </div>
    `).join("");
  }
  lucide.createIcons();
}

async function deleteUser(username) {
  if (username === "admin") return alert("User default tidak bisa dihapus.");
  if (confirm(`Hapus user "${username}"?`)) {
    try {
      const params = new URLSearchParams({ action: "delete_user", username });
      const response = await fetch(`${API_URL}?${params.toString()}`);
      const result = await response.json();
      
      if (result.status === "success") {
        await loadUsers();
        renderUsers();
      } else {
        alert(result.message);
      }
    } catch (e) {
      alert("Gagal menghapus user.");
    }
  }
}

function showAdminQADashboard(sessionId) {
  if (!isAdmin) return showParticipantView(sessionId);
  hideAllPages();
  currentSessionId = sessionId.toUpperCase();
  const session = sessions[currentSessionId];
  if (session) {
    document.getElementById("active-session-name").textContent = session.name;
    document.getElementById("active-session-code-display").textContent = `#${session.shortCode || currentSessionId}`;
    // Reset notification count for this session
    notificationRepeatCount = 0;
    if (notificationTimeout) {
      clearTimeout(notificationTimeout);
    }
  }
  // Show timer
  const timerElement = document.getElementById('session-timer');
  if (timerElement) {
    timerElement.style.display = 'inline-block';
  }
  document.getElementById("admin-qa-dashboard").classList.remove("hidden");
  fetchQuestionsFromServer();
  startSessionTimer(currentSessionId);
  lucide.createIcons();
}

function showParticipantView(sessionId) {
  hideAllPages();
  currentSessionId = sessionId.toUpperCase();
  const session = sessions[currentSessionId];
  if (session) {
    document.getElementById("part-session-name").textContent = session.name;
  }
  document.getElementById("participant-dark-view").classList.remove("hidden");
  fetchQuestionsFromServer();
  startSessionTimer(currentSessionId);
  lucide.createIcons();
}

function hideAllPages() {
  // Clear timer when leaving a session
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  // Hide timer
  const timerElement = document.getElementById('session-timer');
  if (timerElement) {
    timerElement.style.display = 'none';
  }
  
  const pages = ["landing-page", "master-dashboard", "session-management-page", "admin-qa-dashboard", "participant-dark-view", "admin-auth-page"];
  pages.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
}

function exitEvent() {
  if (confirm("Apakah Anda yakin ingin keluar dari sesi ini?")) {
    window.location.hash = "";
    showLandingPage();
  }
}

// --- AUTH ---

async function loginAdminFromPage() {
  const user = document.getElementById("admin-page-username").value.trim();
  const pass = document.getElementById("admin-page-password").value.trim();
  
  if (!user || !pass) return alert("Username dan Password harus diisi.");

  // Cek dari server
  const btn = document.querySelector('button[onclick="loginAdminFromPage()"]');
  btn.innerHTML = "Memproses...";
  btn.disabled = true;

  try {
    const params = new URLSearchParams({ action: "login_admin", username: user, password: pass });
    const response = await fetch(`${API_URL}?${params.toString()}`);
    const result = await response.json();

    if (result.status === "success") {
      currentUser = { username: user, role: result.role || "admin" };
      isAdmin = true;
      localStorage.setItem("currentUser", JSON.stringify(currentUser));
      if (currentUser.role === "admin") {
        showMasterDashboard();
      } else {
        showSessionManagement();
      }
    } else {
      alert(result.message || "Login Gagal!");
    }
  } catch (error) {
    console.error("Login error:", error);
    alert("Koneksi gagal ke server Google.");
  } finally {
    btn.innerHTML = "Masuk Sekarang";
    btn.disabled = false;
  }
}

function logoutAdmin() {
  if (confirm("Logout dari akun ini?")) {
    currentUser = null;
    isAdmin = false;
    localStorage.removeItem("currentUser");
    window.location.hash = "";
    showLandingPage();
  }
}

async function joinSessionByCode() {
  const code = document.getElementById("join-session-code").value.trim().toUpperCase(); // Always uppercase
  if (!code) return;
  
  const btn = document.querySelector('button[onclick="joinSessionByCode()"]');
  btn.innerHTML = "...";

  try {
    await waitForFirebase();
    const sessionRef = window.firebaseRef(firebaseDatabase, `sessions/${code}`);
    const snapshot = await new Promise((resolve) => {
      window.firebaseOnValue(sessionRef, resolve, { onlyOnce: true });
    });
    const sessionData = snapshot.val();

    if (sessionData) {
      sessions[code] = { id: code, shortCode: code, name: sessionData.name, questions: [] };
      currentSessionId = code;
      window.location.hash = code; // Set hash in uppercase
      showParticipantView(code);
    } else {
      alert("Sesi tidak ditemukan.");
    }
  } catch (error) {
    alert("Gagal terhubung ke server.");
  } finally {
    btn.innerHTML = "Gabung Sesi";
  }
}

// --- SESSION MANAGEMENT ---

function renderAdminSessions() {
  const tbody = document.getElementById("admin-sessions-table-body");
  let sessionsList = Object.values(sessions);
  
  // Sort sessions: those with new questions first, then by lastActivity
  sessionsList.sort((a, b) => {
    const aNew = a.hasNewQuestions ? 1 : 0;
    const bNew = b.hasNewQuestions ? 1 : 0;
    if (bNew !== aNew) return bNew - aNew;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
  
  document.getElementById("total-sessions-count").textContent = sessionsList.length;

  tbody.innerHTML = sessionsList.map(s => `
    <tr class="cursor-pointer group ${s.hasNewQuestions ? "bg-orange-50 border-l-4 border-orange-500" : ""}" onclick="showAdminQADashboard('${s.id}')">
      <td class="px-8 py-5">
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 ${s.hasNewQuestions ? "bg-orange-100 text-orange-600" : "bg-slate-100 text-slate-400"} rounded-xl flex items-center justify-center group-hover:bg-orange-50 group-hover:text-orange-500 transition-colors">
            <i data-lucide="calendar" class="w-6 h-6"></i>
          </div>
          <div>
            <span class="font-black text-slate-900 text-lg tracking-tight">${escapeHtml(s.name)}</span>
            <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Code: #${s.shortCode}</span>
          </div>
        </div>
      </td>
      <td class="px-8 py-5">
        <div class="inline-flex items-center gap-2.5 px-4 py-2 ${s.hasNewQuestions ? "bg-orange-100 text-orange-600 border-orange-200" : "bg-green-50 text-green-600 border-green-100"} rounded-xl border shadow-sm">
          <div class="w-2 h-2 ${s.hasNewQuestions ? "bg-orange-500" : "bg-green-500"} rounded-full animate-pulse"></div>
          <span class="text-[10px] font-black uppercase tracking-widest">${s.hasNewQuestions ? "Pertanyaan Baru!" : "Active Live"}</span>
        </div>
      </td>
      <td class="px-8 py-5 text-right" onclick="event.stopPropagation()">
        <div class="flex justify-end gap-3">
          <button onclick="showQRCode('${s.id}')" class="p-3 text-slate-400 hover:main-text-primary hover:bg-orange-50 rounded-xl transition-all" title="Share & QR">
            <i data-lucide="share-2" class="w-5 h-5"></i>
          </button>
          ${currentUser.role === "admin" ? `
            <button onclick="deleteSession('${s.id}')" class="p-3 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all" title="Delete Session">
              <i data-lucide="trash-2" class="w-5 h-5"></i>
            </button>
          ` : ""}
        </div>
      </td>
    </tr>
  `).join("");
  lucide.createIcons();
}

function showCreateSessionModal() {
  document.getElementById("create-session-modal").classList.remove("hidden");
}

function hideCreateSessionModal() {
  document.getElementById("create-session-modal").classList.add("hidden");
}

async function confirmCreateSession() {
  const name = document.getElementById("new-session-name").value.trim();
  if (!name) return alert("Nama sesi harus diisi.");
  
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  try {
    await waitForFirebase();
    const sessionRef = window.firebaseRef(firebaseDatabase, `sessions/${code}`);
    await window.firebaseSet(sessionRef, {
      id: code,
      shortCode: code,
      name: name,
      createdAt: Date.now()
    });
    await loadSessions(); // Reload sessions from server
    hideCreateSessionModal();
    renderAdminSessions();
  } catch (e) {
    alert("Gagal membuat sesi.");
  }
}

async function deleteSession(id) {
  if (confirm("Hapus sesi ini?")) {
    try {
      await waitForFirebase();
      const sessionRef = window.firebaseRef(firebaseDatabase, `sessions/${id}`);
      await window.firebaseSet(sessionRef, null);
      await loadSessions(); // Reload sessions from server
      renderAdminSessions();
    } catch (e) {
      alert("Gagal menghapus sesi.");
    }
  }
}

// --- Q&A LOGIC ---

async function fetchQuestionsFromServer() {
  if (!currentSessionId) return;
  
  // Hapus listener lama jika ada
  if (questionsListenerUnsubscribe) {
    questionsListenerUnsubscribe();
    questionsListenerUnsubscribe = null;
  }
  
  // Cek apakah ada input yang sedang fokus agar ketikan tidak hilang
  const focusedElement = document.activeElement;
  const isTyping = focusedElement && (focusedElement.tagName === "INPUT" || focusedElement.tagName === "TEXTAREA");
  const focusedId = focusedElement ? focusedElement.id : null;
  const focusedValue = isTyping ? focusedElement.value : null;
  const selectionStart = isTyping ? focusedElement.selectionStart : null;
  const selectionEnd = isTyping ? focusedElement.selectionEnd : null;

  try {
    await waitForFirebase();
    const sessionQuestionsRef = window.firebaseRef(firebaseDatabase, `sessions/${currentSessionId.toUpperCase()}/questions`);
    
    // Set up real-time listener
    questionsListenerUnsubscribe = window.firebaseOnValue(sessionQuestionsRef, (snapshot) => {
      const questionsData = [];
      let questionCount = 0;
      
      snapshot.forEach((childSnapshot) => {
        const data = childSnapshot.val();
        questionsData.push({
          id: childSnapshot.key, // Firebase unique key!
          text: data.text,
          sender: data.name || "Anonymous",
          upvotes: data.upvotes || 0,
          timestamp: data.timestamp,
          comments: data.replies ? Object.values(data.replies) : [],
          reactions: data.reactions || {}
        });
        questionCount++;
      });
      
      // Track question count changes (for notifications)
      const lastCount = lastQuestionCountPerSession[currentSessionId] || 0;
      if (questionCount > lastCount && isAdmin) {
        lastQuestionCountPerSession[currentSessionId] = questionCount;
        if (sessions[currentSessionId]) {
          sessions[currentSessionId].hasNewQuestions = true;
          sessions[currentSessionId].lastActivity = Date.now();
          renderAdminSessions();
        }
        playNotificationSound();
        if (document.getElementById("admin-qa-dashboard").classList.contains("hidden")) {
          notificationRepeatCount = 0;
          scheduleReminder();
        }
      }

      // Jika sesi belum ada di memory, buatnya
      if (!sessions[currentSessionId]) {
        sessions[currentSessionId] = {
          id: currentSessionId,
          shortCode: currentSessionId,
          name: currentSessionId, // Fallback, should get from somewhere else
          questions: []
        };
      }

      sessions[currentSessionId].questions = questionsData;
      renderQuestions();
      
      // Kembalikan fokus jika ada
      if (isTyping && focusedId) {
        setTimeout(() => {
          const newFocusedElement = document.getElementById(focusedId);
          if (newFocusedElement) {
            newFocusedElement.focus();
            newFocusedElement.value = focusedValue;
            newFocusedElement.setSelectionRange(selectionStart, selectionEnd);
          }
        }, 0);
      }
    }, (error) => {
      console.error("Error listening to questions:", error);
    });
  } catch (e) {
    console.error("Fetch error:", e);
  }
}

function scheduleReminder() {
  if (notificationRepeatCount >= 3) return;
  
  notificationTimeout = setTimeout(() => {
    // Check if we're not in the session dashboard
    if (document.getElementById("admin-qa-dashboard").classList.contains("hidden")) {
      playNotificationSound();
      notificationRepeatCount++;
      scheduleReminder(); // Schedule next reminder
    }
  }, 60000); // 1 minute
}

function renderQuestions() {
  if (isAdmin) {
    // Mark session as read when we're in the dashboard
    if (sessions[currentSessionId]) {
      sessions[currentSessionId].hasNewQuestions = false;
      renderAdminSessions();
      // Clear notifications
      notificationRepeatCount = 0;
      if (notificationTimeout) {
        clearTimeout(notificationTimeout);
      }
    }
    renderAdminQuestions();
  } else {
    renderPartQuestions();
  }
}

function renderAdminQuestions() {
  const list = document.getElementById("admin-questions-list");
  const session = sessions[currentSessionId];
  if (!session) return;
  
  document.getElementById("admin-question-count").textContent = session.questions.length;
  
  list.innerHTML = session.questions.map(q => `
    <div class="bg-white border border-slate-100 rounded-xl p-6 shadow-sm space-y-4" data-id="${q.id}">
      <div class="flex justify-between items-start">
        <div class="flex gap-3">
          <div class="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-400">
            <i data-lucide="user" class="w-6 h-6"></i>
          </div>
          <div>
            <div class="font-bold text-slate-900">${escapeHtml(q.sender)} <span class="text-slate-400 font-normal ml-2">${formatTime(q.timestamp)}</span></div>
            <p class="text-lg text-slate-800 mt-1">${escapeHtml(q.text)}</p>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-1 text-slate-500 font-bold">
            ${q.upvotes} <i data-lucide="thumbs-up" class="w-5 h-5"></i>
          </div>
        </div>
      </div>
      
      <div class="flex gap-2">
        ${Object.entries(q.reactions).map(([emoji, count]) => `
          <span class="px-2 py-1 bg-slate-50 rounded-full text-sm border border-slate-100">${emoji} ${count}</span>
        `).join("")}
        <button onclick="promptNewReaction('${q.id}')" class="p-1 text-slate-400 hover:text-[#ea580c]"><i data-lucide="smile" class="w-5 h-5"></i></button>
      </div>

      <div class="pl-12 space-y-3">
        ${q.comments.map(c => `
          <div class="bg-slate-50 p-3 rounded-lg text-sm text-slate-700">
            <span class="font-bold text-[#ea580c]">Host:</span> ${escapeHtml(c.text)}
          </div>
        `).join("")}
        <div class="flex gap-2">
          <input type="text" id="comment-input-${q.id}" class="flex-1 bg-slate-50 border-none rounded-lg text-sm px-4 py-2" placeholder="Balas sebagai host...">
          <button onclick="submitComment('${q.id}')" class="text-[#ea580c] font-bold text-sm">Balas</button>
        </div>
      </div>
    </div>
  `).join("");
  lucide.createIcons();
}

function renderPartQuestions() {
  const list = document.getElementById("part-questions-list");
  const session = sessions[currentSessionId];
  if (!session) return;

  document.getElementById("part-session-name").textContent = session.name;
  document.getElementById("part-question-count-label").textContent = `${session.questions.length} pertanyaan`;

  list.innerHTML = session.questions.map(q => `
    <div class="bg-[#111] border border-[#222] rounded-2xl p-6 space-y-4 shadow-lg" data-id="${q.id}">
      <div class="flex justify-between items-start">
        <div class="flex gap-4">
          <div class="w-10 h-10 bg-[#222] rounded-full flex items-center justify-center text-slate-500">
            <i data-lucide="user" class="w-6 h-6"></i>
          </div>
          <div>
            <div class="font-bold text-white">${escapeHtml(q.sender)} <span class="text-slate-500 font-normal ml-2">${formatTime(q.timestamp)}</span></div>
            <p class="text-lg text-slate-200 mt-1">${escapeHtml(q.text)}</p>
          </div>
        </div>
        <button onclick="upvoteQuestion('${q.id}')" class="flex items-center gap-2 text-slate-400 hover:text-[#ea580c] transition-colors">
          <span class="font-bold">${q.upvotes}</span>
          <i data-lucide="thumbs-up" class="w-5 h-5"></i>
        </button>
      </div>

      <div class="flex gap-2">
        ${Object.entries(q.reactions).map(([emoji, count]) => `
          <button onclick="addReaction('${q.id}', '${emoji}')" class="px-3 py-1 bg-[#1a1a1a] rounded-full text-sm border border-[#333] text-slate-300 hover:border-[#ea580c] transition-colors">
            ${emoji} ${count}
          </button>
        `).join("")}
        <button onclick="promptNewReaction('${q.id}')" class="p-1 text-slate-500 hover:text-white"><i data-lucide="smile" class="w-5 h-5"></i></button>
      </div>

      <div class="pl-14 space-y-3">
        ${q.comments.map((c, idx) => `
          <div class="bg-[#1a1a1a] p-3 rounded-xl text-sm text-slate-300 border border-[#222]">
            <span class="font-bold text-[#ea580c]">Host:</span> ${escapeHtml(c.text)}
            <div class="mt-2 flex gap-2">
              <button onclick="addReactionToComment('${q.id}', ${idx}, '👍')" class="text-xs text-slate-500 hover:text-[#ea580c]">👍</button>
              <button onclick="addReactionToComment('${q.id}', ${idx}, '❤️')" class="text-xs text-slate-500 hover:text-[#ea580c]">❤️</button>
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `).join("");
  lucide.createIcons();
}

async function submitQuestion() {
  if (isAdmin) return alert("Host tidak bisa mengirim pertanyaan, hanya peserta.");
  const input = document.getElementById("part-question-input");
  const nameInputEl = document.getElementById("part-sender-name");
  const text = input.value.trim();
  const senderName = nameInputEl.value.trim() || "Anonymous";
  
  if (!text) return alert("Pertanyaan tidak boleh kosong");
  
  try {
    await waitForFirebase();
    // Simpan pertanyaan ke Firebase Realtime Database per sesi
    const sessionQuestionsRef = window.firebaseRef(firebaseDatabase, `sessions/${currentSessionId.toUpperCase()}/questions`);
    window.firebasePush(sessionQuestionsRef, {
      name: senderName,
      text: text,
      timestamp: Date.now(),
      replies: {},
      upvotes: 0,
      reactions: {}
    });
    
    input.value = "";
    // fetchQuestionsFromServer will automatically update because of real-time listener!
  } catch (e) {
    console.error("Error submitting question:", e);
    alert("Gagal mengirim pertanyaan: " + e.toString());
  }
}

async function submitComment(qId) {
  if (!isAdmin) return alert("Hanya Host yang bisa memberikan komentar.");
  const input = document.getElementById(`comment-input-${qId}`);
  const text = input.value.trim();
  if (!text) return;

  const question = sessions[currentSessionId].questions.find(q => q.id === qId);
  if (!question) return;

  try {
    await waitForFirebase();
    const repliesRef = window.firebaseRef(firebaseDatabase, `sessions/${currentSessionId.toUpperCase()}/questions/${qId}/replies`);
    window.firebasePush(repliesRef, {
      sender: "Host",
      text: text,
      timestamp: Date.now()
    });
    input.value = "";
  } catch (e) {
    console.error("Error submitting comment:", e);
    alert("Gagal mengirim komentar.");
  }
}

async function upvoteQuestion(qId) {
  const question = sessions[currentSessionId].questions.find(q => q.id === qId);
  if (!question) return;
  try {
    await waitForFirebase();
    const questionRef = window.firebaseRef(firebaseDatabase, `sessions/${currentSessionId.toUpperCase()}/questions/${qId}/upvotes`);
    window.firebaseSet(questionRef, (question.upvotes || 0) + 1);
  } catch (e) {
    console.error("Error upvoting question:", e);
  }
}

async function addReaction(qId, emoji) {
  const question = sessions[currentSessionId].questions.find(q => q.id === qId);
  if (!question) return;
  try {
    await waitForFirebase();
    const reactionCount = (question.reactions && question.reactions[emoji]) ? question.reactions[emoji] : 0;
    const reactionRef = window.firebaseRef(firebaseDatabase, `sessions/${currentSessionId.toUpperCase()}/questions/${qId}/reactions/${emoji}`);
    window.firebaseSet(reactionRef, reactionCount + 1);
  } catch (e) {
    console.error("Error adding reaction:", e);
  }
}

// --- UTILS ---

function getSessionFromUrl() { 
  const hash = window.location.hash.substring(1);
  return hash ? hash.toUpperCase() : ""; 
}
function formatTime(ts) { 
  if (!ts) return "";
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function escapeHtml(text) { 
  const d = document.createElement("div"); 
  d.textContent = text; 
  return d.innerHTML; 
}

function promptNewReaction(qId) {
  activeReactionQuestionId = qId;
  document.getElementById("emoji-modal").classList.remove("hidden");
}

function hideEmojiModal() {
  document.getElementById("emoji-modal").classList.add("hidden");
  activeReactionQuestionId = null;
}

function selectEmoji(emoji) {
  if (activeReactionQuestionId) {
    addReaction(activeReactionQuestionId, emoji);
    hideEmojiModal();
  }
}

function updateAdminUI() {
  // Populate Dashboard Stats
  const totalSessionsEl = document.getElementById("dashboard-total-sessions");
  if (totalSessionsEl) {
    totalSessionsEl.textContent = Object.keys(sessions).length;
  }

  const totalAdminsEl = document.getElementById("dashboard-total-admins");
  if (totalAdminsEl) {
    totalAdminsEl.textContent = (users || []).length;
  }
}

function showQRCode(id) {
  const sessionId = id || currentSessionId;
  const modal = document.getElementById("qr-modal");
  const qrContainer = document.getElementById("qrcode");
  const session = sessions[sessionId];
  if (!session) return;

  document.getElementById("qr-session-name").textContent = session.name;
  document.getElementById("qr-session-id-display").textContent = `#${session.shortCode || sessionId}`;
  
  modal.classList.remove("hidden");
  qrContainer.innerHTML = "";
  const sessionUrl = window.location.origin + window.location.pathname + "#" + sessionId;
  new QRCode(qrContainer, { text: sessionUrl, width: 200, height: 200, colorDark : "#008248", colorLight : "#ffffff" });
}

function hideQRCode() { document.getElementById("qr-modal").classList.add("hidden"); }

function copySessionLink(id) {
  const sessionId = id || currentSessionId;
  const sessionUrl = window.location.origin + window.location.pathname + "#" + sessionId;
  navigator.clipboard.writeText(sessionUrl).then(() => alert("Link disalin!"));
}

function downloadQRCode() {
  const qrContainer = document.getElementById("qrcode");
  const canvas = qrContainer.querySelector("canvas");
  const img = qrContainer.querySelector("img");
  const sessionName = document.getElementById("qr-session-name").textContent;
  
  let dataUrl;
  if (canvas) {
    dataUrl = canvas.toDataURL("image/png");
  } else if (img) {
    dataUrl = img.src;
  }

  if (dataUrl) {
    const link = document.createElement("a");
    link.download = `QR_Code_${sessionName.replace(/\s+/g, "_")}.png`;
    link.href = dataUrl;
    link.click();
  } else {
    alert("Gagal mengunduh QR Code.");
  }
}

// --- PDF EXPORT ---
function downloadQuestionsPDF() {
  const session = sessions[currentSessionId];
  if (!session || !session.questions.length) {
    alert("Tidak ada pertanyaan untuk diunduh.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  // Header Branding
  doc.setFillColor(234, 88, 12); // #ea580c (Orange)
  doc.rect(0, 0, 210, 40, "F");
  
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text("LAPORAN Q&A EVENT", 15, 20);
  
  doc.setFontSize(12);
  doc.setFont("helvetica", "normal");
  doc.text("Harper Hotel Palembang", 15, 30);
  
  // Session Info
  doc.setTextColor(40, 40, 40);
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text(`Sesi: ${session.name}`, 15, 55);
  
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Kode Sesi: #${session.shortCode}`, 15, 62);
  doc.text(`Tanggal Unduh: ${new Date().toLocaleString("id-ID")}`, 15, 67);
  doc.text(`Total Pertanyaan: ${session.questions.length}`, 15, 72);

  // Table Data
  const tableData = session.questions.map((q, index) => {
    let textBalasan = "-";
    if (q.comments && q.comments.length > 0) {
      const balasanArray = q.comments.map(c => c.text).filter(text => text);
      if (balasanArray.length > 0) {
        textBalasan = balasanArray.join("\n");
      }
    }
    
    return [
      index + 1,
      q.sender || "Anonymous",
      q.text,
      q.upvotes,
      formatTime(q.timestamp),
      textBalasan
    ];
  });

  doc.autoTable({
    startY: 80,
    head: [["No", "Pengirim", "Pertanyaan", "Vote", "Waktu", "Jawaban Host"]],
    body: tableData,
    headStyles: { fillColor: [234, 88, 12], textColor: [255, 255, 255], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    styles: { fontSize: 9, cellPadding: 5, overflow: "linebreak" },
    columnStyles: {
      0: { cellWidth: 10 },
      1: { cellWidth: 25, fontStyle: "bold" },
      2: { cellWidth: 60 },
      3: { cellWidth: 12, halign: "center" },
      4: { cellWidth: 20 },
      5: { cellWidth: 73 }
    }
  });

  // Footer
  const pageCount = doc.internal.getNumberOfPages();
  for(let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(`Halaman ${i} dari ${pageCount}`, 105, 290, { align: "center" });
  }
  
  doc.save(`Q&A_Report_${session.name.replace(/\s+/g, "_")}.pdf`);
}

// --- AUTO REFRESH ---
setInterval(fetchQuestionsFromServer, 5000); // Check for new questions every 5 seconds
if (isAdmin) {
  setInterval(loadSessions, 10000); // Refresh sessions every 10 seconds for admins
}

// --- AUTO CLEAR QUESTIONS ---
function scheduleAutoClear() {
  setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    // Check if it's 8 AM or 8 PM
    if ((hour === 8 || hour === 20) && now.getMinutes() === 0 && now.getSeconds() === 0) {
      // Check if we have cleared today
      const lastClear = localStorage.getItem("last_clear_date");
      const today = now.toDateString();
      if (lastClear !== today) {
        localStorage.setItem("last_clear_date", today);
        // Clear all sessions
        Object.keys(sessions).forEach(sessionId => {
          fetch(`${API_URL}?action=clear_session_questions&code=${sessionId}`)
            .catch(e => console.error("Error clearing session:", e));
        });
        // Reload sessions
        loadSessions();
      }
    }
  }, 60000); // Check every minute
}

scheduleAutoClear();
