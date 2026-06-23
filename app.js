// --- CONSTANTS ---
const SESSION_DURATION = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_ID = "default-session";
let sessionsListenerUnsubscribe = null; // Untuk menyimpan fungsi unsubscribe listener sesi

// --- Notification Audio ---
let notificationAudio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-500.wav');
let questionsChildAddedListener = null;

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

// Helper: one-time read from Firebase
async function getOnce(ref) {
  return new Promise((resolve) => {
    let unsubscribe = null;
    unsubscribe = window.firebaseOnValue(ref, (snapshot) => {
      if (unsubscribe) {
        unsubscribe();
      }
      resolve(snapshot);
    });
  });
}

async function startSessionTimer(sessionId) {
  // 1. KUNCI LOGIKA TIMER OTOMATIS: Cek ID sesi terlebih dahulu!
  if (!sessionId || sessionId === "undefined" || sessionId === undefined) {
    console.log("Timer dihentikan: ID sesi tidak valid.");
    return;
  }

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  await waitForFirebase();
  const sessionRef = window.firebaseRef(firebaseDatabase, `sessions/${sessionId}`);

  // Cek apakah sesi masih ada di Firebase sebelum melanjutkan
  const snapshot = await getOnce(sessionRef);
  let sessionData = snapshot.val();
  
  // Jika sesi tidak ada di Firebase, berhenti!
  if (!sessionData) {
    console.log(`Timer dihentikan: Sesi ${sessionId} tidak ditemukan di Firebase.`);
    return;
  }

  let createdAt;
  if (!sessionData.createdAt) {
    createdAt = Date.now();
    await window.firebaseSet(window.firebaseRef(firebaseDatabase, `sessions/${sessionId}/createdAt`), createdAt);
  } else {
    createdAt = sessionData.createdAt;
  }

  const totalDuration = 12 * 60 * 60 * 1000; // 12 hours in ms
  const timerElement = document.getElementById('session-timer');
  if (timerElement) {
    timerElement.style.display = 'inline-block';
  }

  // Timer function dengan pengaman tambahan
  const updateTimer = async () => {
    // Pengaman ekstra: Cek kembali ID sesi setiap detik
    if (!sessionId || sessionId === "undefined") {
      clearInterval(timerInterval);
      timerInterval = null;
      return;
    }

    const expiryTime = createdAt + totalDuration;
    let sisaWaktu = expiryTime - Date.now();

    if (sisaWaktu <= 0) {
      // Cek sekali lagi apakah sesi masih ada sebelum menghapus
      const checkSnapshot = await getOnce(sessionRef);
      if (!checkSnapshot.val()) {
        clearInterval(timerInterval);
        timerInterval = null;
        return;
      }

      const questionsRef = window.firebaseRef(firebaseDatabase, `sessions/${sessionId}/questions`);
      await window.firebaseSet(questionsRef, null);

      const newCreatedAt = Date.now();
      await window.firebaseSet(window.firebaseRef(firebaseDatabase, `sessions/${sessionId}/createdAt`), newCreatedAt);
      
      createdAt = newCreatedAt;
      return;
    }

    const totalSeconds = Math.floor(sisaWaktu / 1000);
    const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');

    if (timerElement) {
      timerElement.textContent = `${hours}:${minutes}:${seconds}`;
    }
  };

  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

// --- STATE ---
let sessions = {};
let users = [];
// Inisialisasi systemSettings tanpa customAudio
let systemSettings = (() => {
  let savedSettings = localStorage.getItem("qa_system_settings");
  if (savedSettings) {
    let parsed = JSON.parse(savedSettings);
    if (parsed.customAudio) delete parsed.customAudio;
    return parsed;
  }
  return {
    appName: "TanyaAja",
    primaryColor: "#ea580c",
    logoUrl: "assets/img/logo.png",
    landingTitle: "Gabung ke Sesi Q&A",
    landingSubtitle: "Masukkan kode sesi unik untuk mulai berdiskusi dan memberikan suara.",
    landingBgUrl: "assets/img/login-bg.jpg",
    loginBgUrl: "assets/img/login-bg.jpg",
    landingRightTitle: "Make your event Interactive.",
    landingRightSubtitle: "Platform Q&A real-time untuk seminar, workshop, dan konferensi profesional.",
    landingRightBadge: "Trusted by 500+ Events",
    loginRightTitle: "Q&A EVENT - HARPER HOTEL PALEMBANG",
    loginRightSubtitle: "Kelola event Anda dengan mudah. Buat sesi baru, bagikan kode, dan pantau jalannya diskusi secara real-time.",
    appFont: "Plus Jakarta Sans"
  };
})();
// Validate and set current user from localStorage
let currentUser = null;
try {
  const storedUser = localStorage.getItem("currentUser");
  if (storedUser) {
    const parsed = JSON.parse(storedUser);
    if (parsed && parsed.username && parsed.role) {
      currentUser = parsed;
    } else {
      localStorage.removeItem("currentUser");
    }
  }
} catch (e) {
  console.error("Error parsing stored user:", e);
  localStorage.removeItem("currentUser");
}
let currentSessionId = getSessionFromUrl() || "";
let isAdmin = currentUser && (currentUser.role === "admin" || currentUser.role === "user" || currentUser.role === "administrator");
let activeReactionQuestionId = null;
let lastQuestionsJson = ""; // Untuk mendeteksi perubahan data
let lastQuestionCountPerSession = {}; // Track last question count per session
let notificationTimeout = null; // Timeout for reminder notifications
let notificationRepeatCount = 0; // Count of reminder notifications

// Create a notification sound
function playNotificationSound() {
  notificationAudio.currentTime = 0;
  notificationAudio.play().catch(err => console.error("Error playing notification sound:", err));
}

// --- APP INITIALIZATION ---
document.addEventListener("DOMContentLoaded", () => {
  // Load saved notification settings
  const savedVolume = localStorage.getItem('notifyVolume');
  if (savedVolume) {
    notificationAudio.volume = parseFloat(savedVolume);
    const volumeInput = document.getElementById('notify-volume');
    const volumeValue = document.getElementById('volume-value');
    if (volumeInput) volumeInput.value = savedVolume;
    if (volumeValue) volumeValue.textContent = `${Math.round(parseFloat(savedVolume) * 100)}%`;
  }

  // Volume slider listener
  const volumeInput = document.getElementById('notify-volume');
  if (volumeInput) {
    volumeInput.addEventListener('input', (e) => {
      const volume = parseFloat(e.target.value);
      notificationAudio.volume = volume;
      localStorage.setItem('notifyVolume', volume.toString());
      const volumeValue = document.getElementById('volume-value');
      if (volumeValue) volumeValue.textContent = `${Math.round(volume * 100)}%`;
    });
  }

  // Custom sound file listener with size validation and Firebase sync
  const soundFileInput = document.getElementById('notify-sound-file');
  if (soundFileInput) {
    soundFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        console.log("Uploading custom sound file...");
        // Validate file size (max 500KB = 500 * 1024 bytes)
        if (file.size > 512000) {
          alert("Ukuran file terlalu besar! Mohon gunakan file MP3 di bawah 500KB agar database tetap ringan.");
          return;
        }
        
        // Convert file to Base64
        const reader = new FileReader();
        reader.onload = async (event) => {
          const base64String = event.target.result;
          console.log("Converted to Base64, saving to Firebase...");
          
          // Save to Firebase
          try {
            await waitForFirebase();
            await window.firebaseSet(window.firebaseRef(window.firebaseDatabase, 'systemSettings/customAudio'), base64String);
            
            // Also update local systemSettings
            systemSettings.customAudio = base64String;
            
            // Apply to audio element
            notificationAudio.src = base64String;
            console.log("Custom sound saved and applied!");
          } catch (err) {
            console.error("Gagal menyimpan nada dering ke Firebase:", err);
          }
        };
        reader.readAsDataURL(file);
      }
    });
  }

  applySystemSettings();
  initApp();
});

async function loadSystemSettings() {
  await waitForFirebase();
  
  // Listen for real-time changes from Firebase
  window.firebaseOnValue(systemSettingsRef, (snapshot) => {
    const data = snapshot.val();
    console.log("System settings from Firebase:", data);
    if (data) {
      systemSettings = { ...systemSettings, ...data };
      // Save settings to localStorage (without customAudio to avoid quota issues)
      const settingsToSave = { ...systemSettings };
      delete settingsToSave.customAudio;
      localStorage.setItem("qa_system_settings", JSON.stringify(settingsToSave));
      applySystemSettings();
      
      // Apply customAudio from Firebase (with logging)
      if (data.customAudio) {
        console.log("Applying custom audio from Firebase");
        notificationAudio.src = data.customAudio;
      } else {
        console.log("No custom audio found, using default");
      }
    }
  }, (error) => {
    console.error("Error listening to Firebase changes:", error);
  });
}



async function initApp() {
  try {
    await loadSystemSettings();
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
  } catch (error) {
    console.error("Error initializing app:", error);
    showLandingPage();
  }
}



async function loadSessions() {
  try {
    await waitForFirebase();
    // Hapus listener lama jika ada untuk menghindari duplikat
    if (sessionsListenerUnsubscribe) {
      sessionsListenerUnsubscribe();
    }
    const sessionsRef = window.firebaseRef(firebaseDatabase, 'sessions');
    sessionsListenerUnsubscribe = window.firebaseOnValue(sessionsRef, async (snapshot) => {
      const data = snapshot.val();
      sessions = {};
      if (data) {
        // 3. FILTER DAN HAPUS OTOMATIS SESI INVALID!
        for (const key of Object.keys(data)) {
          // Filter: Jika key adalah "undefined", null, atau kosong
          if (key === "undefined" || !key || key === "null") {
            console.log(`Menghapus sesi invalid: ${key}`);
            const invalidSessionRef = window.firebaseRef(firebaseDatabase, `sessions/${key}`);
            await window.firebaseSet(invalidSessionRef, null); // Hapus dari Firebase!
          } else {
            // Hanya simpan sesi yang valid
            sessions[key] = data[key];
          }
        }
      }
      console.log("Listener Firebase dipicu! Total sesi valid:", Object.keys(sessions).length);
      renderAdminSessions();
      updateAdminUI();
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
  // Simpan ke LOKAL (tanpa customAudio untuk menghindari quota
  const settingsToSave = { ...systemSettings };
  delete settingsToSave.customAudio; // Hapus customAudio sebelum simpan ke localStorage
  localStorage.setItem("qa_system_settings", JSON.stringify(settingsToSave));
  applySystemSettings();
  
  // Save to Firebase for real-time sync
  try {
    await waitForFirebase();
    window.firebaseSet(systemSettingsRef, systemSettings);
    console.log("Settings saved to Firebase successfully!");
  } catch (e) {
    console.error("Error saving to Firebase:", e);
  }
}

function showSystemSettings() {
  if (currentUser && currentUser.role !== "admin" && currentUser.role !== "administrator") return alert("Hanya Admin yang bisa mengakses menu ini.");
  
  // Reset to first tab
  switchSettingsTab("branding");

  // Show user management tab only if role is administrator
  const userTabBtn = document.getElementById("tab-btn-users");
  if (userTabBtn) {
    userTabBtn.style.display = currentUser.role === "administrator" ? "flex" : "none";
  }

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
  
  // Load users if administrator
  if (currentUser.role === "administrator") {
    loadUsers();
  }
  
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
  // Pertahankan customAudio dari systemSettings lama!
  systemSettings = {
    ...systemSettings,
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
  hideAllPages();
  await loadSessions(); // Refresh sessions
  document.getElementById("master-dashboard").classList.remove("hidden");
  
  // Show/hide System Control card based on role
  const systemControlCard = document.querySelector('div[onclick="showSystemSettings()"]');
  if (systemControlCard) {
    systemControlCard.style.display = currentUser.role === "administrator" ? "block" : "none";
  }
  
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
  const canManage = currentUser.role === "admin" || currentUser.role === "administrator";
  const createBtn = document.querySelector('button[onclick="showCreateSessionModal()"]');
  if (createBtn) createBtn.style.display = canManage ? "flex" : "none";

  renderAdminSessions();
  lucide.createIcons();
}

// --- USER MANAGEMENT ---

async function loadUsers() {
  try {
    await waitForFirebase();
    const usersRef = window.firebaseRef(firebaseDatabase, 'users');
    
    // First, check if we need to create default admin
    const snapshot = await getOnce(usersRef);
    const data = snapshot.val();
    
    if (!data || !data.admin) {
      // Create default admin
      const defaultAdminRef = window.firebaseRef(firebaseDatabase, 'users/admin');
      await window.firebaseSet(defaultAdminRef, {
        username: "admin",
        password: "admin",
        role: "administrator"
      });
    }
    
    // Now set up real-time listener
    window.firebaseOnValue(usersRef, (snapshot) => {
      const data = snapshot.val();
      users = [];
      if (data) {
        // Add all users
        for (const [username, userData] of Object.entries(data)) {
          users.push({
            username: username,
            role: userData.role || "user"
          });
        }
      }
      renderUsers();
    });
  } catch (e) {
    console.error("Error loading users:", e);
  }
}

async function addNewUser() {
  const username = document.getElementById("new-user-username").value.trim();
  const password = document.getElementById("new-user-password").value.trim();
  const role = document.getElementById("new-user-role").value;
  
  if (!username || !password) {
    return alert("Username dan Password harus diisi!");
  }
  
  try {
    await waitForFirebase();
    const userRef = window.firebaseRef(firebaseDatabase, `users/${username}`);
    
    // Check if user already exists
    const snapshot = await getOnce(userRef);
    
    if (snapshot.val()) {
      return alert("Username sudah ada!");
    }
    
    // Create new user
    await window.firebaseSet(userRef, {
      username: username,
      password: password,
      role: role
    });
    
    // Clear form
    document.getElementById("new-user-username").value = "";
    document.getElementById("new-user-password").value = "";
    selectRoleInModal("user");
    
    alert("User berhasil ditambahkan!");
  } catch (e) {
    console.error("Error adding user:", e);
    alert("Gagal menambahkan user!");
  }
}

async function deleteUser(username) {
  if (username === "admin") {
    return alert("Tidak bisa menghapus akun administrator default!");
  }
  
  if (confirm(`Hapus user ${username}?`)) {
    try {
      await waitForFirebase();
      const userRef = window.firebaseRef(firebaseDatabase, `users/${username}`);
      await window.firebaseSet(userRef, null);
      alert("User berhasil dihapus!");
    } catch (e) {
      console.error("Error deleting user:", e);
      alert("Gagal menghapus user!");
    }
  }
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

function renderUsers() {
  const container = document.getElementById("user-list-container");
  const countBadge = document.getElementById("user-count-badge");
  
  if (countBadge) countBadge.textContent = `${(users || []).length} USER`;

  if (container) {
    container.innerHTML = (users || []).map(u => `
      <div class="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-2xl hover:border-slate-200 transition-all group">
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 ${u.role === "administrator" ? "bg-purple-50 text-purple-600" : u.role === "admin" ? "bg-orange-50 text-orange-600" : "bg-blue-50 text-blue-600"} rounded-xl flex items-center justify-center">
            <i data-lucide="${u.role === "administrator" ? "shield" : u.role === "admin" ? "shield-check" : "message-square"}" class="w-6 h-6"></i>
          </div>
          <div>
            <h5 class="font-black text-slate-900">${escapeHtml(u.username)}</h5>
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-black uppercase tracking-widest ${u.role === "administrator" ? "text-purple-500" : u.role === "admin" ? "text-orange-500" : "text-blue-500"}">
                ${u.role === "administrator" ? "Administrator" : u.role === "admin" ? "Admin" : "User"}
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

async function showAdminQADashboard(sessionId) {
  if (!isAdmin) return showParticipantView(sessionId);
  
  // 2. AMANKAN UPDATE STATUS NOTIFIKASI: Cek ID sesi terlebih dahulu
  if (!sessionId || sessionId === "undefined" || sessionId === undefined) {
    console.log("showAdminQADashboard dihentikan: ID sesi tidak valid.");
    return;
  }

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
    // Mark session as read in Firebase (with session ID check)
    await waitForFirebase();
    const isUnreadRef = window.firebaseRef(firebaseDatabase, `sessions/${currentSessionId.toUpperCase()}/isUnread`);
    window.firebaseSet(isUnreadRef, false);
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
  // PENGAMAN TAMBAHAN: Cek ID sesi
  if (!sessionId || sessionId === "undefined" || sessionId === undefined) {
    console.log("showParticipantView dihentikan: ID sesi tidak valid.");
    return;
  }
  
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
  
  if (!user || !pass) return alert("Username dan Password harus diisi!");

  const btn = document.querySelector('button[onclick="loginAdminFromPage()"]');
  btn.innerHTML = "Memproses...";
  btn.disabled = true;

  try {
    await waitForFirebase();
    const userRef = window.firebaseRef(firebaseDatabase, `users/${user}`);
    const snapshot = await new Promise((resolve) => {
      window.firebaseOnValue(userRef, resolve, { onlyOnce: true });
    });
    const userData = snapshot.val();
    
    if (userData && userData.password === pass) {
      currentUser = { username: user, role: userData.role || "user" };
      isAdmin = true;
      localStorage.setItem("currentUser", JSON.stringify(currentUser));
      showMasterDashboard();
    } else {
      alert("Username atau Password salah!");
    }
  } catch (error) {
    console.error("Login error:", error);
    alert("Login gagal.");
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
  let sessionsList = Object.values(sessions).filter(s => {
    // 3. FILTER EKSTRA DI RENDER: Hilangkan sesi dengan id invalid
    return s.id && s.id !== "undefined" && s.id !== "null";
  });
  
  // Sort sessions: those with isUnread first, then by lastActivity
  sessionsList.sort((a, b) => {
    const aNew = a.isUnread ? 1 : 0;
    const bNew = b.isUnread ? 1 : 0;
    if (bNew !== aNew) return bNew - aNew;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
  
  document.getElementById("total-sessions-count").textContent = sessionsList.length;

  tbody.innerHTML = sessionsList.map(s => `
    <tr class="cursor-pointer group ${s.isUnread ? "bg-green-50 border-l-4 border-green-500" : ""}" onclick="showAdminQADashboard('${s.id}')">
      <td class="px-8 py-5">
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 ${s.isUnread ? "bg-green-100 text-green-600" : "bg-slate-100 text-slate-400"} rounded-xl flex items-center justify-center group-hover:bg-green-50 group-hover:text-green-500 transition-colors">
            <i data-lucide="calendar" class="w-6 h-6"></i>
          </div>
          <div>
            <span class="font-black text-slate-900 text-lg tracking-tight">${escapeHtml(s.name)}</span>
            <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Code: #${s.shortCode}</span>
          </div>
        </div>
      </td>
      <td class="px-8 py-5">
        <div class="inline-flex items-center gap-2.5 px-4 py-2 ${s.isUnread ? "bg-green-100 text-green-600 border-green-200" : "bg-green-50 text-green-600 border-green-100"} rounded-xl border shadow-sm">
          <div class="w-2 h-2 ${s.isUnread ? "bg-green-500" : "bg-green-500"} rounded-full animate-pulse"></div>
          <span class="text-[10px] font-black uppercase tracking-widest">${s.isUnread ? "Pertanyaan Baru!" : "Active Live"}</span>
        </div>
      </td>
      <td class="px-8 py-5 text-right" onclick="event.stopPropagation()">
        <div class="flex justify-end gap-3">
          <button onclick="showQRCode('${s.id}')" class="p-3 text-slate-400 hover:main-text-primary hover:bg-orange-50 rounded-xl transition-all" title="Share & QR">
            <i data-lucide="share-2" class="w-5 h-5"></i>
          </button>
          ${currentUser?.role === "admin" || currentUser?.role === "administrator" ? `
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
      createdAt: Date.now(),
      isUnread: false,
      questions: {} // Initialize empty questions object
    });
    hideCreateSessionModal();
  } catch (e) {
    alert("Gagal membuat sesi.");
  }
}

async function deleteSession(id) {
  // PENGAMAN: Jangan izinkan menghapus sesi invalid
  if (!id || id === "undefined" || id === undefined) {
    console.log("deleteSession dihentikan: ID sesi tidak valid.");
    return;
  }
  
  if (confirm("Hapus sesi ini?")) {
    try {
      await waitForFirebase();
      const sessionRef = window.firebaseRef(firebaseDatabase, `sessions/${id}`);
      await window.firebaseSet(sessionRef, null);
      
      // Jika ini sesi yang sedang dibuka, keluar dari halaman
      if (currentSessionId === id) {
        currentSessionId = "";
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
        hideAllPages();
      }
    } catch (e) {
      alert("Gagal menghapus sesi.");
    }
  }
}

// --- Q&A LOGIC ---

async function fetchQuestionsFromServer() {
  // 2. AMANKAN UPDATE STATUS NOTIFIKASI: Cek ID sesi terlebih dahulu
  if (!currentSessionId || currentSessionId === "undefined" || currentSessionId === undefined) {
    console.log("fetchQuestionsFromServer dihentikan: ID sesi tidak valid.");
    return;
  }
  
  // Hapus listener lama jika ada
  if (questionsListenerUnsubscribe) {
    questionsListenerUnsubscribe();
    questionsListenerUnsubscribe = null;
  }
  if (questionsChildAddedListener) {
    questionsChildAddedListener();
    questionsChildAddedListener = null;
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
    let initialLoadComplete = false;
    let lastKnownQuestionIds = new Set(); // Track known question IDs to detect new ones
    
    // Set up real-time value listener (INSTAN update pertanyaan & balasan!)
    questionsListenerUnsubscribe = window.firebaseOnValue(sessionQuestionsRef, (snapshot) => {
      const questionsData = [];
      const currentQuestionIds = new Set();
      let hasNewQuestion = false;
      
      snapshot.forEach((childSnapshot) => {
        const qId = childSnapshot.key;
        const data = childSnapshot.val();
        currentQuestionIds.add(qId);
        
        questionsData.push({
          id: qId, // Firebase unique key!
          text: data.text,
          sender: data.name || "Anonymous",
          upvotes: data.upvotes || 0,
          timestamp: data.timestamp,
          comments: data.replies ? Object.values(data.replies) : [], // Always include all replies!
          reactions: data.reactions || {}
        });
        
        // 3. HANYA NOTIFIKASI UNTUK PERTANYAAN BARU DARI AUDIENS!
        if (initialLoadComplete && !lastKnownQuestionIds.has(qId) && isAdmin) {
          // Pastikan pertanyaan benar-benar baru (timestamp within 3 seconds)
          if (data.timestamp && (Date.now() - data.timestamp < 3000)) {
            hasNewQuestion = true;
          }
        }
      });
      
      // Jika ada pertanyaan baru, mainkan suara dan tandai unread
      if (hasNewQuestion) {
        // Play notification sound
        try {
          notificationAudio.currentTime = 0;
          notificationAudio.play();
        } catch (err) {
          console.error("Error playing sound:", err);
        }
        // Mark session as unread in Firebase (with validation)
        if (sessions[currentSessionId] && currentSessionId && currentSessionId !== "undefined") {
          const isUnreadRef = window.firebaseRef(firebaseDatabase, `sessions/${currentSessionId.toUpperCase()}/isUnread`);
          window.firebaseSet(isUnreadRef, true);
        }
        // Schedule reminder
        if (document.getElementById("admin-qa-dashboard").classList.contains("hidden")) {
          notificationRepeatCount = 0;
          scheduleReminder();
        }
      }
      
      // Update known question IDs
      lastKnownQuestionIds = currentQuestionIds;
      
      // Mark initial load complete
      if (!initialLoadComplete) {
        initialLoadComplete = true;
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

      console.log("Data pertanyaan sebelum sorting:", questionsData.map(q => ({ id: q.id, timestamp: q.timestamp, text: q.text.substring(0, 20) })));
      
      // Balik urutan dan urutkan berdasarkan timestamp (jika ada), atau Firebase key (fallback) agar pertanyaan terbaru di atas
      questionsData.sort((a, b) => {
        // Pertama cek timestamp
        if (a.timestamp && b.timestamp) {
          return b.timestamp - a.timestamp;
        }
        // Jika salah satu tidak punya timestamp, gunakan Firebase key (push ID otomatis terurut waktu)
        // Firebase key diurutkan secara ascending, jadi kita balik agar terbaru di atas
        return b.id.localeCompare(a.id);
      });
      
      console.log("Data pertanyaan setelah sorting:", questionsData.map(q => ({ id: q.id, timestamp: q.timestamp, text: q.text.substring(0, 20) })));
      
      sessions[currentSessionId].questions = questionsData;
      renderQuestions(); // Render INSTAN!
      
      // Kembalikan fokus jika ada (exclude range type)
      if (isTyping && focusedId && document.getElementById(focusedId)?.type !== "range") {
        setTimeout(() => {
          const newFocusedElement = document.getElementById(focusedId);
          if (newFocusedElement) {
            newFocusedElement.focus();
            newFocusedElement.value = focusedValue;
            try {
              newFocusedElement.setSelectionRange(selectionStart, selectionEnd);
            } catch (err) {
              // Ignore error for range inputs
            }
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
            <!-- 3. PERBAIKI RENDER: Pastikan sender selalu tampil -->
            <span class="font-bold text-[#ea580c]">${escapeHtml(c.sender || 'Host')}:</span> ${escapeHtml(c.text)}
          </div>
        `).join("")}
        <div class="flex gap-3">
          <input type="text" id="comment-input-${q.id}" class="flex-1 bg-slate-50 border border-slate-200 rounded-2xl text-sm px-5 py-3 outline-none focus:border-[#ea580c] transition-all" placeholder="Balas sebagai host...">
          <button onclick="submitComment('${q.id}')" class="btn-modern btn-modern-primary text-sm whitespace-nowrap">
            <i data-lucide="send" class="w-4 h-4"></i>
            Balas
          </button>
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
            <!-- 3. PERBAIKI RENDER: Pastikan sender selalu tampil -->
            <span class="font-bold text-[#ea580c]">${escapeHtml(c.sender || 'Host')}:</span> ${escapeHtml(c.text)}
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

  // 2. CEGAH DOUBLE CLICK: Dapatkan tombol dengan lebih aman (by ID or parent)
  const commentContainer = input?.parentElement;
  const button = commentContainer?.querySelector('button');
  const originalButtonHTML = button ? button.innerHTML : '<i data-lucide="send" class="w-4 h-4"></i> Balas';
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Mengirim...';
    lucide.createIcons(); // Update icon
  }

  try {
    // 1. AMANKAN DATA SENDER: Pastikan sender selalu "Host"
    const senderName = (currentUser && currentUser.name) ? currentUser.name : "Host";
    
    await waitForFirebase();
    const repliesRef = window.firebaseRef(firebaseDatabase, `sessions/${currentSessionId.toUpperCase()}/questions/${qId}/replies`);
    await window.firebasePush(repliesRef, {
      sender: senderName,
      text: text,
      timestamp: Date.now()
    });
    
    input.value = ""; // Kosongkan input setelah berhasil
  } catch (e) {
    console.error("Error submitting comment:", e);
    alert("Gagal mengirim komentar: " + e.toString());
  } finally {
    // 2 & 4: PASTIKAN TOMBOL KEMBALI NORMAL SETIAP KONDISI (try atau catch)
    if (button) {
      button.disabled = false;
      button.innerHTML = originalButtonHTML;
      lucide.createIcons(); // Update icon back
    }
  }
}

async function upvoteQuestion(qId) {
  const questionsList = Array.isArray(sessions[currentSessionId]?.questions) ? sessions[currentSessionId].questions : [];
  const question = questionsList.find(q => q.id === qId);
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
  const questionsList = Array.isArray(sessions[currentSessionId]?.questions) ? sessions[currentSessionId].questions : [];
  const question = questionsList.find(q => q.id === qId);
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
  console.log("updateAdminUI() dipanggil! Total sesi saat ini:", Object.keys(sessions).length, "Elemen ditemukan:", !!totalSessionsEl);
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
async function clearSessionQuestionsFirebase(sessionId) {
  try {
    await waitForFirebase();
    const sessionQuestionsRef = window.firebaseRef(firebaseDatabase, `sessions/${sessionId}/questions`);
    window.firebaseSet(sessionQuestionsRef, null);
  } catch (e) {
    console.error("Error clearing session questions in Firebase:", e);
  }
}

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
          clearSessionQuestionsFirebase(sessionId);
        });
      }
    }
  }, 60000); // Check every minute
}

scheduleAutoClear();
