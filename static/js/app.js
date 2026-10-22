// ================= GLOBAL STATE & CONFIG =================

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

let currentUser = null;
let currentTerminals = [];
let currentFloor = null;
let currentFloorToilets = [];
let selectedToiletId = null;
let currentPdfDoc = null;
let currentPdfPage = null;
let currentMapImage = null;
let basePdfScale = 1.0;
let currentZoomLevel = 1.0;
let isRenderingPdf = false;
let historyChartInstance = null;
let isPlacementMode = false;
let isRepositioningToilet = false;
let currentSelectedToiletData = null;
let pendingPlacementCoords = null;
let ws = null;

// Configure PDF.js Worker
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ================= API UTILITY =================
function getToken() {
    return localStorage.getItem('access_token');
}

function setToken(token) {
    if (token) {
        localStorage.setItem('access_token', token);
    } else {
        localStorage.removeItem('access_token');
    }
}

let isLoggingOut = false;
let lastSessionExpiredNoticeTime = 0;

async function apiFetch(url, options = {}) {
    const headers = options.headers || {};
    const token = getToken();
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    if (!(options.body instanceof FormData) && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    options.headers = headers;

    try {
        const response = await fetch(url, options);
        if (response.status === 401) {
            // Unauthorized / expired
            const hadUser = (currentUser !== null) || (getToken() !== null);
            setToken(null);
            currentUser = null;
            updateUserUI();

            const isAuthRoute = url.includes('/api/auth/me') || url.includes('/api/auth/logout') || url.includes('/api/auth/login');
            if (hadUser && !isLoggingOut && !isAuthRoute) {
                const now = Date.now();
                // Throttle notification: at most once every 10 seconds to prevent alert storms
                if (now - lastSessionExpiredNoticeTime > 10000) {
                    lastSessionExpiredNoticeTime = now;
                    showToast("Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.", "OFFLINE");
                    openLoginModal();
                }
            }
            throw new Error("Unauthorized");
        }
        return response;
    } catch (err) {
        throw err;
    }
}

// ================= INITIALIZATION =================
document.addEventListener("DOMContentLoaded", async () => {
    await checkCurrentUser();
    await loadTerminals();
    await updateUnackAlertsCount();
    initWebSocket();
    startAutoPolling();

    // Map scroll wrapper mouse wheel zoom (Ctrl + Wheel)
    const mapScrollWrapper = document.getElementById('map-scroll-wrapper');
    if (mapScrollWrapper) {
        mapScrollWrapper.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                if (e.deltaY < 0) {
                    zoomMap(0.15);
                } else {
                    zoomMap(-0.15);
                }
            }
        }, { passive: false });
    }
});

// ================= AUTHENTICATION =================
async function checkCurrentUser() {
    const token = getToken();
    if (!token) {
        currentUser = null;
        updateUserUI();
        return;
    }
    try {
        const res = await apiFetch('/api/auth/me');
        if (res.ok) {
            currentUser = await res.json();
            updateUserUI();
            if (currentUser.must_change_password) {
                document.getElementById('modal-force-pwd').style.display = 'flex';
            }
        } else {
            currentUser = null;
            setToken(null);
            updateUserUI();
        }
    } catch (err) {
        currentUser = null;
        updateUserUI();
    }
}

function updateUserUI() {
    const profileBox = document.getElementById('user-profile-box');
    const loginBtn = document.getElementById('btn-login-open');
    const adminNav = document.getElementById('nav-admin');
    const adminMapTools = document.getElementById('admin-map-tools');
    const adminToiletActions = document.getElementById('admin-toilet-actions');
    const addCabinBtn = document.getElementById('btn-add-cabin-panel');
    const editToiletBtn = document.getElementById('btn-edit-toilet-panel');

    if (currentUser) {
        profileBox.style.display = 'inline-block';
        loginBtn.style.display = 'none';
        document.getElementById('display-username').innerText = currentUser.username;
        const roleBadge = document.getElementById('display-role');
        roleBadge.innerText = currentUser.role.toUpperCase();
        roleBadge.className = `role-badge ${currentUser.role}`;

        if (currentUser.role === 'admin') {
            adminNav.style.display = 'inline-flex';
            if (adminMapTools) adminMapTools.style.display = 'flex';
            if (adminToiletActions) adminToiletActions.style.display = 'flex';
            if (addCabinBtn) addCabinBtn.style.display = 'inline-flex';
            if (editToiletBtn) editToiletBtn.style.display = 'inline-block';
            const paperWrap = document.getElementById('panel-toilet-paper-wrap');
            if (paperWrap && selectedToiletId) paperWrap.style.display = 'flex';
        } else {
            adminNav.style.display = 'none';
            if (adminMapTools) adminMapTools.style.display = 'none';
            if (adminToiletActions) adminToiletActions.style.display = 'none';
            if (addCabinBtn) addCabinBtn.style.display = 'none';
            if (editToiletBtn) editToiletBtn.style.display = 'none';
            const paperWrap = document.getElementById('panel-toilet-paper-wrap');
            if (paperWrap) paperWrap.style.display = 'none';
        }
    } else {
        profileBox.style.display = 'none';
        loginBtn.style.display = 'inline-flex';
        adminNav.style.display = 'none';
        if (adminMapTools) adminMapTools.style.display = 'none';
        if (adminToiletActions) adminToiletActions.style.display = 'none';
        if (addCabinBtn) addCabinBtn.style.display = 'none';
        if (editToiletBtn) editToiletBtn.style.display = 'none';
    }
}

function toggleUserDropdown(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const menu = document.getElementById('user-dropdown-menu');
    const btn = document.getElementById('btn-user-dropdown');
    if (menu) {
        const isShown = menu.classList.contains('show') || menu.style.display === 'block';
        if (isShown) {
            menu.classList.remove('show');
            menu.style.display = 'none';
            if (btn) btn.classList.remove('active');
        } else {
            menu.classList.add('show');
            menu.style.display = 'block';
            if (btn) btn.classList.add('active');
        }
    }
}

function closeUserDropdown() {
    const menu = document.getElementById('user-dropdown-menu');
    const btn = document.getElementById('btn-user-dropdown');
    if (menu) {
        menu.classList.remove('show');
        menu.style.display = 'none';
    }
    if (btn) {
        btn.classList.remove('active');
    }
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    const container = document.getElementById('user-profile-box');
    if (container && !container.contains(e.target)) {
        closeUserDropdown();
    }
});

function openLoginModal() {
    document.getElementById('login-error').style.display = 'none';
    document.getElementById('modal-login').style.display = 'flex';
}
function closeLoginModal() {
    document.getElementById('modal-login').style.display = 'none';
}

async function handleLoginSubmit(e) {
    e.preventDefault();
    const u = document.getElementById('login-username').value.trim();
    const p = document.getElementById('login-password').value;
    const errBox = document.getElementById('login-error');

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (!res.ok) {
            errBox.innerText = data.detail || "Đăng nhập thất bại";
            errBox.style.display = 'block';
            return;
        }

        setToken(data.access_token);
        currentUser = {
            username: data.username,
            role: data.role,
            must_change_password: data.must_change_password
        };
        closeLoginModal();
        updateUserUI();
        showToast(`Xin chào ${data.username}!`, "OK");

        if (data.must_change_password) {
            document.getElementById('modal-force-pwd').style.display = 'flex';
        } else {
            loadTerminals();
        }
    } catch (err) {
        errBox.innerText = "Lỗi kết nối máy chủ";
        errBox.style.display = 'block';
    }
}

async function handleForcePasswordSubmit(e) {
    e.preventDefault();
    const oldP = document.getElementById('force-old-pwd').value;
    const newP = document.getElementById('force-new-pwd').value;
    const errBox = document.getElementById('force-pwd-error');

    try {
        const res = await apiFetch('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({ old_password: oldP, new_password: newP })
        });
        const data = await res.json();
        if (!res.ok) {
            errBox.innerText = data.detail || "Đổi mật khẩu thất bại";
            errBox.style.display = 'block';
            return;
        }
        document.getElementById('modal-force-pwd').style.display = 'none';
        showToast("Đổi mật khẩu thành công!", "OK");
        currentUser.must_change_password = false;
        loadTerminals();
    } catch (err) {
        errBox.innerText = "Lỗi thực hiện đổi mật khẩu";
        errBox.style.display = 'block';
    }
}

function openChangePasswordModal() {
    document.getElementById('chg-pwd-error').style.display = 'none';
    document.getElementById('chg-old-pwd').value = '';
    document.getElementById('chg-new-pwd').value = '';
    document.getElementById('modal-change-pwd').style.display = 'flex';
}
function closeChangePasswordModal() {
    document.getElementById('modal-change-pwd').style.display = 'none';
}

async function handleChangePasswordSubmit(e) {
    e.preventDefault();
    const oldP = document.getElementById('chg-old-pwd').value;
    const newP = document.getElementById('chg-new-pwd').value;
    const errBox = document.getElementById('chg-pwd-error');

    try {
        const res = await apiFetch('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({ old_password: oldP, new_password: newP })
        });
        const data = await res.json();
        if (!res.ok) {
            errBox.innerText = data.detail || "Đổi mật khẩu thất bại";
            errBox.style.display = 'block';
            return;
        }
        closeChangePasswordModal();
        showToast("Đổi mật khẩu thành công!", "OK");
    } catch (err) {
        errBox.innerText = "Lỗi thực hiện";
        errBox.style.display = 'block';
    }
}

async function handleLogout() {
    isLoggingOut = true;
    try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {}
    setToken(null);
    currentUser = null;
    selectedToiletId = null;

    closeLoginModal();
    const panelBody = document.getElementById('panel-body');
    if (panelBody) panelBody.style.display = 'none';

    updateUserUI();
    showToast("Đã đăng xuất thành công", "OK");
    switchView('dashboard');

    setTimeout(() => {
        isLoggingOut = false;
    }, 1500);
}

// ================= REALTIME WEBSOCKET & AUTO-POLLING FALLBACK =================
let autoPollTimer = null;
function startAutoPolling() {
    if (autoPollTimer) return;
    autoPollTimer = setInterval(async () => {
        // CHỈ polling khi người dùng đang đăng nhập và không trong quá trình đăng xuất
        if ((!currentUser && !getToken()) || isLoggingOut) return;

        // 1. Tự động cập nhật bảng thông tin Toilet và danh sách Cabin nếu đang mở xem
        if (selectedToiletId) {
            try {
                const res = await apiFetch(`/api/toilets/${selectedToiletId}`);
                if (res.ok) {
                    const data = await res.json();
                    renderToiletDetailPanel(data);
                }
            } catch (err) {
                // Im lặng bỏ qua lỗi mạng tạm thời
            }
        }

        // 2. Tự động cập nhật màu trạng thái các điểm Toilet trên bản đồ tầng hiện tại
        if (currentFloor && document.getElementById('view-dashboard') && document.getElementById('view-dashboard').style.display !== 'none') {
            try {
                const res = await apiFetch(`/api/floors/${currentFloor.id}`);
                if (res.ok) {
                    const floorData = await res.json();
                    if (floorData.toilets) {
                        floorData.toilets.forEach(t => {
                            const marker = document.getElementById(`toilet-marker-${t.id}`);
                            if (marker) {
                                marker.className = `toilet-marker ${t.status} ${selectedToiletId === t.id ? 'selected' : ''}`;
                            }
                        });
                    }
                }
            } catch (err) {}
        }
    }, 3000); // Polling chu kỳ 3 giây đảm bảo dữ liệu luôn thời gian thực
}

function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const indicator = document.getElementById('ws-indicator');
    const text = document.getElementById('ws-text');

    let pingInterval = null;

    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.error("Lỗi khởi tạo WebSocket:", err);
        return;
    }

    ws.onopen = () => {
        indicator.className = 'ws-dot connected';
        text.innerText = 'Trực tuyến';
        // Gửi heartbeat ping mỗi 25s để Fly.io proxy không ngắt kết nối do idle timeout
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send("ping");
            }
        }, 25000);
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleWsMessage(msg);
        } catch (e) {
            // Nhận phản hồi pong từ server
        }
    };

    ws.onclose = () => {
        if (pingInterval) clearInterval(pingInterval);
        indicator.className = 'ws-dot connected';
        text.innerText = 'Trực tuyến';
        setTimeout(initWebSocket, 5000);
    };

    ws.onerror = () => {
        if (pingInterval) clearInterval(pingInterval);
        ws.close();
    };
}

function handleWsMessage(msg) {
    if (msg.event === 'STATE_UPDATE' || msg.event === 'GATEWAY_UPDATE') {
        const data = msg.data;
        // Update floor markers if current floor matches
        if (data.floor_id && currentFloor && currentFloor.id === data.floor_id) {
            // Update in-memory currentFloorToilets so subsequent renderMarkers preserves the status
            const t = currentFloorToilets.find(x => x.id === data.toilet_id);
            const incomingSt = data.status || data.toilet_status;
            if (t) {
                if (incomingSt && incomingSt !== 'undefined') {
                    t.status = incomingSt;
                }
                if (data.gateway_online !== undefined) t.gateway_online = data.gateway_online;
                if (data.toilet_min_paper !== undefined && data.toilet_min_paper !== null) {
                    t.min_paper = data.toilet_min_paper;
                } else if (data.devices && data.devices.length > 0) {
                    t.min_paper = Math.min(...data.devices.map(d => d.paper_level));
                }
            }
            const marker = document.getElementById(`toilet-marker-${data.toilet_id}`);
            if (marker) {
                const effectiveSt = (incomingSt && incomingSt !== 'undefined') ? incomingSt : (t ? t.status : 'OK');
                marker.className = `toilet-marker ${effectiveSt} ${selectedToiletId === data.toilet_id ? 'selected' : ''}`;
                const label = marker.querySelector('.marker-label');
                if (label) {
                    const minPaperVal = (t && t.min_paper !== undefined && t.min_paper !== null) ? `${Math.round(t.min_paper)}%` : '';
                    const statusText = (effectiveSt === 'OFFLINE') ? 'Mất kết nối' : minPaperVal;
                    label.innerText = `${data.toilet_name || (t ? t.name : '')} (${statusText})`;
                }
            }
        }
        // Update detail panel if this toilet is currently selected
        if (data.toilet_id && selectedToiletId === data.toilet_id) {
            updateToiletDetailPanelFromWs(data);
        }

        // TỰ ĐỘNG CẬP NHẬT TRẠNG THÁI WC & GATEWAY TRONG TAB "Quản lý Phân cấp Gateway & Thiết Bị ESP"
        updateGatewayTreeFromWs(data);

        // Update summary table if currently visible
        if (document.getElementById('view-summary') && document.getElementById('view-summary').style.display !== 'none') {
            loadSummaryData();
        }
    } else if (msg.event === 'DISCOVERED_CLIENT_DELETED') {
        const deletedMac = (msg.data && msg.data.mac_address) ? msg.data.mac_address.toUpperCase() : '';
        if (deletedMac) {
            if (currentSelectedToiletData && currentSelectedToiletData.discovered_devices) {
                currentSelectedToiletData.discovered_devices = currentSelectedToiletData.discovered_devices.filter(
                    d => (d.mac_address || '').toUpperCase() !== deletedMac
                );
                renderToiletDetailPanel(currentSelectedToiletData);
            }
            Object.keys(currentDiscoveredMap).forEach(k => {
                if (Array.isArray(currentDiscoveredMap[k])) {
                    currentDiscoveredMap[k] = currentDiscoveredMap[k].filter(
                        d => (d.mac_address || '').toUpperCase() !== deletedMac
                    );
                }
            });
            if (currentAdminGateways) {
                currentAdminGateways.forEach(gw => {
                    if (gw.discovered_devices) {
                        gw.discovered_devices = gw.discovered_devices.filter(
                            d => (d.mac_address || '').toUpperCase() !== deletedMac
                        );
                    }
                });
                renderAdminGatewaysTree();
            }
        }
    } else if (msg.event === 'DISCOVERED_CLIENTS_UPDATE') {
        const data = msg.data;
        // If current toilet is linked to this gateway IP or toilet ID, update discovered devices
        if (currentSelectedToiletData && (currentSelectedToiletData.gateway_ip === data.gateway_ip || selectedToiletId === data.toilet_id)) {
            currentSelectedToiletData.discovered_devices = data.discovered_devices;
            renderToiletDetailPanel(currentSelectedToiletData);
        }
        updateGatewayTreeFromWs(data);
    } else if (msg.event === 'NEW_ALERT') {
        const alertData = msg.data;
        showToast(`CẢNH BÁO [${alertData.type}]: ${alertData.toilet_name} (${alertData.device_label})`, alertData.type);
        updateUnackAlertsCount();
        fetchAndShowAlertPopup();
        if (document.getElementById('view-alerts').style.display !== 'none') {
            loadAlertsData();
        }
    } else if (msg.event === 'ALERT_ACKNOWLEDGED') {
        updateUnackAlertsCount();
        if (document.getElementById('view-alerts').style.display !== 'none') {
            loadAlertsData();
        }
        if (document.getElementById('view-summary').style.display !== 'none') {
            loadSummaryData();
        }
        if (msg.data && msg.data.all) {
            closeAlertPopup();
        }
    }
}

// ================= VIEW SWITCHING =================
function switchView(viewName) {
    const views = ['dashboard', 'summary', 'alerts', 'admin'];
    views.forEach(v => {
        const el = document.getElementById(`view-${v}`);
        if (el) el.style.display = (v === viewName) ? 'block' : 'none';
    });

    const navItems = document.querySelectorAll('#main-nav .nav-item');
    navItems.forEach(item => item.classList.remove('active'));

    const btnMap = {
        'dashboard': 0,
        'summary': 1,
        'alerts': 2,
        'admin': 3
    };
    if (navItems[btnMap[viewName]]) {
        navItems[btnMap[viewName]].classList.add('active');
    }

    if (viewName === 'dashboard') {
        if (currentFloor && (currentUser || getToken()) && !isLoggingOut) {
            apiFetch(`/api/floors/${currentFloor.id}`).then(r => r.ok ? r.json() : null).then(fl => {
                if (fl && fl.toilets) {
                    currentFloorToilets = fl.toilets;
                    renderMarkers();
                    if (selectedToiletId) selectToilet(selectedToiletId);
                }
            }).catch(() => {});
        }
        if ((currentMapImage || currentPdfPage) && currentZoomLevel === 1.0 && currentFloor) {
            setTimeout(() => {
                basePdfScale = calculateBasePdfScale();
                renderCurrentPdfPage();
            }, 50);
        }
    } else if (viewName === 'summary') {
        loadSummaryData();
    } else if (viewName === 'alerts') {
        loadAlertsData();
    } else if (viewName === 'admin') {
        loadAdminUsers();
        loadAdminTerminals();
        loadAdminGateways();
        loadAdminDevices();
    }
}

// ================= TERMINAL & FLOOR DATA =================
async function loadTerminals() {
    try {
        const res = await apiFetch('/api/terminals');
        if (!res.ok) return;
        currentTerminals = await res.json();
        
        const termSelect = document.getElementById('sel-terminal');
        termSelect.innerHTML = '';
        currentTerminals.forEach(term => {
            const opt = document.createElement('option');
            opt.value = term.id;
            opt.innerText = `Nhà ga ${term.name}`;
            termSelect.appendChild(opt);
        });

        onTerminalChanged();
    } catch (err) {
        console.error("Error loading terminals:", err);
    }
}

function onTerminalChanged() {
    const termId = parseInt(document.getElementById('sel-terminal').value);
    const terminal = currentTerminals.find(t => t.id === termId);
    const floorSelect = document.getElementById('sel-floor');
    floorSelect.innerHTML = '';

    if (terminal && terminal.floors.length > 0) {
        // Natural floor order: Tầng hầm (-1) -> Tầng G (0) -> Lầu 1 (1) -> Lầu 2 (2) -> Lầu 3 (3) ...
        const getFloorOrder = (name) => {
            const n = name.toLowerCase();
            if (n.includes('hầm') || n.includes('ham')) return -1;
            if (n.includes('g') || n.includes('trệt') || n.includes('tret')) return 0;
            const m = n.match(/\d+/);
            return m ? parseInt(m[0]) : 99;
        };
        terminal.floors.sort((a, b) => getFloorOrder(a.name) - getFloorOrder(b.name));

        terminal.floors.forEach(fl => {
            const opt = document.createElement('option');
            opt.value = fl.id;
            opt.innerText = fl.name;
            floorSelect.appendChild(opt);
        });
        onFloorChanged();
    }
}

async function onFloorChanged() {
    const floorId = parseInt(document.getElementById('sel-floor').value);
    if (!floorId) return;

    if (isRepositioningToilet) {
        toggleRepositionToiletMode();
    }
    selectedToiletId = null;
    closeChart();
    document.getElementById('panel-body').style.display = 'none';

    document.getElementById('map-loading').style.display = 'block';
    document.getElementById('map-canvas-container').style.display = 'none';

    try {
        const res = await apiFetch(`/api/floors/${floorId}`);
        if (!res.ok) return;
        currentFloor = await res.json();
        currentFloorToilets = currentFloor.toilets || [];

        await renderFloorMap(currentFloor.map_image_path, currentFloor.map_pdf_path);
    } catch (err) {
        console.error("Error loading floor:", err);
    }
}

// ================= MAP / PDF RENDERING & MARKERS =================
function calculateBasePdfScale() {
    let unscaledWidth = 0;
    let unscaledHeight = 0;

    if (currentMapImage) {
        unscaledWidth = currentMapImage.naturalWidth || currentMapImage.width;
        unscaledHeight = currentMapImage.naturalHeight || currentMapImage.height;
    } else if (currentPdfPage) {
        const unscaledViewport = currentPdfPage.getViewport({ scale: 1.0 });
        unscaledWidth = unscaledViewport.width;
        unscaledHeight = unscaledViewport.height;
    } else {
        return 1.0;
    }

    const container = document.getElementById('map-scroll-wrapper');
    if (!container) return 1.0;

    // Available inner dimensions with safe margins
    const paddingX = 24;
    const paddingY = 24;
    const availWidth = Math.max(160, container.clientWidth - paddingX);
    const availHeight = Math.max(160, (container.clientHeight || 500) - paddingY);

    const scaleX = availWidth / unscaledWidth;
    const scaleY = availHeight / unscaledHeight;

    // Baseline fit scale
    const fitScale = Math.min(scaleX, scaleY);
    // User requested that what was 75% zoom level is now the standard 100% zoom level (1.75 * 0.75 = 1.3125)
    return fitScale * 1.3125;
}

async function renderFloorMap(imageUrl, pdfUrl) {
    currentMapImage = null;
    currentPdfPage = null;
    currentPdfDoc = null;

    if (!imageUrl && !pdfUrl) {
        document.getElementById('map-loading').innerText = "Tầng này chưa có bản đồ. Hãy tải lên trong trang Quản trị.";
        const zoomCtrl = document.getElementById('map-zoom-controls');
        if (zoomCtrl) zoomCtrl.style.display = 'none';
        return;
    }

    // Ưu tiên 1: Tải ảnh rasterized siêu tốc (< 50ms) nếu có
    if (imageUrl) {
        try {
            const img = new Image();
            img.src = imageUrl;
            if (img.decode) {
                await img.decode();
            } else {
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                });
            }
            currentMapImage = img;
            basePdfScale = calculateBasePdfScale();
            currentZoomLevel = 1.0;
            await renderCurrentPdfPage();

            const zoomCtrl = document.getElementById('map-zoom-controls');
            if (zoomCtrl) zoomCtrl.style.display = 'flex';
            return;
        } catch (imgErr) {
            console.warn("Không thể tải ảnh bản đồ, fallback sang PDF.js:", imgErr);
            currentMapImage = null;
        }
    }

    // Ưu tiên 2: Fallback sang PDF.js nếu không có ảnh hoặc tải ảnh lỗi
    if (pdfUrl) {
        await renderFloorPdf(pdfUrl);
    }
}

async function renderFloorPdf(pdfUrl) {
    if (!pdfUrl) {
        document.getElementById('map-loading').innerText = "Tầng này chưa có bản đồ PDF. Hãy tải lên trong trang Quản trị.";
        const zoomCtrl = document.getElementById('map-zoom-controls');
        if (zoomCtrl) zoomCtrl.style.display = 'none';
        return;
    }

    try {
        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        currentPdfDoc = await loadingTask.promise;
        currentPdfPage = await currentPdfDoc.getPage(1);

        basePdfScale = calculateBasePdfScale();
        currentZoomLevel = 1.0;

        await renderCurrentPdfPage();

        const zoomCtrl = document.getElementById('map-zoom-controls');
        if (zoomCtrl) zoomCtrl.style.display = 'flex';
    } catch (err) {
        console.error("Error rendering PDF:", err);
        document.getElementById('map-loading').innerText = "Không thể tải file PDF bản đồ: " + err.message;
        const zoomCtrl = document.getElementById('map-zoom-controls');
        if (zoomCtrl) zoomCtrl.style.display = 'none';
    }
}

async function renderCurrentPdfPage() {
    if ((!currentMapImage && !currentPdfPage) || isRenderingPdf) return;
    isRenderingPdf = true;

    try {
        const scale = basePdfScale * currentZoomLevel;
        const canvas = document.getElementById('pdf-canvas');
        const context = canvas.getContext('2d');
        const canvasContainer = document.getElementById('map-canvas-container');

        let displayWidth = 0;
        let displayHeight = 0;

        if (currentMapImage) {
            const unscaledWidth = currentMapImage.naturalWidth || currentMapImage.width;
            const unscaledHeight = currentMapImage.naturalHeight || currentMapImage.height;
            displayWidth = Math.round(unscaledWidth * scale);
            displayHeight = Math.round(unscaledHeight * scale);

            // Tối ưu độ nét cho màn hình Retina / High-DPI
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.round(displayWidth * dpr);
            canvas.height = Math.round(displayHeight * dpr);

            // Vẽ ảnh tức thì bằng phần cứng đồ hoạ (hardware accelerated)
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(currentMapImage, 0, 0, canvas.width, canvas.height);
        } else if (currentPdfPage) {
            const viewport = currentPdfPage.getViewport({ scale: scale });
            displayWidth = viewport.width;
            displayHeight = viewport.height;

            canvas.width = viewport.width;
            canvas.height = viewport.height;

            const renderContext = {
                canvasContext: context,
                viewport: viewport
            };

            await currentPdfPage.render(renderContext).promise;
        }

        document.getElementById('map-loading').style.display = 'none';
        canvasContainer.style.display = 'block';
        canvasContainer.style.width = `${displayWidth}px`;
        canvasContainer.style.height = `${displayHeight}px`;

        const zoomText = document.getElementById('zoom-percentage');
        if (zoomText) {
            zoomText.innerText = `${Math.round(currentZoomLevel * 100)}%`;
        }

        renderMarkers();
    } catch (err) {
        console.error("Error in renderCurrentPdfPage:", err);
    } finally {
        isRenderingPdf = false;
    }
}

async function zoomMap(delta) {
    if (!currentMapImage && !currentPdfPage) return;
    let newZoom = Math.round((currentZoomLevel + delta) * 100) / 100;
    newZoom = Math.max(0.35, Math.min(3.5, newZoom));
    if (newZoom === currentZoomLevel) return;
    currentZoomLevel = newZoom;
    await renderCurrentPdfPage();
}

async function resetZoomMap() {
    if (!currentMapImage && !currentPdfPage) return;
    basePdfScale = calculateBasePdfScale();
    currentZoomLevel = 1.0;
    await renderCurrentPdfPage();
}

// Window resize handler: auto refit map if at 100% zoom
let mapResizeTimeout = null;
window.addEventListener('resize', () => {
    clearTimeout(mapResizeTimeout);
    mapResizeTimeout = setTimeout(() => {
        if ((currentMapImage || currentPdfPage) && currentZoomLevel === 1.0 && currentFloor) {
            basePdfScale = calculateBasePdfScale();
            renderCurrentPdfPage();
        }
    }, 200);
});

function renderMarkers() {
    const layer = document.getElementById('markers-layer');
    layer.innerHTML = '';

    currentFloorToilets.forEach(t => {
        const marker = document.createElement('div');
        marker.id = `toilet-marker-${t.id}`;
        const isSelected = (selectedToiletId === t.id);
        const isRepositioningThis = (isRepositioningToilet && isSelected && currentUser && currentUser.role === 'admin');

        const hasGateway = !!(t.gateway_id || t.gateway_ip);
        const isGwOnline = !!t.gateway_online;
        const hasDevices = (t.device_count > 0 || (t.devices && t.devices.length > 0));

        // Chỉ hiển thị màu sắc hoạt động (OK / LOW / EMPTY) khi CÓ TÍN HIỆU ĐANG ĐƯỢC SỬ DỤNG
        // Nếu không có gateway hoặc mất kết nối gateway hoặc chưa có thiết bị -> luôn để màu xám (OFFLINE)
        const isLiveAndInUse = hasGateway && isGwOnline && hasDevices;
        const effectiveStatus = isLiveAndInUse ? t.status : 'OFFLINE';

        marker.className = `toilet-marker ${effectiveStatus} ${isSelected ? 'selected' : ''} ${isRepositioningThis ? 'reposition-active' : ''}`;
        marker.style.left = `${t.x * 100}%`;
        marker.style.top = `${t.y * 100}%`;

        let statusText = '';
        if (!hasGateway) {
            statusText = 'Chưa gán Gateway';
        } else if (!isGwOnline) {
            statusText = 'Mất kết nối Gateway';
        } else if (!hasDevices) {
            statusText = 'Chưa có thiết bị';
        } else if (effectiveStatus === 'OFFLINE') {
            statusText = 'Mất kết nối thiết bị';
        } else {
            statusText = `${Math.round(t.min_paper)}%`;
        }
        marker.title = `${t.name} (${statusText})`;

        marker.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M7 21h10a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z"></path>
                <circle cx="12" cy="5" r="2"></circle>
            </svg>
            <div class="marker-label">${t.name} (${statusText})</div>
        `;

        // Click to view details
        marker.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isRepositioningToilet && selectedToiletId === t.id) {
                // Clicking the active marker during repositioning - user can drag it
                return;
            }
            if (isRepositioningToilet) {
                // If clicked another toilet while in repositioning mode, cancel repositioning first
                toggleRepositionToiletMode();
            }
            selectToilet(t.id);
        });

        // ONLY attach drag-and-drop if reposition mode is actively enabled for this toilet
        if (isRepositioningThis) {
            makeMarkerDraggable(marker, t);
        }

        layer.appendChild(marker);
    });
}

function makeMarkerDraggable(marker, toilet) {
    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0;

    marker.classList.add('draggable');

    marker.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // Only left click
        isDragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;
        e.preventDefault();
        e.stopPropagation();

        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const dist = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
            if (dist > 3) hasMoved = true;

            const container = document.getElementById('markers-layer');
            const rect = container.getBoundingClientRect();

            let newX = (moveEvent.clientX - rect.left) / rect.width;
            let newY = (moveEvent.clientY - rect.top) / rect.height;

            newX = Math.round(Math.max(0.02, Math.min(0.98, newX)) * 1000) / 1000;
            newY = Math.round(Math.max(0.02, Math.min(0.98, newY)) * 1000) / 1000;

            marker.style.left = `${newX * 100}%`;
            marker.style.top = `${newY * 100}%`;
            toilet.tempX = newX;
            toilet.tempY = newY;
        };

        const onMouseUp = async (upEvent) => {
            if (!isDragging) return;
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            if (hasMoved && toilet.tempX !== undefined && toilet.tempY !== undefined) {
                toilet.x = toilet.tempX;
                toilet.y = toilet.tempY;
                // Update via API
                try {
                    await apiFetch(`/api/admin/toilets/${toilet.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ x: toilet.x, y: toilet.y })
                    });
                    showToast(`Đã dời ${toilet.name} đến toạ độ mới (X: ${Math.round(toilet.x*100)}%, Y: ${Math.round(toilet.y*100)}%)!`, "OK");
                    if (selectedToiletId === toilet.id) {
                        const coordsEl = document.getElementById('panel-coords');
                        if (coordsEl) coordsEl.innerText = `X: ${Math.round(toilet.x * 100)}%, Y: ${Math.round(toilet.y * 100)}%`;
                        if (currentSelectedToiletData) {
                            currentSelectedToiletData.x = toilet.x;
                            currentSelectedToiletData.y = toilet.y;
                        }
                    }
                } catch (err) {
                    showToast("Lỗi cập nhật toạ độ", "EMPTY");
                } finally {
                    if (isRepositioningToilet) {
                        toggleRepositionToiletMode();
                    }
                }
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ================= TOILET DETAIL PANEL =================
async function selectToilet(toiletId) {
    selectedToiletId = toiletId;

    // Đóng biểu đồ lịch sử của buồng trước đó khi chọn nhà vệ sinh mới
    closeChart();

    // Highlight selected marker
    document.querySelectorAll('.toilet-marker').forEach(m => m.classList.remove('selected'));
    const selM = document.getElementById(`toilet-marker-${toiletId}`);
    if (selM) selM.classList.add('selected');

    try {
        const res = await apiFetch(`/api/toilets/${toiletId}`);
        if (!res.ok) return;
        const data = await res.json();
        renderToiletDetailPanel(data);
    } catch (err) {
        console.error("Error loading toilet detail:", err);
    }
}

function renderToiletDetailPanel(data) {
    currentSelectedToiletData = data;
    document.getElementById('panel-body').style.display = 'block';

    // Đảm bảo đóng biểu đồ lịch sử nếu nhà vệ sinh này không có buồng nào
    const savedDevices = data.devices || [];
    const discoveredDevices = data.discovered_devices || [];
    if (savedDevices.length === 0 && discoveredDevices.length === 0) {
        closeChart();
    }

    document.getElementById('panel-toilet-name').innerText = data.name;
    document.getElementById('panel-toilet-sub').innerText = `${data.terminal_name || ''} • ${data.floor_name || ''}`;
    
    const hasGateway = !!data.gateway_ip;
    const isGwOnline = !!data.gateway_online;
    const hasDevices = (savedDevices.length > 0);
    const isLiveAndInUse = hasGateway && isGwOnline && hasDevices;
    const rawSt = data.status || data.toilet_status || 'OK';
    const validSt = (rawSt && rawSt !== 'undefined') ? rawSt : 'OK';
    const effectiveStatus = isLiveAndInUse ? validSt : 'OFFLINE';

    const statusPill = document.getElementById('panel-toilet-status');
    statusPill.style.display = 'inline-flex';
    statusPill.className = `status-pill ${effectiveStatus}`;
    if (!hasGateway) {
        statusPill.innerText = `● Chưa gán Gateway`;
    } else if (!isGwOnline) {
        statusPill.innerText = `● Mất kết nối`;
    } else if (!hasDevices) {
        statusPill.innerText = `● Chưa có thiết bị`;
    } else {
        statusPill.innerText = `● ${effectiveStatus}`;
    }

    const gwMacEl = document.getElementById('panel-gw-mac');
    if (gwMacEl) gwMacEl.innerText = data.gateway_mac || (data.gateway_ip ? 'Chưa gán MAC' : 'Chưa gán Gateway');
    const gwIpWrapEl = document.getElementById('panel-gw-ip-wrapper');
    if (gwIpWrapEl) {
        gwIpWrapEl.innerText = data.gateway_ip ? `(IP: ${data.gateway_ip})` : '';
    }
    const gwStatusEl = document.getElementById('panel-gw-status');
    const pingBtn = document.getElementById('btn-ping-gw');

    if (data.gateway_mac || data.gateway_ip) {
        if (pingBtn) pingBtn.style.display = 'inline-block';
        if (data.gateway_online) {
            gwStatusEl.innerHTML = `<span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; padding: 1px 6px; border-radius: 9999px; font-weight: 600;">🟢 Online</span>`;
        } else {
            gwStatusEl.innerHTML = `<span style="background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; padding: 1px 6px; border-radius: 9999px; font-weight: 600;">🔴 Mất kết nối</span>`;
        }
    } else {
        if (pingBtn) pingBtn.style.display = 'none';
        gwStatusEl.innerHTML = `<span style="background: #f1f5f9; color: #64748b; border: 1px solid #cbd5e1; padding: 1px 6px; border-radius: 9999px; font-weight: 600;">⚪ Chưa gán</span>`;
    }

    const coordsEl = document.getElementById('panel-coords');
    if (coordsEl) {
        coordsEl.innerText = `X: ${Math.round((data.x || 0) * 100)}%, Y: ${Math.round((data.y || 0) * 100)}%`;
    }

    const isAdmin = (currentUser && currentUser.role === 'admin');
    const paperWrapEl = document.getElementById('panel-toilet-paper-wrap');
    if (paperWrapEl) {
        paperWrapEl.style.display = isAdmin ? 'flex' : 'none';
    }
    const paperNameEl = document.getElementById('panel-toilet-paper-name');
    const paperBadgeEl = document.getElementById('panel-toilet-paper-badge');
    if (paperNameEl) {
        paperNameEl.innerText = data.effective_profile_name || data.paper_profile_name || 'Cấu hình mặc định toàn hệ thống';
    }
    if (paperBadgeEl) {
        if (data.paper_profile_id) {
            paperBadgeEl.innerText = '🏢 Riêng WC';
            paperBadgeEl.style.background = '#e0f2fe';
            paperBadgeEl.style.color = '#0369a1';
            paperBadgeEl.style.border = '1px solid #7dd3fc';
        } else {
            paperBadgeEl.innerText = '⚙️ Mặc định';
            paperBadgeEl.style.background = '#f1f5f9';
            paperBadgeEl.style.color = '#475569';
            paperBadgeEl.style.border = '1px solid #cbd5e1';
        }
    }

    const cabinList = document.getElementById('panel-cabin-list');
    cabinList.innerHTML = '';

    if (savedDevices.length === 0 && discoveredDevices.length === 0) {
        cabinList.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem 0;">Chưa có thiết bị ESP nào kết nối vào Gateway này.</div>';
        return;
    }

    // 1. Render official saved cabins
    if (savedDevices.length > 0) {
        savedDevices.forEach(dev => {
            const card = document.createElement('div');
            card.className = 'cabin-card';

            const lastSeenText = dev.last_seen ? new Date(dev.last_seen).toLocaleTimeString('vi-VN') : 'Chưa có';

            card.innerHTML = `
                <div class="cabin-top">
                    <span class="cabin-name">
                        <span style="background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-right: 4px; font-weight: 700;">#${dev.cabin_order || 1}</span>
                        ${dev.label}
                    </span>
                    <span class="status-pill ${dev.status}" style="font-size: 0.7rem;">${dev.status}</span>
                </div>
                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 2px; display: flex; justify-content: space-between; align-items: baseline;">
                    <span>Mức giấy: <strong>${Math.round(dev.paper_level)}%</strong> ${dev.remaining_thickness_cm !== undefined && dev.remaining_thickness_cm !== null ? `<span style="color: #64748b; font-size: 0.75rem;">(Dày: <strong>${dev.remaining_thickness_cm} cm</strong>)</span>` : ''}</span>
                    ${dev.estimated_uses !== undefined && dev.estimated_uses !== null ? `<span style="font-size: 0.75rem; color: #0284c7; font-weight: 600;">🧻 ~${dev.estimated_uses} lượt</span>` : ''}
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill ${dev.status}" style="width: ${dev.paper_level}%;"></div>
                </div>
                <div class="cabin-meta">
                    <span>Pin: ${Math.round(dev.battery)}%</span>
                    <span>MAC: <code>${dev.mac_address}</code></span>
                    <span>Cập nhật: ${lastSeenText}</span>
                </div>
                ${isAdmin ? `
                <div style="font-size: 0.73rem; color: #475569; margin-top: 4px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">
                    <span>🧻 Cấu hình: <strong>${dev.effective_profile_name || data.effective_profile_name || 'Mặc định'}</strong></span>
                    ${dev.paper_profile_id ? '<span class="badge" style="background:#e0f2fe; color:#0369a1; border:1px solid #7dd3fc; font-size:0.68rem; padding:1px 5px; font-weight:700;">(Riêng Cabin)</span>' : '<span style="color:#64748b; font-size:0.68rem;">(Theo WC)</span>'}
                </div>
                ` : ''}
                <div style="margin-top: 0.5rem; display: flex; justify-content: space-between; align-items: center;">
                    <button class="btn btn-secondary btn-sm" onclick="viewDeviceChart(${dev.id}, '${dev.label}')">📈 Lịch sử</button>
                    ${(currentUser && currentUser.role === 'admin') ? `
                        <div style="display: flex; gap: 0.35rem;">
                            <button class="btn btn-secondary btn-sm" onclick="openEditDeviceModal(${dev.id}, '${dev.mac_address}', '${dev.label}', ${data.gateway_id || 0}, ${dev.cabin_order || 1}, ${dev.paper_profile_id || 'null'})" title="Sửa thông tin cabin">✏️ Sửa</button>
                            <button class="btn btn-danger btn-sm" onclick="handleDeleteDevice(${dev.id})" title="Xoá cabin này">🗑️</button>
                        </div>
                    ` : ''}
                </div>
            `;
            cabinList.appendChild(card);
        });
    } else {
        cabinList.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 4px 0;">Chưa cấu hình cabin chính thức trong CSDL.</div>';
    }

    // 2. Render live discovered clients (active, showing real-time, but NOT saved yet)
    if (discoveredDevices.length > 0) {
        const discSection = document.createElement('div');
        discSection.className = 'discovered-section';
        discSection.innerHTML = `
            <div class="discovered-header">
                <div class="discovered-title">
                    <span>📡 Client mới phát hiện</span>
                </div>
                <span class="badge-live-pulse">
                    <span class="badge-live-dot"></span>${discoveredDevices.length} Trực tiếp (Chưa lưu)
                </span>
            </div>
        `;

        discoveredDevices.forEach(d => {
            const lastSeenText = d.last_seen ? new Date(d.last_seen).toLocaleTimeString('vi-VN') : 'Vừa xong';
            const card = document.createElement('div');
            card.className = 'cabin-card discovered-card';
            card.innerHTML = `
                <div class="cabin-top">
                    <span class="cabin-name" style="color: #b45309; font-weight: 700;">
                        📡 Tín hiệu Client mới
                    </span>
                    <span class="status-pill ${d.status}" style="font-size: 0.7rem;">${d.status}</span>
                </div>
                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 2px; display: flex; justify-content: space-between; align-items: baseline;">
                    <span>Mức giấy: <strong>${Math.round(d.paper_level)}%</strong> ${d.remaining_thickness_cm !== undefined && d.remaining_thickness_cm !== null ? `<span style="color: #64748b; font-size: 0.75rem;">(Dày: <strong>${d.remaining_thickness_cm} cm</strong>)</span>` : ''}</span>
                    ${d.estimated_uses !== undefined && d.estimated_uses !== null ? `<span style="font-size: 0.75rem; color: #0284c7; font-weight: 600;">🧻 ~${d.estimated_uses} lượt</span>` : ''}
                </div>
                ${d.distance !== null && d.distance !== undefined ? `<div style="font-size: 0.7rem; color: #64748b; margin-bottom: 3px;">Khoảng cách cảm biến ToF: <strong>${d.distance} mm</strong></div>` : ''}
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill ${d.status}" style="width: ${d.paper_level}%;"></div>
                </div>
                <div class="cabin-meta">
                    <span>Pin: ${Math.round(d.battery)}%</span>
                    <span>MAC: <code>${d.mac_address}</code></span>
                    <span>Nhận: ${lastSeenText}</span>
                </div>
                <div style="margin-top: 0.5rem; display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                    <span style="font-size: 0.75rem; color: #b45309; font-weight: 600;">
                        ⚡ Đang phát sóng (Chưa lưu)
                    </span>
                    <div style="display: flex; gap: 0.35rem;">
                        <button class="btn btn-primary btn-sm" onclick="quickSaveDiscoveredDevice('${d.mac_address}', ${data.gateway_id || 0}, ${data.id})" title="Thêm client này vào hệ thống và lưu lại">
                            ➕ Thêm vào App (Lưu)
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="handleDeleteDiscoveredClient('${d.mac_address}', ${data.gateway_id || 0}, ${data.id})" title="Xóa bỏ tín hiệu Client mới phát hiện này">
                            🗑️ Xóa
                        </button>
                    </div>
                </div>
            `;
            discSection.appendChild(card);
        });

        cabinList.appendChild(discSection);
    }
}

function updateToiletDetailPanelFromWs(wsData) {
    if (currentSelectedToiletData && currentSelectedToiletData.id === wsData.toilet_id) {
        const newStatus = wsData.status || wsData.toilet_status;
        if (newStatus && newStatus !== 'undefined') {
            currentSelectedToiletData.status = newStatus;
        }
        if (wsData.devices) {
            currentSelectedToiletData.devices = wsData.devices;
        }
        if (wsData.gateway_online !== undefined) {
            currentSelectedToiletData.gateway_online = wsData.gateway_online;
        }
        if (wsData.gateway_ip) {
            currentSelectedToiletData.gateway_ip = wsData.gateway_ip;
        }
        if (wsData.discovered_devices !== undefined) {
            currentSelectedToiletData.discovered_devices = wsData.discovered_devices;
        }
        if (wsData.paper_profile_id !== undefined) {
            currentSelectedToiletData.paper_profile_id = wsData.paper_profile_id;
        }
        if (wsData.paper_profile_name !== undefined) {
            currentSelectedToiletData.paper_profile_name = wsData.paper_profile_name;
        }
        if (wsData.effective_profile_name !== undefined) {
            currentSelectedToiletData.effective_profile_name = wsData.effective_profile_name;
        }
    }
    const finalData = currentSelectedToiletData || wsData;
    if (!finalData.status || finalData.status === 'undefined') {
        finalData.status = wsData.status || wsData.toilet_status || 'OK';
    }
    renderToiletDetailPanel(finalData);
}

function quickSaveDiscoveredDevice(mac, gatewayId, toiletId) {
    if (!currentUser || currentUser.role !== 'admin') {
        showToast("Vui lòng đăng nhập quyền Quản trị viên (Admin) để thêm thiết bị", "LOW");
        openLoginModal();
        return;
    }
    selectedToiletId = toiletId;
    openAddCabinModal();
    const macInput = document.getElementById('add-cabin-mac');
    if (macInput) {
        macInput.value = mac;
        macInput.style.borderColor = '#10b981';
        macInput.style.backgroundColor = '#ecfdf5';
    }
}

async function handleDeleteDiscoveredClient(mac, gatewayId, toiletId) {
    if (!currentUser || currentUser.role !== 'admin') {
        showToast("Vui lòng đăng nhập quyền Quản trị viên (Admin) để xóa client", "LOW");
        openLoginModal();
        return;
    }
    if (!confirm(`Bạn có chắc chắn muốn xóa tín hiệu Client mới phát hiện [${mac}] này không?`)) {
        return;
    }
    try {
        const res = await apiFetch(`/api/gateways/discovered/${encodeURIComponent(mac)}`, {
            method: 'DELETE'
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || err.message || 'Không thể xóa client mới phát hiện', 'danger');
            return;
        }

        showToast(`Đã xóa client mới phát hiện [${mac}]`, 'success');

        const upperMac = mac.toUpperCase();
        if (currentSelectedToiletData && currentSelectedToiletData.discovered_devices) {
            currentSelectedToiletData.discovered_devices = currentSelectedToiletData.discovered_devices.filter(
                d => (d.mac_address || '').toUpperCase() !== upperMac
            );
            renderToiletDetailPanel(currentSelectedToiletData);
        }

        Object.keys(currentDiscoveredMap).forEach(k => {
            if (Array.isArray(currentDiscoveredMap[k])) {
                currentDiscoveredMap[k] = currentDiscoveredMap[k].filter(
                    d => (d.mac_address || '').toUpperCase() !== upperMac
                );
            }
        });

        if (currentAdminGateways) {
            currentAdminGateways.forEach(gw => {
                if (gw.discovered_devices) {
                    gw.discovered_devices = gw.discovered_devices.filter(
                        d => (d.mac_address || '').toUpperCase() !== upperMac
                    );
                }
            });
            renderAdminGatewaysTree();
        }
    } catch (e) {
        showToast('Lỗi khi xóa client: ' + e.message, 'danger');
    }
}

// ================= KIỂM TRA KẾT NỐI GATEWAY =================
async function checkCurrentGatewayConnection() {
    if (!currentSelectedToiletData || !currentSelectedToiletData.gateway_ip) {
        showToast("Nhà vệ sinh này chưa được gán Gateway", "LOW");
        return;
    }

    const gwIp = currentSelectedToiletData.gateway_ip;
    const btn = document.getElementById('btn-ping-gw');
    const originalText = btn ? btn.innerText : "🔍 Kiểm tra kết nối";
    if (btn) {
        btn.innerText = "⏳ Đang kiểm tra...";
        btn.disabled = true;
    }

    try {
        const res = await apiFetch(`/api/admin/gateways/ping?ip=${encodeURIComponent(gwIp)}`);
        const data = await res.json();
        
        if (data.online) {
            showToast(`🟢 Gateway ${gwIp} đang ONLINE! Liên lạc lần cuối: ${data.last_seen_str || 'vừa xong'}`, "OK");
            if (currentSelectedToiletData) {
                currentSelectedToiletData.gateway_online = true;
                if (currentSelectedToiletData.status === 'OFFLINE') {
                    currentSelectedToiletData.status = 'OK';
                }
                if (currentSelectedToiletData.devices) {
                    currentSelectedToiletData.devices.forEach(d => {
                        if (d.status === 'OFFLINE') d.status = 'OK';
                    });
                }
            }
            if (currentFloorToilets && selectedToiletId) {
                const curT = currentFloorToilets.find(x => x.id === selectedToiletId);
                if (curT) {
                    curT.gateway_online = true;
                    if (curT.status === 'OFFLINE') curT.status = 'OK';
                }
            }
        } else {
            showToast(`🔴 Gateway ${gwIp} MẤT KẾT NỐI! ${data.message || 'Không có tín hiệu trong hơn 10 phút'}`, "EMPTY");
            
            // Cập nhật trạng thái ngay lập tức trong bộ nhớ
            if (currentSelectedToiletData) {
                currentSelectedToiletData.gateway_online = false;
                currentSelectedToiletData.status = 'OFFLINE';
                if (currentSelectedToiletData.devices) {
                    currentSelectedToiletData.devices.forEach(d => {
                        d.status = 'OFFLINE';
                    });
                }
            }
            
            // Cập nhật ngay trong currentFloorToilets
            if (currentFloorToilets && selectedToiletId) {
                const curT = currentFloorToilets.find(x => x.id === selectedToiletId);
                if (curT) {
                    curT.status = 'OFFLINE';
                    curT.gateway_online = false;
                }
            }
        }

        // Vẽ lại giao diện Detail Panel ngay lập tức
        if (currentSelectedToiletData) {
            renderToiletDetailPanel(currentSelectedToiletData);
        }

        // Vẽ lại Markers trên canvas bản đồ ngay lập tức
        renderMarkers();

        // Tải lại chi tiết nhà vệ sinh từ server để đồng bộ hoàn toàn
        if (selectedToiletId) {
            await selectToilet(selectedToiletId);
        }
        // Đồng bộ danh sách toilets của tầng hiện tại từ server
        if (currentFloor) {
            const floorRes = await apiFetch(`/api/floors/${currentFloor.id}`);
            if (floorRes.ok) {
                const floorData = await floorRes.json();
                currentFloorToilets = floorData.toilets || [];
                renderMarkers();
            }
        }
    } catch (err) {
        showToast(`Lỗi khi kiểm tra kết nối Gateway: ${err.message}`, "EMPTY");
    } finally {
        if (btn) {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    }
}

// ================= DEVICE HISTORY CHART =================
async function viewDeviceChart(deviceId, deviceLabel) {
    try {
        const res = await apiFetch(`/api/devices/${deviceId}/history`);
        if (!res.ok) return;
        const historyData = await res.json();

        document.getElementById('chart-box').style.display = 'block';
        document.getElementById('chart-device-title').innerText = `Lịch sử mức giấy - ${deviceLabel}`;

        const labels = historyData.map(h => new Date(h.timestamp).toLocaleTimeString('vi-VN'));
        const dataValues = historyData.map(h => h.paper_level);

        const ctx = document.getElementById('history-chart').getContext('2d');
        if (historyChartInstance) {
            historyChartInstance.destroy();
        }

        historyChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Mức giấy (%)',
                    data: dataValues,
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.1)',
                    fill: true,
                    tension: 0.25,
                    pointRadius: 3
                }]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        min: 0,
                        max: 100,
                        ticks: { stepSize: 20 }
                    }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });
    } catch (err) {
        console.error("Error rendering chart:", err);
    }
}

function closeChart() {
    document.getElementById('chart-box').style.display = 'none';
    if (historyChartInstance) {
        historyChartInstance.destroy();
        historyChartInstance = null;
    }
}

// ================= ADMIN: PLACEMENT & MAP CLICK =================
function togglePlacementMode() {
    isPlacementMode = !isPlacementMode;
    const btn = document.getElementById('btn-toggle-placement');
    const hint = document.getElementById('placement-hint');

    if (isPlacementMode) {
        btn.className = 'btn btn-primary btn-sm';
        btn.innerText = '❌ Thoát chế độ đặt Toilet';
        hint.style.display = 'inline';
    } else {
        btn.className = 'btn btn-secondary btn-sm';
        btn.innerText = '➕ Chế độ đặt Toilet trên Map';
        hint.style.display = 'none';
    }
}

function handleMapClick(event) {
    const container = document.getElementById('markers-layer');
    const rect = container.getBoundingClientRect();

    let x = (event.clientX - rect.left) / rect.width;
    let y = (event.clientY - rect.top) / rect.height;

    x = Math.round(x * 1000) / 1000;
    y = Math.round(y * 1000) / 1000;

    // Repositioning mode for currently selected toilet
    if (isRepositioningToilet && selectedToiletId) {
        handleRepositionToiletClick(x, y);
        return;
    }

    if (!isPlacementMode) return;

    pendingPlacementCoords = { x, y };
    document.getElementById('new-toilet-coords').innerText = `${x}, ${y}`;
    document.getElementById('new-toilet-name').value = '';
    const macInput = document.getElementById('new-toilet-gw-mac');
    const ipInput = document.getElementById('new-toilet-gw-ip');
    if (assignedGatewayMacForPlacement || assignedGatewayIpForPlacement) {
        if (macInput) macInput.value = assignedGatewayMacForPlacement || '';
        if (ipInput) ipInput.value = assignedGatewayIpForPlacement || '';
    } else {
        if (macInput) macInput.value = '';
        if (ipInput) ipInput.value = '';
    }
    populateGatewayDropdown('new-toilet-gw-select', assignedGatewayMacForPlacement || assignedGatewayIpForPlacement);
    document.getElementById('modal-add-toilet').style.display = 'flex';
}

function closeAddToiletModal() {
    document.getElementById('modal-add-toilet').style.display = 'none';
}

async function handleAddToiletSubmit(e) {
    e.preventDefault();
    if (!currentFloor || !pendingPlacementCoords) return;

    const name = document.getElementById('new-toilet-name').value.trim();
    const gwMac = (document.getElementById('new-toilet-gw-mac')?.value || '').trim();
    const gwIp = (document.getElementById('new-toilet-gw-ip')?.value || '').trim();

    try {
        const res = await apiFetch('/api/admin/toilets', {
            method: 'POST',
            body: JSON.stringify({
                floor_id: currentFloor.id,
                name: name,
                x: pendingPlacementCoords.x,
                y: pendingPlacementCoords.y,
                gateway_mac: gwMac || null,
                gateway_ip: gwIp || null
            })
        });

        if (!res.ok) {
            const err = await res.json();
            alert(err.detail || "Không thể tạo nhà vệ sinh");
            return;
        }

        closeAddToiletModal();
        togglePlacementMode();
        assignedGatewayMacForPlacement = null;
        assignedGatewayIpForPlacement = null;
        showToast("Đã thêm nhà vệ sinh mới!", "OK");
        await onFloorChanged();
    } catch (err) {
        alert("Lỗi kết nối: " + err.message);
    }
}

// ================= REPOSITION & EDIT TOILET =================
function toggleRepositionToiletMode() {
    if (!selectedToiletId) {
        showToast("Vui lòng chọn một nhà vệ sinh trên bản đồ trước", "LOW");
        return;
    }
    isRepositioningToilet = !isRepositioningToilet;
    const btn = document.getElementById('btn-reposition-toilet');
    const hint = document.getElementById('reposition-hint');
    const layer = document.getElementById('markers-layer');

    if (isRepositioningToilet) {
        if (isPlacementMode) togglePlacementMode(); // Turn off placement mode if active
        if (btn) {
            btn.className = 'btn btn-primary btn-sm';
            btn.innerText = '❌ Hủy dời vị trí';
        }
        if (hint) hint.style.display = 'inline';
        if (layer) layer.style.cursor = 'crosshair';
        showToast("👉 Kéo thả marker màu xanh nổi bật hoặc click vào vị trí mới trên bản đồ", "LOW");
    } else {
        if (btn) {
            btn.className = 'btn btn-secondary btn-sm';
            btn.innerText = '🎯 Dời vị trí';
        }
        if (hint) hint.style.display = 'none';
        if (layer) layer.style.cursor = 'default';
    }
    renderMarkers();
}

async function handleRepositionToiletClick(newX, newY) {
    if (!selectedToiletId) return;
    try {
        const res = await apiFetch(`/api/admin/toilets/${selectedToiletId}`, {
            method: 'PUT',
            body: JSON.stringify({ x: newX, y: newY })
        });
        if (res.ok) {
            const updated = await res.json();
            showToast(`Đã dời ${updated.name} đến vị trí mới (X: ${Math.round(newX*100)}%, Y: ${Math.round(newY*100)}%)!`, "OK");
            toggleRepositionToiletMode();
            await onFloorChanged();
            selectToilet(selectedToiletId);
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể dời vị trí toilet");
        }
    } catch (err) {
        alert("Lỗi kết nối");
    }
}

function openEditCurrentToiletModal() {
    if (!selectedToiletId || !currentSelectedToiletData) {
        showToast("Chưa chọn nhà vệ sinh", "LOW");
        return;
    }
    const gwMac = currentSelectedToiletData.gateway_mac || '';
    const gwIp = currentSelectedToiletData.gateway_ip || '';
    document.getElementById('edit-toilet-id').value = currentSelectedToiletData.id;
    document.getElementById('edit-toilet-floor-id').value = currentFloor ? currentFloor.id : '';
    document.getElementById('edit-toilet-terminal-id').value = currentFloor ? currentFloor.terminal_id : '';
    document.getElementById('edit-toilet-name').value = currentSelectedToiletData.name;
    const macInput = document.getElementById('edit-toilet-gw-mac');
    const ipInput = document.getElementById('edit-toilet-gw-ip');
    if (macInput) macInput.value = gwMac;
    if (ipInput) ipInput.value = gwIp;
    document.getElementById('edit-toilet-x').value = currentSelectedToiletData.x;
    document.getElementById('edit-toilet-y').value = currentSelectedToiletData.y;
    populateGatewayDropdown('edit-toilet-gw-select', gwMac || gwIp);
    document.getElementById('modal-edit-toilet').style.display = 'flex';
    
    // Check and show live discovered clients for this Gateway MAC/IP
    checkDiscoveredClientsForModal(gwMac || gwIp);
}

let cachedAdminGateways = [];
async function fetchAdminGatewaysList() {
    try {
        const res = await apiFetch('/api/admin/gateways');
        if (res.ok) {
            cachedAdminGateways = await res.json();
            return cachedAdminGateways;
        }
    } catch (e) {}
    return [];
}

async function populateGatewayDropdown(selectId, selectedVal) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const gateways = await fetchAdminGatewaysList();
    sel.innerHTML = '<option value="">[Không gán Gateway / Tự nhập thủ công]</option>';
    gateways.forEach(gw => {
        const opt = document.createElement('option');
        opt.value = gw.mac_address || gw.ip_address || '';
        opt.dataset.mac = gw.mac_address || '';
        opt.dataset.ip = gw.ip_address || '';
        const st = gw.is_online ? '🟢 Online' : '⚪ Offline';
        const toiletInfo = gw.toilet_name ? ` ➔ ${gw.toilet_name}` : ' (Chưa gán WC)';
        opt.innerText = `${st} | MAC: ${gw.mac_address || 'Chưa có'} | IP: ${gw.ip_address || '---'}${toiletInfo}`;
        if (selectedVal && (gw.mac_address === selectedVal || gw.ip_address === selectedVal)) {
            opt.selected = true;
        }
        sel.appendChild(opt);
    });
}

function onNewToiletGwSelectChange(val) {
    const sel = document.getElementById('new-toilet-gw-select');
    const selectedOpt = sel ? sel.options[sel.selectedIndex] : null;
    const macInput = document.getElementById('new-toilet-gw-mac');
    const ipInput = document.getElementById('new-toilet-gw-ip');
    if (selectedOpt && selectedOpt.dataset && selectedOpt.value) {
        if (macInput) macInput.value = selectedOpt.dataset.mac || '';
        if (ipInput) ipInput.value = selectedOpt.dataset.ip || '';
    } else {
        if (macInput) macInput.value = '';
        if (ipInput) ipInput.value = '';
    }
}

function onEditToiletGwSelectChange(val) {
    const sel = document.getElementById('edit-toilet-gw-select');
    const selectedOpt = sel ? sel.options[sel.selectedIndex] : null;
    const macInput = document.getElementById('edit-toilet-gw-mac');
    const ipInput = document.getElementById('edit-toilet-gw-ip');
    if (selectedOpt && selectedOpt.dataset && selectedOpt.value) {
        const mac = selectedOpt.dataset.mac || '';
        const ip = selectedOpt.dataset.ip || '';
        if (macInput) macInput.value = mac;
        if (ipInput) ipInput.value = ip;
        checkDiscoveredClientsForModal(mac || ip);
    } else {
        if (macInput) macInput.value = '';
        if (ipInput) ipInput.value = '';
        checkDiscoveredClientsForModal('');
    }
}

async function checkDiscoveredClientsForModal(identifier) {
    const preview = document.getElementById('edit-toilet-discovered-preview');
    if (!preview) return;
    const cleanId = (identifier || '').trim();
    if (!cleanId) {
        preview.style.display = 'none';
        return;
    }
    try {
        const res = await apiFetch(`/api/gateways/discovered?ip=${encodeURIComponent(cleanId)}`);
        if (!res.ok) {
            preview.style.display = 'none';
            return;
        }
        const clients = await res.json();
        if (clients && clients.length > 0) {
            preview.style.display = 'block';
            preview.style.color = '#065f46';
            preview.style.backgroundColor = '#ecfdf5';
            preview.style.border = '1px solid #a7f3d0';
            preview.style.padding = '8px 12px';
            preview.style.borderRadius = '6px';
            preview.innerHTML = `
                <div style="font-weight: 600; margin-bottom: 4px;">📡 Đã phát hiện ${clients.length} Client đang phát sóng tới Gateway này:</div>
                ${clients.map(c => `
                    <div style="font-size: 0.775rem; margin-top: 2px;">
                        • MAC: <code>${c.mac_address}</code> | Giấy: <strong>${Math.round(c.paper_level)}%</strong> ${c.distance !== null && c.distance !== undefined ? `(${c.distance} mm)` : ''} | Pin: <strong>${Math.round(c.battery)}%</strong>
                    </div>
                `).join('')}
                <div style="font-size: 0.725rem; color: #047857; margin-top: 4px; font-style: italic;">
                    👉 Sau khi Lưu gán Gateway, các Client này sẽ tự động hiển thị trên bảng điều khiển mà không cần cấu hình thủ công!
                </div>
            `;
        } else {
            preview.style.display = 'block';
            preview.style.color = '#475569';
            preview.style.backgroundColor = '#f8fafc';
            preview.style.border = '1px solid #e2e8f0';
            preview.style.padding = '6px 10px';
            preview.style.borderRadius = '6px';
            preview.innerHTML = `ℹ️ <em>Chưa có Client nào gửi tín hiệu tới Gateway này (sẽ tự động hiển thị ngay khi Client bắt đầu phát sóng).</em>`;
        }
    } catch (e) {
        preview.style.display = 'none';
    }
}

function closeEditToiletModal() {
    document.getElementById('modal-edit-toilet').style.display = 'none';
}

async function handleEditToiletSubmit(e) {
    e.preventDefault();
    const id = parseInt(document.getElementById('edit-toilet-id').value);
    const name = document.getElementById('edit-toilet-name').value.trim();
    const gwMac = (document.getElementById('edit-toilet-gw-mac')?.value || '').trim();
    const gwIp = (document.getElementById('edit-toilet-gw-ip')?.value || '').trim();
    const x = parseFloat(document.getElementById('edit-toilet-x').value);
    const y = parseFloat(document.getElementById('edit-toilet-y').value);

    try {
        const paperProfileId = parseInt(document.getElementById('edit-toilet-paper-profile')?.value) || null;
        const res = await apiFetch(`/api/admin/toilets/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
                name: name,
                gateway_mac: gwMac || null,
                gateway_ip: gwIp || null,
                x: x,
                y: y,
                paper_profile_id: paperProfileId
            })
        });

        if (!res.ok) {
            const err = await res.json();
            alert(err.detail || "Không thể cập nhật nhà vệ sinh");
            return;
        }

        closeEditToiletModal();
        showToast("Đã cập nhật thông tin nhà vệ sinh thành công!", "OK");
        if (currentFloor) await onFloorChanged();
        if (selectedToiletId) selectToilet(id);
        if (document.getElementById('view-summary').style.display !== 'none') {
            await loadSummaryData();
        }
    } catch (err) {
        alert("Lỗi kết nối khi cập nhật: " + err.message);
    }
}

function openEditToiletModalById(id, name, gwIp, x, y, floorId, terminalId, gwMac) {
    if (!currentUser || currentUser.role !== 'admin') {
        showToast("Vui lòng đăng nhập quyền Quản trị viên (Admin) để sửa nhà vệ sinh", "LOW");
        openLoginModal();
        return;
    }
    const cleanGwIp = (gwIp && gwIp !== 'None' && gwIp !== 'Chưa gán') ? gwIp : '';
    const cleanGwMac = (gwMac && gwMac !== 'None' && gwMac !== 'Chưa gán') ? gwMac : '';
    document.getElementById('edit-toilet-id').value = id;
    document.getElementById('edit-toilet-floor-id').value = floorId || (currentFloor ? currentFloor.id : '');
    document.getElementById('edit-toilet-terminal-id').value = terminalId || (currentFloor ? currentFloor.terminal_id : '');
    document.getElementById('edit-toilet-name').value = name || '';
    const macInput = document.getElementById('edit-toilet-gw-mac');
    const ipInput = document.getElementById('edit-toilet-gw-ip');
    if (macInput) macInput.value = cleanGwMac;
    if (ipInput) ipInput.value = cleanGwIp;
    document.getElementById('edit-toilet-x').value = (x !== undefined && x !== null) ? x : 0.5;
    document.getElementById('edit-toilet-y').value = (y !== undefined && y !== null) ? y : 0.5;
    populateGatewayDropdown('edit-toilet-gw-select', cleanGwMac || cleanGwIp);
    const tData = (currentFloorToilets || []).find(t => t.id === id) || (currentSelectedToiletData && currentSelectedToiletData.id === id ? currentSelectedToiletData : null);
    const toiletProfileSelect = document.getElementById('edit-toilet-paper-profile');
    if (toiletProfileSelect) {
        toiletProfileSelect.value = (tData && tData.paper_profile_id) ? tData.paper_profile_id : '';
    }
    document.getElementById('modal-edit-toilet').style.display = 'flex';
    checkDiscoveredClientsForModal(cleanGwMac || cleanGwIp);
}

function handleRepositionFromEditModal() {
    const toiletId = parseInt(document.getElementById('edit-toilet-id').value);
    const floorId = parseInt(document.getElementById('edit-toilet-floor-id').value);
    const termId = parseInt(document.getElementById('edit-toilet-terminal-id').value);
    closeEditToiletModal();

    if (termId && floorId && toiletId) {
        jumpToMapToilet(termId, floorId, toiletId, true);
    } else if (toiletId) {
        switchView('dashboard');
        setTimeout(() => {
            selectToilet(toiletId);
            setTimeout(() => {
                if (!isRepositioningToilet) {
                    toggleRepositionToiletMode();
                }
            }, 300);
        }, 200);
    } else {
        switchView('dashboard');
    }
}

async function handleDeleteToiletById(toiletId, toiletName) {
    if (!currentUser || currentUser.role !== 'admin') {
        showToast("Vui lòng đăng nhập quyền Quản trị viên (Admin) để xoá nhà vệ sinh", "LOW");
        openLoginModal();
        return;
    }
    if (!confirm(`Bạn có chắc chắn muốn xoá nhà vệ sinh "${toiletName}"? Các liên kết với Gateway và thiết bị sẽ bị huỷ.`)) {
        return;
    }

    try {
        const res = await apiFetch(`/api/admin/toilets/${toiletId}`, { method: 'DELETE' });
        if (res.ok) {
            showToast(`Đã xoá nhà vệ sinh "${toiletName}"`, "OK");
            if (selectedToiletId === toiletId) {
                document.getElementById('panel-body').style.display = 'none';
                selectedToiletId = null;
                currentSelectedToiletData = null;
            }
            if (document.getElementById('view-summary').style.display !== 'none') {
                await loadSummaryData();
            }
            if (currentFloor) await onFloorChanged();
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể xoá nhà vệ sinh");
        }
    } catch (err) {
        showToast(`Lỗi khi xoá: ${err.message}`, "EMPTY");
    }
}

async function handleDeleteCurrentToilet() {
    if (!selectedToiletId) return;
    if (!confirm("Bạn có chắc chắn muốn xoá nhà vệ sinh này? Các liên kết với Gateway và thiết bị sẽ bị huỷ.")) {
        return;
    }

    try {
        const res = await apiFetch(`/api/admin/toilets/${selectedToiletId}`, { method: 'DELETE' });
        if (res.ok) {
            showToast("Đã xoá nhà vệ sinh", "OK");
            document.getElementById('panel-body').style.display = 'none';
            selectedToiletId = null;
            currentSelectedToiletData = null;
            await onFloorChanged();
            if (document.getElementById('view-summary').style.display !== 'none') {
                await loadSummaryData();
            }
        }
    } catch (err) {
        showToast("Lỗi xoá nhà vệ sinh", "EMPTY");
    }
}

// ================= VIEW 2: SUMMARY TABLE =================
async function loadSummaryData() {
    const termId = document.getElementById('sum-filter-terminal').value;
    const status = document.getElementById('sum-filter-status').value;

    let url = `/api/summary?`;
    if (termId) url += `terminal_id=${termId}&`;
    if (status) url += `status_filter=${status}&`;

    try {
        const res = await apiFetch(url);
        if (!res.ok) return;
        const data = await res.json();
        
        const tbody = document.getElementById('summary-table-body');
        tbody.innerHTML = '';

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">Không có dữ liệu phù hợp</td></tr>';
            return;
        }

        data.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${item.terminal_name}</strong></td>
                <td>${item.floor_name}</td>
                <td><strong>${item.name}</strong></td>
                <td><code>${item.gateway_ip}</code></td>
                <td>${item.device_count} cabin</td>
                <td><strong>${Math.round(item.min_paper)}%</strong></td>
                <td><span class="status-pill ${item.status}">● ${item.status}</span></td>
                <td>${item.unack_alerts_count > 0 ? `<span class="badge-alert">${item.unack_alerts_count} cảnh báo</span>` : '0'}</td>
                <td>
                    <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
                        <button class="btn btn-secondary btn-sm" onclick="jumpToMapToilet(${item.terminal_id}, ${item.floor_id}, ${item.id})" title="Xem trên bản đồ">
                            🗺️ Xem
                        </button>
                        ${(currentUser && currentUser.role === 'admin') ? `
                            <button class="btn btn-secondary btn-sm" onclick="openEditToiletModalById(${item.id}, '${item.name.replace(/'/g, "\\'")}', '${item.gateway_ip === 'Chưa gán' ? '' : item.gateway_ip}', ${item.x !== undefined ? item.x : 0.5}, ${item.y !== undefined ? item.y : 0.5}, ${item.floor_id}, ${item.terminal_id}, '${item.gateway_mac || ''}')" title="Sửa thông tin">
                                ✏️ Sửa
                            </button>
                            <button class="btn btn-danger btn-sm" onclick="handleDeleteToiletById(${item.id}, '${item.name.replace(/'/g, "\\'")}')" title="Xoá nhà vệ sinh">
                                🗑️ Xoá
                            </button>
                        ` : ''}
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error("Error loading summary:", err);
    }
}

function jumpToMapToilet(termId, floorId, toiletId, autoReposition = false) {
    switchView('dashboard');
    document.getElementById('sel-terminal').value = termId;
    onTerminalChanged();
    setTimeout(() => {
        document.getElementById('sel-floor').value = floorId;
        onFloorChanged().then(() => {
            setTimeout(() => {
                selectToilet(toiletId);
                if (autoReposition) {
                    setTimeout(() => {
                        if (!isRepositioningToilet) {
                            toggleRepositionToiletMode();
                        }
                    }, 350);
                }
            }, 400);
        });
    }, 200);
}

// ================= VIEW 3: ALERTS =================
async function updateUnackAlertsCount() {
    try {
        const res = await apiFetch('/api/alerts?unack_only=true');
        if (!res.ok) return;
        const alerts = await res.json();
        const badge = document.getElementById('unack-alerts-badge');
        if (alerts.length > 0) {
            badge.innerText = alerts.length;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    } catch (err) {}
}

async function loadAlertsData() {
    const unackOnly = document.getElementById('alerts-filter').value === 'true';
    try {
        const res = await apiFetch(`/api/alerts?unack_only=${unackOnly}`);
        if (!res.ok) return;
        const alerts = await res.json();

        const tbody = document.getElementById('alerts-table-body');
        tbody.innerHTML = '';

        if (alerts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Không có cảnh báo nào!</td></tr>';
            return;
        }

        alerts.forEach(al => {
            const tr = document.createElement('tr');
            const isAck = !!al.acknowledged_at;
            const timeStr = new Date(al.created_at).toLocaleString('vi-VN');

            tr.innerHTML = `
                <td>#${al.id}</td>
                <td><span class="status-pill ${al.type === 'LOW_PAPER' ? 'LOW' : al.type}">● ${al.type}</span></td>
                <td><strong>${al.device_label}</strong></td>
                <td>${al.toilet_name}</td>
                <td>${al.terminal_name} - ${al.floor_name}</td>
                <td>${timeStr}</td>
                <td>${isAck ? `<span style="color: #15803d;">Đã xác nhận bởi <strong>${al.acknowledged_by}</strong></span>` : '<span style="color: #dc2626; font-weight: 600;">Chưa xác nhận</span>'}</td>
                <td>
                    ${!isAck ? `<button class="btn btn-success btn-sm" onclick="handleAcknowledgeAlert(${al.id})">✔ Xác nhận</button>` : '—'}
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error("Error loading alerts:", err);
    }
}

async function handleAcknowledgeAlert(alertId) {
    try {
        const res = await apiFetch(`/api/alerts/${alertId}/acknowledge`, { method: 'POST' });
        if (res.ok) {
            showToast("Đã xác nhận cảnh báo thành công!", "OK");
            loadAlertsData();
            updateUnackAlertsCount();
        }
    } catch (err) {
        showToast("Lỗi xác nhận cảnh báo", "EMPTY");
    }
}

// ================= EMERGENCY ALERT POPUP & ACK ALL =================
function playAlertSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const now = ctx.currentTime;

        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'triangle';
        osc1.frequency.setValueAtTime(880, now);
        gain1.gain.setValueAtTime(0.25, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.22);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(1174.66, now + 0.26);
        gain2.gain.setValueAtTime(0.25, now + 0.26);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + 0.26);
        osc2.stop(now + 0.5);
    } catch (e) {
        // AudioContext autoplay policy
    }
}

async function fetchAndShowAlertPopup() {
    try {
        const res = await apiFetch('/api/alerts?unack_only=true');
        if (!res.ok) return;
        const alerts = await res.json();
        if (alerts && alerts.length > 0) {
            renderAlertPopupCards(alerts);
            playAlertSound();
            document.getElementById('modal-alert-popup').style.display = 'flex';
        }
    } catch (err) {
        console.error("Error fetching alerts for popup:", err);
    }
}

function renderAlertPopupCards(alerts) {
    const listEl = document.getElementById('alert-popup-list');
    const subtitleEl = document.getElementById('alert-popup-subtitle');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (subtitleEl) {
        subtitleEl.innerText = `Có ${alerts.length} sự cố chưa xử lý cần kiểm tra khẩn cấp`;
    }

    alerts.slice(0, 15).forEach(al => {
        const card = document.createElement('div');
        const alertType = al.type === 'LOW_PAPER' ? 'LOW' : al.type;
        card.className = `alert-item-card ${alertType}`;
        const timeStr = new Date(al.created_at).toLocaleTimeString('vi-VN');

        const typeLabels = {
            'EMPTY': 'HẾT GIẤY (≤10%)',
            'LOW': 'SẮP HẾT (10-30%)',
            'LOW_PAPER': 'SẮP HẾT (10-30%)',
            'OFFLINE': 'MẤT TÍN HIỆU'
        };
        const labelText = typeLabels[al.type] || al.type;

        card.innerHTML = `
            <div class="alert-item-top">
                <span class="status-pill ${alertType}" style="font-size: 0.72rem; padding: 1px 7px;">● ${labelText}</span>
                <span style="font-size: 0.75rem; color: var(--text-muted);">${timeStr}</span>
            </div>
            <div class="alert-item-title">${al.toilet_name} — <strong>${al.device_label}</strong></div>
            <div class="alert-item-meta">${al.terminal_name} • ${al.floor_name}</div>
        `;
        listEl.appendChild(card);
    });

    if (alerts.length > 15) {
        const moreNote = document.createElement('div');
        moreNote.style.cssText = 'text-align: center; font-size: 0.8rem; color: var(--text-secondary); padding: 4px;';
        moreNote.innerText = `+ và ${alerts.length - 15} cảnh báo khác...`;
        listEl.appendChild(moreNote);
    }
}

function closeAlertPopup() {
    const modal = document.getElementById('modal-alert-popup');
    if (modal) modal.style.display = 'none';
}

function switchViewFromPopup(viewName) {
    closeAlertPopup();
    switchView(viewName);
}

async function handleAcknowledgeAllAlerts(fromPopup = false) {
    try {
        const res = await apiFetch('/api/alerts/acknowledge-all', { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            showToast(data.message || "Đã xác nhận nhanh tất cả cảnh báo thành công!", "OK");
            closeAlertPopup();
            updateUnackAlertsCount();
            if (document.getElementById('view-alerts').style.display !== 'none') {
                loadAlertsData();
            }
            if (document.getElementById('view-summary').style.display !== 'none') {
                loadSummaryData();
            }
        } else {
            const err = await res.json();
            showToast(err.detail || "Không thể xác nhận cảnh báo", "EMPTY");
        }
    } catch (err) {
        showToast("Lỗi kết nối máy chủ", "EMPTY");
    }
}

// ================= VIEW 4: ADMIN TABS & MANAGEMENT =================
function switchAdminTab(tabName) {
    const tabs = ['users', 'terminals', 'gateways', 'paper'];
    tabs.forEach(t => {
        const el = document.getElementById(`admin-tab-${t}`);
        if (el) el.style.display = (t === tabName) ? 'block' : 'none';
    });

    const btns = document.querySelectorAll('#view-admin .tab-btn');
    const idxMap = { 'users': 0, 'terminals': 1, 'gateways': 2, 'paper': 3 };
    btns.forEach((b, i) => {
        b.className = (i === idxMap[tabName]) ? 'tab-btn active' : 'tab-btn';
    });

    if (tabName === 'paper') {
        loadAdminPaperSettings();
    } else if (tabName === 'gateways') {
        loadAdminGateways();
        loadAdminDevices();
    } else if (tabName === 'users') {
        loadAdminUsers();
    } else if (tabName === 'terminals') {
        loadAdminTerminals();
    }
}

// ================= MULTI-PROFILE PAPER ROLL SETTINGS & HIERARCHICAL ASSIGNMENT =================
let currentPaperProfiles = [];
let currentSelectedPaperProfileId = null;
let paperAssignmentsData = [];

async function loadAdminPaperSettings() {
    try {
        const res = await apiFetch('/api/admin/paper/profiles');
        if (!res.ok) return;
        currentPaperProfiles = await res.json();

        // Populate paper profile selector
        const selectEl = document.getElementById('paper-profile-select');
        const copyFromSelect = document.getElementById('new-profile-copy-from');
        const toiletModalSelect = document.getElementById('edit-toilet-paper-profile');
        const devModalSelect = document.getElementById('form-device-paper-profile');
        const addCabinSelect = document.getElementById('add-cabin-paper-profile');

        if (selectEl) selectEl.innerHTML = '';
        if (copyFromSelect) copyFromSelect.innerHTML = '';
        if (toiletModalSelect) toiletModalSelect.innerHTML = '<option value="">[Sử dụng Cấu hình mặc định toàn hệ thống]</option>';
        if (devModalSelect) devModalSelect.innerHTML = '<option value="">[Kế thừa theo WC / Mặc định hệ thống]</option>';
        if (addCabinSelect) addCabinSelect.innerHTML = '<option value="">[Kế thừa theo WC / Mặc định hệ thống]</option>';

        let defaultProfile = null;
        currentPaperProfiles.forEach(p => {
            if (p.is_default) defaultProfile = p;

            if (selectEl) {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.innerText = `${p.name} ${p.is_default ? '★ (Mặc định)' : ''} [${p.assigned_toilets_count} WC, ${p.assigned_devices_count} Cabin]`;
                selectEl.appendChild(opt);
            }
            if (copyFromSelect) {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.innerText = p.name;
                copyFromSelect.appendChild(opt);
            }
            if (toiletModalSelect) {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.innerText = `${p.name} ${p.is_default ? '(Mặc định)' : ''}`;
                toiletModalSelect.appendChild(opt);
            }
            if (devModalSelect) {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.innerText = `${p.name} ${p.is_default ? '(Mặc định)' : ''}`;
                devModalSelect.appendChild(opt);
            }
            if (addCabinSelect) {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.innerText = `${p.name} ${p.is_default ? '(Mặc định)' : ''}`;
                addCabinSelect.appendChild(opt);
            }
        });

        // Determine which profile is currently selected
        if (!currentSelectedPaperProfileId || !currentPaperProfiles.some(p => p.id === currentSelectedPaperProfileId)) {
            currentSelectedPaperProfileId = defaultProfile ? defaultProfile.id : (currentPaperProfiles[0] ? currentPaperProfiles[0].id : null);
        }

        if (selectEl && currentSelectedPaperProfileId) {
            selectEl.value = currentSelectedPaperProfileId;
        }

        displaySelectedProfileData();
        loadPaperAssignments();
    } catch (e) {
        console.error("Error loading paper profiles:", e);
    }
}

function displaySelectedProfileData() {
    const prof = currentPaperProfiles.find(p => p.id === currentSelectedPaperProfileId);
    if (!prof) return;

    if (document.getElementById('setting-profile-name')) {
        document.getElementById('setting-profile-name').value = prof.name || '';
    }
    if (document.getElementById('setting-empty-dist')) {
        document.getElementById('setting-empty-dist').value = prof.empty_distance_mm || 160;
    }
    if (document.getElementById('setting-roll-thick')) {
        document.getElementById('setting-roll-thick').value = prof.roll_thickness_mm || 110;
    }
    if (document.getElementById('setting-sensor-offset')) {
        document.getElementById('setting-sensor-offset').value = prof.sensor_offset_mm || 0;
    }
    if (document.getElementById('setting-warn-low')) {
        document.getElementById('setting-warn-low').value = prof.warn_low_cm || 1.5;
    }
    if (document.getElementById('setting-warn-low-uses')) {
        document.getElementById('setting-warn-low-uses').value = prof.warn_low_uses || 60;
    }
    if (document.getElementById('setting-warn-mid')) {
        document.getElementById('setting-warn-mid').value = prof.warn_mid_cm || 1.0;
    }
    if (document.getElementById('setting-warn-mid-uses')) {
        document.getElementById('setting-warn-mid-uses').value = prof.warn_mid_uses || 35;
    }
    if (document.getElementById('setting-warn-empty')) {
        document.getElementById('setting-warn-empty').value = prof.warn_empty_cm || 0.5;
    }
    if (document.getElementById('setting-warn-empty-uses')) {
        document.getElementById('setting-warn-empty-uses').value = prof.warn_empty_uses || 15;
    }

    const defaultBadge = document.getElementById('badge-profile-is-default');
    if (defaultBadge) {
        defaultBadge.style.display = prof.is_default ? 'inline-flex' : 'none';
    }
    const btnSetDefault = document.getElementById('btn-set-default-profile');
    if (btnSetDefault) {
        btnSetDefault.style.display = prof.is_default ? 'none' : 'inline-block';
    }
    const btnDelete = document.getElementById('btn-delete-profile');
    if (btnDelete) {
        btnDelete.disabled = prof.is_default;
        btnDelete.title = prof.is_default ? 'Không thể xóa cấu hình mặc định' : 'Xóa cấu hình này';
    }

    updatePaperPreviewTable();
}

function onPaperProfileSelectChange() {
    const selectEl = document.getElementById('paper-profile-select');
    if (!selectEl) return;
    currentSelectedPaperProfileId = parseInt(selectEl.value);
    displaySelectedProfileData();
}

async function handleSavePaperSettings(e) {
    e.preventDefault();
    if (!currentSelectedPaperProfileId) return;

    const name = document.getElementById('setting-profile-name').value.trim();
    const emptyDist = parseFloat(document.getElementById('setting-empty-dist').value);
    const rollThick = parseFloat(document.getElementById('setting-roll-thick').value);
    const sensorOffset = parseFloat(document.getElementById('setting-sensor-offset').value) || 0;
    const warnLow = parseFloat(document.getElementById('setting-warn-low').value);
    const warnLowUses = parseInt(document.getElementById('setting-warn-low-uses').value);
    const warnMid = parseFloat(document.getElementById('setting-warn-mid').value);
    const warnMidUses = parseInt(document.getElementById('setting-warn-mid-uses').value);
    const warnEmpty = parseFloat(document.getElementById('setting-warn-empty').value);
    const warnEmptyUses = parseInt(document.getElementById('setting-warn-empty-uses').value);

    try {
        const res = await apiFetch(`/api/admin/paper/profiles/${currentSelectedPaperProfileId}`, {
            method: 'PUT',
            body: JSON.stringify({
                name: name,
                empty_distance_mm: emptyDist,
                roll_thickness_mm: rollThick,
                sensor_offset_mm: sensorOffset,
                warn_low_cm: warnLow,
                warn_low_uses: warnLowUses,
                warn_mid_cm: warnMid,
                warn_mid_uses: warnMidUses,
                warn_empty_cm: warnEmpty,
                warn_empty_uses: warnEmptyUses
            })
        });

        if (res.ok) {
            showToast(`Đã lưu cấu hình [${name}] thành công!`, "OK");
            await loadAdminPaperSettings();
            // Refresh map markers and detail panel immediately
            if (currentFloor) {
                const flRes = await apiFetch(`/api/floors/${currentFloor.id}`);
                if (flRes.ok) {
                    const flData = await flRes.json();
                    currentFloorToilets = flData.toilets || [];
                    renderMarkers();
                }
            }
            if (selectedToiletId) {
                selectToilet(selectedToiletId);
            }
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể lưu cấu hình");
        }
    } catch (err) {
        alert("Lỗi khi lưu cấu hình: " + err.message);
    }
}

function openCreatePaperProfileModal() {
    document.getElementById('new-profile-name').value = '';
    document.getElementById('new-profile-is-default').checked = false;
    document.getElementById('modal-create-paper-profile').style.display = 'flex';
}

function closeCreatePaperProfileModal() {
    document.getElementById('modal-create-paper-profile').style.display = 'none';
}

async function handleCreatePaperProfileSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('new-profile-name').value.trim();
    const copyFromId = parseInt(document.getElementById('new-profile-copy-from').value);
    const isDefault = document.getElementById('new-profile-is-default').checked;

    const sourceProfile = currentPaperProfiles.find(p => p.id === copyFromId) || {};

    try {
        const res = await apiFetch('/api/admin/paper/profiles', {
            method: 'POST',
            body: JSON.stringify({
                name: name,
                is_default: isDefault,
                empty_distance_mm: sourceProfile.empty_distance_mm || 160,
                roll_thickness_mm: sourceProfile.roll_thickness_mm || 110,
                sensor_offset_mm: sourceProfile.sensor_offset_mm || 40,
                warn_low_cm: sourceProfile.warn_low_cm || 1.5,
                warn_low_uses: sourceProfile.warn_low_uses || 60,
                warn_mid_cm: sourceProfile.warn_mid_cm || 1.0,
                warn_mid_uses: sourceProfile.warn_mid_uses || 35,
                warn_empty_cm: sourceProfile.warn_empty_cm || 0.5,
                warn_empty_uses: sourceProfile.warn_empty_uses || 15
            })
        });

        if (res.ok) {
            const newP = await res.json();
            showToast(`Đã tạo cấu hình [${newP.name}] thành công!`, "OK");
            closeCreatePaperProfileModal();
            currentSelectedPaperProfileId = newP.id;
            await loadAdminPaperSettings();
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể tạo cấu hình");
        }
    } catch (err) {
        alert("Lỗi khi tạo cấu hình: " + err.message);
    }
}

async function handleSetDefaultProfile() {
    if (!currentSelectedPaperProfileId) return;
    const prof = currentPaperProfiles.find(p => p.id === currentSelectedPaperProfileId);
    if (!confirm(`Bạn có chắc chắn muốn đặt cấu hình [${prof ? prof.name : ''}] làm MẶC ĐỊNH cho toàn hệ thống không?
(Tất cả WC và Cabin không gán riêng sẽ tự động dùng cấu hình này)`)) {
        return;
    }

    try {
        const res = await apiFetch(`/api/admin/paper/profiles/${currentSelectedPaperProfileId}/set-default`, {
            method: 'POST'
        });
        if (res.ok) {
            showToast(`Đã đặt cấu hình mặc định toàn hệ thống!`, "OK");
            await loadAdminPaperSettings();
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể đặt làm mặc định");
        }
    } catch (err) {
        alert("Lỗi: " + err.message);
    }
}

async function handleDeletePaperProfile() {
    if (!currentSelectedPaperProfileId) return;
    const prof = currentPaperProfiles.find(p => p.id === currentSelectedPaperProfileId);
    if (!prof) return;

    if (!confirm(`Bạn có chắc chắn muốn xóa cấu hình cuộn giấy [${prof.name}]?
Các WC và Cabin đang dùng cấu hình này sẽ tự động chuyển về cấu hình mặc định của hệ thống.`)) {
        return;
    }

    try {
        const res = await apiFetch(`/api/admin/paper/profiles/${currentSelectedPaperProfileId}`, {
            method: 'DELETE'
        });
        if (res.ok) {
            showToast(`Đã xóa cấu hình cuộn giấy thành công!`, "OK");
            currentSelectedPaperProfileId = null;
            await loadAdminPaperSettings();
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể xóa cấu hình");
        }
    } catch (err) {
        alert("Lỗi khi xóa: " + err.message);
    }
}

function switchPaperSubTab(tab) {
    const paramsDiv = document.getElementById('subtab-paper-params');
    const assignDiv = document.getElementById('subtab-paper-assign');
    const paramsBtn = document.getElementById('subtab-paper-params-btn');
    const assignBtn = document.getElementById('subtab-paper-assign-btn');

    if (tab === 'params') {
        if (paramsDiv) paramsDiv.style.display = 'block';
        if (assignDiv) assignDiv.style.display = 'none';
        if (paramsBtn) {
            paramsBtn.style.borderBottom = '2px solid #2563eb';
            paramsBtn.style.color = '#2563eb';
            paramsBtn.style.fontWeight = '700';
        }
        if (assignBtn) {
            assignBtn.style.borderBottom = 'none';
            assignBtn.style.color = '#64748b';
            assignBtn.style.fontWeight = '600';
        }
    } else {
        if (paramsDiv) paramsDiv.style.display = 'none';
        if (assignDiv) assignDiv.style.display = 'block';
        if (assignBtn) {
            assignBtn.style.borderBottom = '2px solid #2563eb';
            assignBtn.style.color = '#2563eb';
            assignBtn.style.fontWeight = '700';
        }
        if (paramsBtn) {
            paramsBtn.style.borderBottom = 'none';
            paramsBtn.style.color = '#64748b';
            paramsBtn.style.fontWeight = '600';
        }
        loadPaperAssignments();
    }
}

// ================= HIERARCHICAL ASSIGNMENT MANAGEMENT =================
async function loadPaperAssignments() {
    try {
        const res = await apiFetch('/api/admin/paper/assignments');
        if (!res.ok) return;
        paperAssignmentsData = await res.json();
        renderPaperAssignmentsTable();
    } catch (e) {
        console.error("Error loading paper assignments:", e);
    }
}

function filterPaperAssignmentsTable() {
    const text = (document.getElementById('paper-assign-filter-input')?.value || '').toLowerCase().trim();
    renderPaperAssignmentsTable(text);
}

function renderPaperAssignmentsTable(filterText = '') {
    const tbody = document.getElementById('paper-assign-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!paperAssignmentsData || paperAssignmentsData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 2rem; color: #64748b;">Chưa có dữ liệu nhà ga hoặc WC nào.</td></tr>';
        return;
    }

    const defaultProfile = currentPaperProfiles.find(p => p.is_default);

    paperAssignmentsData.forEach(term => {
        term.floors.forEach(fl => {
            fl.toilets.forEach(t => {
                const matchesFilter = !filterText || 
                    term.terminal_name.toLowerCase().includes(filterText) ||
                    fl.floor_name.toLowerCase().includes(filterText) ||
                    t.toilet_name.toLowerCase().includes(filterText) ||
                    t.cabins.some(c => c.label.toLowerCase().includes(filterText) || c.mac_address.toLowerCase().includes(filterText));

                if (!matchesFilter) return;

                // 1. RENDER WC ROW
                const wcRow = document.createElement('tr');
                wcRow.style.cssText = 'background: #f8fafc; border-top: 2px solid #cbd5e1; border-bottom: 1px solid #e2e8f0;';
                
                const wcOptionsHtml = `
                    <option value="" ${!t.paper_profile_id ? 'selected' : ''}>[Dùng Mặc định toàn hệ thống: ${defaultProfile ? defaultProfile.name : ''}]</option>
                    ${currentPaperProfiles.map(p => `
                        <option value="${p.id}" ${t.paper_profile_id === p.id ? 'selected' : ''}>${p.name} ${p.is_default ? '(Mặc định)' : ''}</option>
                    `).join('')}
                `;

                const wcEffectiveBadge = t.paper_profile_id 
                    ? `<span class="badge" style="background: #e0f2fe; color: #0369a1; border: 1px solid #7dd3fc; font-weight: 700; padding: 3px 8px;">🏢 ${t.effective_profile_name} (Riêng WC)</span>`
                    : `<span class="badge" style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; font-weight: 600; padding: 3px 8px;">⚙️ ${t.effective_profile_name}</span>`;

                wcRow.innerHTML = `
                    <td style="padding: 0.75rem 1rem;">
                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                            <span style="font-size: 1.15rem;">🏢</span>
                            <div>
                                <strong style="color: #0f172a; font-size: 0.95rem;">${escapeHtml(t.toilet_name)}</strong>
                                <div style="font-size: 0.75rem; color: #64748b;">${escapeHtml(term.terminal_name)} • ${escapeHtml(fl.floor_name)} • ${t.cabins.length} Cabin</div>
                            </div>
                        </div>
                    </td>
                    <td style="padding: 0.75rem 1rem;">
                        <select onchange="handleAssignPaperProfile('toilet', ${t.toilet_id}, this.value)" style="width: 100%; padding: 0.35rem 0.6rem; border-radius: 6px; border: 1px solid #94a3b8; font-size: 0.82rem; background: white; font-weight: 600;">
                            ${wcOptionsHtml}
                        </select>
                        <div style="font-size: 0.7rem; color: #64748b; margin-top: 2px;">
                            👉 Sẽ áp dụng cho tất cả cabin trong WC này
                        </div>
                    </td>
                    <td style="padding: 0.75rem 1.25rem;">
                        ${wcEffectiveBadge}
                    </td>
                `;
                tbody.appendChild(wcRow);

                // 2. RENDER CABIN ROWS
                t.cabins.forEach(c => {
                    const cabinRow = document.createElement('tr');
                    cabinRow.style.cssText = 'border-bottom: 1px solid #f1f5f9; background: white; transition: background 0.15s;';
                    cabinRow.onmouseover = () => cabinRow.style.background = '#fcfdfe';
                    cabinRow.onmouseout = () => cabinRow.style.background = 'white';

                    const cabinOptionsHtml = `
                        <option value="" ${!c.paper_profile_id ? 'selected' : ''}>[Kế thừa theo WC: ${t.paper_profile_name || (defaultProfile ? defaultProfile.name : 'Mặc định')}]</option>
                        ${currentPaperProfiles.map(p => `
                            <option value="${p.id}" ${c.paper_profile_id === p.id ? 'selected' : ''}>${p.name} ${p.is_default ? '(Mặc định)' : ''}</option>
                        `).join('')}
                    `;

                    let cabinBadge = '';
                    if (c.source === 'DEVICE') {
                        cabinBadge = `<span class="badge" style="background: #f0fdf4; color: #166534; border: 1px solid #86efac; font-weight: 700; padding: 2px 7px;">🚪 ${c.effective_profile_name} (Riêng Cabin)</span>`;
                    } else if (c.source === 'TOILET') {
                        cabinBadge = `<span class="badge" style="background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; font-weight: 600; padding: 2px 7px;">↳ Kế thừa WC: ${c.effective_profile_name}</span>`;
                    } else {
                        cabinBadge = `<span class="badge" style="background: #f8fafc; color: #64748b; border: 1px solid #e2e8f0; font-weight: 500; padding: 2px 7px;">↳ ${c.effective_profile_name}</span>`;
                    }

                    cabinRow.innerHTML = `
                        <td style="padding: 0.55rem 1rem 0.55rem 2.25rem;">
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <span style="color: #cbd5e1; font-weight: bold; user-select: none;">└─</span>
                                <span class="badge" style="background: #e0f2fe; color: #0369a1; font-weight: 700; padding: 2px 6px; font-size: 0.72rem;">#${c.cabin_order || 1}</span>
                                <div>
                                    <strong style="color: #334155; font-size: 0.88rem;">${escapeHtml(c.label)}</strong>
                                    <code style="font-size: 0.75rem; color: #64748b; margin-left: 6px;">${c.mac_address}</code>
                                </div>
                            </div>
                        </td>
                        <td style="padding: 0.55rem 1rem;">
                            <select onchange="handleAssignPaperProfile('device', ${c.device_id}, this.value)" style="width: 100%; padding: 0.3rem 0.5rem; border-radius: 4px; border: 1px solid #cbd5e1; font-size: 0.8rem; background: ${c.paper_profile_id ? '#f0fdf4' : 'white'};">
                                ${cabinOptionsHtml}
                            </select>
                        </td>
                        <td style="padding: 0.55rem 1.25rem;">
                            ${cabinBadge}
                        </td>
                    `;
                    tbody.appendChild(cabinRow);
                });
            });
        });
    });
}

async function handleAssignPaperProfile(targetType, targetId, profileIdVal) {
    const profileId = profileIdVal ? parseInt(profileIdVal) : null;
    try {
        const res = await apiFetch('/api/admin/paper/assign', {
            method: 'POST',
            body: JSON.stringify({
                target_type: targetType,
                target_id: targetId,
                profile_id: profileId
            })
        });

        if (res.ok) {
            showToast("Đã cập nhật phân bổ cấu hình cuộn giấy thành công!", "OK");
            await loadPaperAssignments();
            // Refresh profiles count
            const profRes = await apiFetch('/api/admin/paper/profiles');
            if (profRes.ok) currentPaperProfiles = await profRes.json();
            // Refresh map markers and detail panel immediately
            if (currentFloor) {
                const flRes = await apiFetch(`/api/floors/${currentFloor.id}`);
                if (flRes.ok) {
                    const flData = await flRes.json();
                    currentFloorToilets = flData.toilets || [];
                    renderMarkers();
                }
            }
            if (selectedToiletId) selectToilet(selectedToiletId);
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể phân bổ cấu hình");
        }
    } catch (e) {
        alert("Lỗi khi gán cấu hình: " + e.message);
    }
}

// ================= EXPORT & IMPORT CONFIG =================
async function exportPaperConfigs() {
    try {
        const res = await apiFetch('/api/admin/paper/export');
        if (!res.ok) {
            alert("Không thể xuất file cấu hình");
            return;
        }
        const data = await res.json();
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
        const downloadAnchor = document.createElement('a');
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `cau_hinh_cuon_giay_san_bay_${dateStr}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
        showToast("Đã xuất file cấu hình cuộn giấy thành công!", "OK");
    } catch (e) {
        alert("Lỗi khi xuất file: " + e.message);
    }
}

function triggerImportPaperConfig() {
    const fileInput = document.getElementById('paper-import-file-input');
    if (fileInput) fileInput.click();
}

async function handlePaperConfigFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const parsed = JSON.parse(e.target.result);
            if (!parsed.profiles || !Array.isArray(parsed.profiles)) {
                alert("File JSON không hợp lệ hoặc thiếu mục 'profiles'");
                return;
            }

            if (!confirm(`Bạn có chắc chắn muốn nạp file cấu hình này không?
File chứa ${parsed.profiles.length} cấu hình cuộn giấy.`)) {
                event.target.value = '';
                return;
            }

            const res = await apiFetch('/api/admin/paper/import', {
                method: 'POST',
                body: JSON.stringify(parsed)
            });

            if (res.ok) {
                const report = await res.json();
                showToast(`Nhập cấu hình thành công: Đã thêm ${report.created_profiles_count || 0}, cập nhật ${report.updated_profiles_count || 0} cấu hình!`, "OK");
                await loadAdminPaperSettings();
            } else {
                const err = await res.json();
                alert(err.detail || "Không thể nhập cấu hình từ file");
            }
        } catch (err) {
            alert("Lỗi phân tích cú pháp file JSON: " + err.message);
        } finally {
            event.target.value = '';
        }
    };
    reader.readAsText(file);
}


// Users Management
async function loadAdminUsers() {
    try {
        const res = await apiFetch('/api/admin/users');
        if (!res.ok) return;
        const users = await res.json();

        const tbody = document.getElementById('admin-users-table');
        tbody.innerHTML = '';
        users.forEach(u => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${u.id}</td>
                <td><strong>${u.username}</strong></td>
                <td><span class="role-badge ${u.role}">${u.role.toUpperCase()}</span></td>
                <td>${u.must_change_password ? '<span style="color: red;">Có</span>' : 'Không'}</td>
                <td>${new Date(u.created_at).toLocaleDateString('vi-VN')}</td>
                <td>
                    <button class="btn btn-secondary btn-sm" onclick="openEditUserModal(${u.id}, '${u.username}', '${u.role}')">Sửa / Reset Pass</button>
                    ${currentUser.id !== u.id ? `<button class="btn btn-danger btn-sm" onclick="handleDeleteUser(${u.id})">Xoá</button>` : ''}
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {}
}

function openCreateUserModal() {
    document.getElementById('user-modal-title').innerText = "Tạo Tài Khoản Mới";
    document.getElementById('form-user-id').value = '';
    document.getElementById('form-user-name').value = '';
    document.getElementById('form-user-name').disabled = false;
    document.getElementById('form-user-pwd-label').innerText = "Mật khẩu:";
    document.getElementById('form-user-pwd').required = true;
    document.getElementById('modal-user-form').style.display = 'flex';
}

function openEditUserModal(id, username, role) {
    document.getElementById('user-modal-title').innerText = `Chỉnh sửa: ${username}`;
    document.getElementById('form-user-id').value = id;
    document.getElementById('form-user-name').value = username;
    document.getElementById('form-user-name').disabled = true;
    document.getElementById('form-user-role').value = role;
    document.getElementById('form-user-pwd-label').innerText = "Đặt lại mật khẩu mới (bỏ trống nếu không đổi):";
    document.getElementById('form-user-pwd').required = false;
    document.getElementById('form-user-pwd').value = '';
    document.getElementById('modal-user-form').style.display = 'flex';
}

function closeUserModal() {
    document.getElementById('modal-user-form').style.display = 'none';
}

async function handleUserFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('form-user-id').value;
    const username = document.getElementById('form-user-name').value.trim();
    const role = document.getElementById('form-user-role').value;
    const pwd = document.getElementById('form-user-pwd').value;

    try {
        if (!id) {
            // Create user
            const res = await apiFetch('/api/admin/users', {
                method: 'POST',
                body: JSON.stringify({ username, role, password: pwd })
            });
            if (!res.ok) {
                const err = await res.json();
                alert(err.detail || "Không thể tạo tài khoản");
                return;
            }
            showToast("Tạo tài khoản thành công!", "OK");
        } else {
            // Update user
            const payload = { role };
            if (pwd) payload.new_password = pwd;
            const res = await apiFetch(`/api/admin/users/${id}`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                const err = await res.json();
                alert(err.detail || "Không thể cập nhật tài khoản");
                return;
            }
            showToast("Cập nhật tài khoản thành công!", "OK");
        }
        closeUserModal();
        loadAdminUsers();
    } catch (err) {
        alert("Lỗi kết nối");
    }
}

async function handleDeleteUser(id) {
    if (!confirm("Bạn có chắc chắn muốn xoá người dùng này?")) return;
    try {
        const res = await apiFetch(`/api/admin/users/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast("Đã xoá tài khoản", "OK");
            loadAdminUsers();
        }
    } catch (err) {}
}

// Map Upload
function loadAdminMapsOptions() {
    const sel = document.getElementById('upload-floor-select');
    sel.innerHTML = '';
    currentTerminals.forEach(t => {
        t.floors.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.innerText = `${t.name} - ${f.name}`;
            sel.appendChild(opt);
        });
    });
}

async function handleUploadMap(e) {
    e.preventDefault();
    const floorId = document.getElementById('upload-floor-select').value;
    const fileInput = document.getElementById('upload-floor-file');

    if (!fileInput.files || fileInput.files.length === 0) return;
    const file = fileInput.files[0];

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await apiFetch(`/api/admin/floors/${floorId}/map`, {
            method: 'POST',
            body: formData
        });
        if (res.ok) {
            showToast("Tải lên bản đồ PDF thành công!", "OK");
            fileInput.value = '';
            await loadTerminals();
        } else {
            const err = await res.json();
            alert(err.detail || "Tải lên thất bại");
        }
    } catch (err) {
        alert("Lỗi tải lên bản đồ");
    }
}

// Gateways & Devices Management (Parent - Child Hierarchy)
let collapsedGateways = new Set();
let currentAdminGateways = [];
let currentAdminDevices = [];
let currentDiscoveredMap = {};

async function loadAdminGateways() {
    const container = document.getElementById('admin-gateways-tree-container');
    try {
        const res = await apiFetch('/api/admin/gateways');
        if (!res.ok) {
            if (container) container.innerHTML = '<div class="alert alert-danger" style="margin: 1rem 0;">Không thể tải danh sách Gateway</div>';
            return;
        }
        currentAdminGateways = await res.json();

        try {
            const discRes = await apiFetch('/api/gateways/discovered');
            if (discRes.ok) {
                currentDiscoveredMap = await discRes.json();
            }
        } catch (e) {
            currentDiscoveredMap = {};
        }

        try {
            const devRes = await apiFetch('/api/admin/devices');
            if (devRes.ok) {
                currentAdminDevices = await devRes.json();
            }
        } catch (e) {
            currentAdminDevices = [];
        }

        // Also populate select options in device edit form
        const gwSelect = document.getElementById('form-device-gw');
        if (gwSelect) {
            gwSelect.innerHTML = '';
            currentAdminGateways.forEach(gw => {
                const opt = document.createElement('option');
                opt.value = gw.id;
                opt.innerText = `${gw.mac_address || gw.ip_address} (${gw.toilet_name || 'Chưa gán'})`;
                gwSelect.appendChild(opt);
            });
        }

        renderAdminGatewaysTree();
    } catch (err) {
        console.error("Error loading gateways:", err);
        if (container) {
            container.innerHTML = `<div class="alert alert-danger" style="margin: 1rem 0;">Lỗi kết nối máy chủ: ${escapeHtml(err.message)}</div>`;
        }
    }
}

async function loadAdminDevices() {
    await loadAdminGateways();
}

function updateGatewayTreeFromWs(data) {
    if (!currentAdminGateways || currentAdminGateways.length === 0) {
        // If admin gateways tab is active, fetch list
        const tabEl = document.getElementById('admin-tab-gateways');
        if (tabEl && tabEl.style.display !== 'none') {
            loadAdminGateways();
        }
        return;
    }

    // Find the gateway in memory
    const targetGw = currentAdminGateways.find(gw => 
        (data.gateway_id && gw.id === data.gateway_id) ||
        (data.gateway_mac && gw.mac_address && gw.mac_address.toUpperCase() === data.gateway_mac.toUpperCase()) ||
        (data.toilet_id && gw.toilet_id === data.toilet_id) ||
        (data.gateway_ip && gw.ip_address === data.gateway_ip)
    );

    if (!targetGw) return;

    // Update in-memory data
    const isOnline = (data.gateway_online !== undefined) ? data.gateway_online : (data.is_online !== undefined ? data.is_online : true);
    targetGw.is_online = isOnline;
    targetGw.status = isOnline ? "ONLINE" : "OFFLINE";
    if (data.last_seen) {
        targetGw.last_seen = data.last_seen;
    } else {
        targetGw.last_seen = new Date().toISOString();
    }
    if (data.gateway_ip) {
        targetGw.ip_address = data.gateway_ip;
    }
    if (data.toilet_name) {
        targetGw.toilet_name = data.toilet_name;
    }
    if (data.floor_name) {
        targetGw.floor_name = data.floor_name;
    }
    if (data.terminal_name) {
        targetGw.terminal_name = data.terminal_name;
    }
    const tSt = data.toilet_status || data.status;
    if (tSt) {
        targetGw.toilet_status = tSt;
    }
    if (data.toilet_min_paper !== undefined && data.toilet_min_paper !== null) {
        targetGw.toilet_min_paper = data.toilet_min_paper;
    } else if (data.devices && data.devices.length > 0) {
        targetGw.toilet_min_paper = Math.min(...data.devices.map(d => d.paper_level));
    }
    if (data.devices) {
        targetGw.devices = data.devices;
        targetGw.device_count = data.devices.length;
    }
    if (data.discovered_devices) {
        if (targetGw.ip_address) currentDiscoveredMap[targetGw.ip_address] = data.discovered_devices;
        if (targetGw.mac_address) currentDiscoveredMap[targetGw.mac_address] = data.discovered_devices;
    }

    // Always re-render the admin tree if admin gateways tab is active or container exists
    const container = document.getElementById('admin-gateways-tree-container');
    const tabEl = document.getElementById('admin-tab-gateways');
    if (container && (!tabEl || tabEl.style.display !== 'none')) {
        renderAdminGatewaysTree();
    }
}

function renderAdminGatewaysTree() {
    const container = document.getElementById('admin-gateways-tree-container');
    if (!container) return;
    container.innerHTML = '';

    if (!currentAdminGateways || currentAdminGateways.length === 0) {
        container.innerHTML = `
            <div style="background: white; border-radius: 8px; border: 1px dashed var(--border-color); padding: 3rem 1.5rem; text-align: center; color: var(--text-secondary);">
                <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">📡</div>
                <h4 style="color: var(--text-primary); margin-bottom: 0.5rem; font-size: 1.1rem;">Chưa có Gateway nào trong hệ thống</h4>
                <p style="font-size: 0.9rem; margin-bottom: 1.25rem;">Hãy nhập địa chỉ MAC phần cứng của ESP32 Gateway ở trên để thêm Gateway đầu tiên.</p>
            </div>
        `;
        return;
    }

    const assignedDeviceIds = new Set();

    currentAdminGateways.forEach(gw => {
        const isCollapsed = collapsedGateways.has(gw.id);
        const card = document.createElement('div');
        card.className = 'gateway-group-card';
        card.style.cssText = 'background: white; border-radius: 8px; border: 1px solid var(--border-color); margin-bottom: 1.25rem; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);';

        const devs = gw.devices || (currentAdminDevices ? currentAdminDevices.filter(d => d.gateway_id === gw.id) : []);
        devs.forEach(d => assignedDeviceIds.add(d.id));

        // Discovered clients broadcasting to this Gateway
        const discFromGw = gw.discovered_devices || [];
        const discListByIp = gw.ip_address ? (currentDiscoveredMap[gw.ip_address] || []) : [];
        const discListByMac = gw.mac_address ? (currentDiscoveredMap[gw.mac_address.toUpperCase()] || currentDiscoveredMap[gw.mac_address] || []) : [];
        const discListById = gw.id ? (currentDiscoveredMap[String(gw.id)] || currentDiscoveredMap[gw.id] || []) : [];
        const discListByAll = (currentDiscoveredMap["_all"] || []).filter(c => 
            (c.gateway_id && c.gateway_id === gw.id) ||
            (c.gateway_mac && gw.mac_address && c.gateway_mac.toUpperCase() === gw.mac_address.toUpperCase()) ||
            (c.gateway_ip && gw.ip_address && c.gateway_ip === gw.ip_address) ||
            (c.toilet_id && gw.toilet_id && c.toilet_id === gw.toilet_id)
        );
        const combinedDisc = [...discFromGw, ...discListByIp, ...discListByMac, ...discListById, ...discListByAll];
        const savedMacs = new Set(devs.map(d => (d.mac_address || '').toUpperCase()));
        const uniqueDisc = [];
        const seenMac = new Set();
        combinedDisc.forEach(c => {
            const cm = (c.mac_address || '').toUpperCase();
            if (!savedMacs.has(cm) && !seenMac.has(cm)) {
                seenMac.add(cm);
                uniqueDisc.push(c);
            }
        });

        // Status Badge
        let statusBadge = '';
        if (gw.is_new) {
            statusBadge = gw.is_online
                ? `<span id="gw-status-badge-${gw.id}" style="background: #f8fafc; color: #475569; border: 1px solid #cbd5e1; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">⚪ Có tín hiệu (Chưa gán)</span>`
                : `<span id="gw-status-badge-${gw.id}" style="background: #f8fafc; color: #94a3b8; border: 1px solid #e2e8f0; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">⚪ Mất kết nối (Chưa gán)</span>`;
        } else {
            statusBadge = gw.is_online
                ? `<span id="gw-status-badge-${gw.id}" style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">🟢 Online</span>`
                : `<span id="gw-status-badge-${gw.id}" style="background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">🔴 Mất kết nối</span>`;
        }

        // Live pulse badge
        let discBadge = '';
        if (uniqueDisc.length > 0) {
            discBadge = `<span class="badge-live-pulse" style="margin-left: 6px; font-size: 0.72rem;" title="${uniqueDisc.map(c => c.mac_address).join(', ')}">📡 +${uniqueDisc.length} client mới</span>`;
        }

        // WC Status Badge (Đầy đủ, Sắp hết, Hết giấy, Mất kết nối)
        let wcStatusBadge = '';
        if (gw.toilet_name && gw.toilet_name !== 'Chưa gán') {
            const tSt = gw.toilet_status || (gw.is_online ? 'OK' : 'OFFLINE');
            let pillClass = 'status-pill OK';
            let pillLabel = '● Đầy đủ';
            if (tSt === 'DANGER' || tSt === 'EMPTY') {
                pillClass = 'status-pill DANGER';
                pillLabel = '● Hết giấy';
            } else if (tSt === 'WARNING' || tSt === 'LOW') {
                pillClass = 'status-pill WARNING';
                pillLabel = '● Sắp hết';
            } else if (tSt === 'OFFLINE' || !gw.is_online) {
                pillClass = 'status-pill OFFLINE';
                pillLabel = '● Mất kết nối';
            }
            const minPaperText = (gw.toilet_min_paper !== undefined && gw.toilet_min_paper !== null && tSt !== 'OFFLINE') 
                ? ` (${Math.round(gw.toilet_min_paper)}%)` 
                : '';
            wcStatusBadge = `<span id="gw-wc-status-${gw.id}" class="${pillClass}" style="margin-left: 6px; font-size: 0.72rem; padding: 2px 8px; font-weight: 600;">${pillLabel}${minPaperText}</span>`;
        }

        // Discovered banner inside card body
        let discBannerHtml = '';
        if (uniqueDisc.length > 0) {
            discBannerHtml = `
                <div style="background: #ecfdf5; border-left: 4px solid #10b981; border-bottom: 1px solid #a7f3d0; padding: 0.75rem 1.25rem;">
                    <div style="font-size: 0.85rem; font-weight: 600; color: #065f46; margin-bottom: 0.4rem; display: flex; align-items: center; justify-content: space-between;">
                        <span>📡 Phát hiện ${uniqueDisc.length} Client ESP đang truyền dữ liệu tới Gateway này (chưa lưu vào CSDL):</span>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                        ${uniqueDisc.map(c => `
                            <div style="background: white; border: 1px solid #a7f3d0; border-radius: 6px; padding: 0.4rem 0.75rem; display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem;">
                                <div>
                                    • MAC: <code style="font-weight: 700; color: #047857;">${c.mac_address}</code> | Giấy: <strong>${Math.round(c.paper_level)}%</strong> ${c.distance !== null && c.distance !== undefined ? `(${c.distance} mm)` : ''} | Pin: <strong>${Math.round(c.battery)}%</strong>
                                </div>
                                <div style="display: flex; gap: 0.35rem;">
                                    <button class="btn btn-primary btn-sm" onclick="openAddCabinForGateway(${gw.id}, ${gw.toilet_id}, '${c.mac_address}')" style="padding: 2px 8px; font-size: 0.75rem;">➕ Lưu Client</button>
                                    <button class="btn btn-danger btn-sm" onclick="handleDeleteDiscoveredClient('${c.mac_address}', ${gw.id}, ${gw.toilet_id})" style="padding: 2px 8px; font-size: 0.75rem;" title="Xóa client mới phát hiện này">🗑️ Xóa</button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        // Child devices table HTML
        let devicesHtml = '';
        if (devs.length === 0) {
            devicesHtml = `
                <div style="padding: 1.5rem 2.5rem; text-align: center; color: var(--text-secondary); background: #fafbfc; border-top: 1px solid #f1f5f9;">
                    <p style="margin: 0 0 0.5rem 0; font-size: 0.9rem;">Gateway này chưa có thiết bị ESP (Cabin) nào.</p>
                    <button class="btn btn-secondary btn-sm" onclick="openAddCabinForGateway(${gw.id}, ${gw.toilet_id})">➕ Thêm thiết bị Cabin đầu tiên</button>
                </div>
            `;
        } else {
            let deviceRows = '';
            devs.forEach(d => {
                const paperPct = Math.round(d.paper_level);
                let paperColor = '#10b981';
                if (d.status === 'DANGER' || paperPct <= 10) paperColor = '#ef4444';
                else if (d.status === 'WARNING' || paperPct <= 25) paperColor = '#f59e0b';

                let statusPill = '';
                if (d.status === 'DANGER') {
                    statusPill = `<span class="status-pill DANGER">● Hết giấy</span>`;
                } else if (d.status === 'WARNING') {
                    statusPill = `<span class="status-pill WARNING">● Sắp hết</span>`;
                } else if (d.status === 'OK') {
                    statusPill = `<span class="status-pill OK">● Đầy đủ</span>`;
                } else {
                    statusPill = `<span class="status-pill ${d.status}">● ${d.status}</span>`;
                }

                const lastSeenStr = d.last_seen ? new Date(d.last_seen).toLocaleTimeString('vi-VN') : 'Chưa có';

                deviceRows += `
                    <tr style="border-bottom: 1px solid #f1f5f9; transition: background 0.15s ease;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='white'">
                        <td style="padding: 0.65rem 1rem 0.65rem 2.25rem;">
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <span style="color: #cbd5e1; font-weight: bold; user-select: none;">└─</span>
                                <span class="badge" style="background: #e0f2fe; color: #0369a1; font-weight: 700; padding: 2px 7px;">#${d.cabin_order || 1}</span>
                            </div>
                        </td>
                        <td style="padding: 0.65rem 1rem;">
                            <strong style="color: var(--text-primary); font-size: 0.92rem;">${escapeHtml(d.label || '')}</strong>
                        </td>
                        <td style="padding: 0.65rem 1rem;">
                            <code style="font-weight: 600; color: #334155; font-size: 0.85rem;">${d.mac_address}</code>
                        </td>
                        <td style="padding: 0.65rem 1rem;">
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <div style="flex: 1; min-width: 60px; max-width: 100px; height: 7px; background: #e2e8f0; border-radius: 4px; overflow: hidden;">
                                    <div style="width: ${Math.min(100, Math.max(0, paperPct))}%; height: 100%; background: ${paperColor};"></div>
                                </div>
                                <strong style="font-size: 0.85rem; color: ${paperColor}; min-width: 36px;">${paperPct}%</strong>
                            </div>
                        </td>
                        <td style="padding: 0.65rem 1rem;">
                            <span style="font-size: 0.85rem; font-weight: 500;">🔋 ${Math.round(d.battery)}%</span>
                        </td>
                        <td style="padding: 0.65rem 1rem;">
                            ${statusPill}
                        </td>
                        <td style="padding: 0.65rem 1rem; color: var(--text-secondary); font-size: 0.8rem;">
                            ${lastSeenStr}
                        </td>
                        <td style="padding: 0.65rem 1.25rem; text-align: right; white-space: nowrap;">
                            <button class="btn btn-secondary btn-sm" onclick="viewDeviceChart(${d.id}, '${escapeHtml(d.label || '')}')" title="Xem biểu đồ lịch sử" style="margin-right: 0.25rem;">📊 Lịch sử</button>
                            <button class="btn btn-secondary btn-sm" onclick="openEditDeviceModal(${d.id}, '${d.mac_address}', '${escapeHtml(d.label || '')}', ${d.gateway_id}, ${d.cabin_order || 1})" title="Sửa thông tin" style="margin-right: 0.25rem;">✏️ Sửa</button>
                            <button class="btn btn-danger btn-sm" onclick="handleDeleteDevice(${d.id})" title="Xóa thiết bị này">🗑️ Xóa</button>
                        </td>
                    </tr>
                `;
            });

            devicesHtml = `
                <div class="table-responsive" style="margin: 0;">
                    <table style="width: 100%; border-collapse: collapse; margin: 0;">
                        <thead>
                            <tr style="background: #ffffff; color: var(--text-secondary); font-size: 0.73rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e2e8f0;">
                                <th style="padding: 0.55rem 1rem 0.55rem 2.25rem; text-align: left; width: 100px;">Thứ tự</th>
                                <th style="padding: 0.55rem 1rem; text-align: left;">Nhãn Cabin</th>
                                <th style="padding: 0.55rem 1rem; text-align: left;">Địa chỉ MAC</th>
                                <th style="padding: 0.55rem 1rem; text-align: left; width: 160px;">Mức giấy</th>
                                <th style="padding: 0.55rem 1rem; text-align: left; width: 90px;">Pin</th>
                                <th style="padding: 0.55rem 1rem; text-align: left; width: 120px;">Trạng thái</th>
                                <th style="padding: 0.55rem 1rem; text-align: left; width: 110px;">Lần cuối</th>
                                <th style="padding: 0.55rem 1.25rem; text-align: right; width: 220px;">Thao tác</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${deviceRows}
                        </tbody>
                    </table>
                </div>
            `;
        }

        const placeBtn = gw.is_new
            ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); assignGatewayToMap('${gw.mac_address || ''}', '${gw.ip_address || ''}')" title="Đặt vị trí trên bản đồ">📍 Đặt lên Map</button>`
            : '';

        card.innerHTML = `
            <!-- PARENT HEADER: GATEWAY -->
            <div class="gateway-parent-header" style="background: #f8fafc; padding: 0.85rem 1.25rem; border-bottom: ${isCollapsed ? 'none' : '1px solid var(--border-color)'}; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem; border-left: 4px solid #2563eb;">
                <div style="display: flex; align-items: center; gap: 0.65rem; cursor: pointer; flex-wrap: wrap;" onclick="toggleGatewayCollapse(${gw.id})" title="Nhấn để thu gọn hoặc mở rộng danh sách thiết bị con">
                    <span style="font-size: 0.85rem; color: var(--text-secondary); width: 14px; text-align: center;">${isCollapsed ? '▶' : '▼'}</span>
                    <span style="font-size: 1.3rem;">📡</span>
                    <div>
                        <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
                            <code style="font-size: 1rem; font-weight: 700; color: #1e40af;">MAC: ${gw.mac_address || 'Chưa có'}</code>
                            <span style="font-size: 0.82rem; color: #475569;">(IP: <strong>${gw.ip_address || '---'}</strong>)</span>
                            ${statusBadge}
                            ${discBadge}
                        </div>
                        <div style="display: flex; align-items: center; gap: 0.6rem; font-size: 0.78rem; color: var(--text-secondary); margin-top: 3px; flex-wrap: wrap;">
                            <span>🏢 Nhà ga: <strong>${escapeHtml(gw.terminal_name || '—')}</strong></span>
                            <span>•</span>
                            <span>📍 Tầng: <strong>${escapeHtml(gw.floor_name || '—')}</strong></span>
                            <span>•</span>
                            <span id="gw-wc-info-${gw.id}">🚻 WC: <strong style="color: #0369a1;">${escapeHtml(gw.toilet_name || 'Chưa gán')}</strong>${wcStatusBadge}</span>
                            <span>•</span>
                            <span id="gw-last-seen-${gw.id}">⏱️ Lần cuối: ${gw.last_seen ? new Date(gw.last_seen).toLocaleTimeString('vi-VN') : 'Chưa có'}</span>
                        </div>
                    </div>
                </div>

                <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
                    <span class="badge ${devs.length > 0 ? 'badge-info' : 'badge-secondary'}" style="font-size: 0.8rem; padding: 0.35rem 0.65rem; margin-right: 0.25rem;">
                        🔢 ${devs.length} thiết bị
                    </span>
                    ${placeBtn}
                    <button class="btn btn-secondary btn-sm" id="btn-ping-gw-${gw.id}" onclick="event.stopPropagation(); checkAdminGateway('${gw.ip_address || ''}', ${gw.id}, ${gw.is_new ? 'true' : 'false'}, this)" title="Kiểm tra tín hiệu Gateway">
                        🔍 Kiểm tra
                    </button>
                    <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); openAddCabinForGateway(${gw.id}, ${gw.toilet_id})" title="Thêm thiết bị con">
                        ➕ Thêm Cabin
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); handleDeleteGateway(${gw.id})" title="Xoá Gateway này">
                        🗑️ Xoá
                    </button>
                </div>
            </div>

            <!-- CHILDREN: DISCOVERED & DEVICES -->
            <div id="gw-children-container-${gw.id}" class="gateway-children-body" style="display: ${isCollapsed ? 'none' : 'block'}; background: white;">
                ${discBannerHtml}
                ${devicesHtml}
            </div>
        `;

        container.appendChild(card);
    });

    // Check for any orphaned devices
    const allGwIds = new Set(currentAdminGateways.map(g => g.id));
    const orphanedDevs = currentAdminDevices ? currentAdminDevices.filter(d => !d.gateway_id || !allGwIds.has(d.gateway_id)) : [];
    if (orphanedDevs.length > 0) {
        const orphanCard = document.createElement('div');
        orphanCard.style.cssText = 'background: white; border-radius: 8px; border: 1px solid #fecaca; margin-bottom: 1.25rem; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);';
        orphanCard.innerHTML = `
            <div style="background: #fff1f2; padding: 0.85rem 1.25rem; border-bottom: 1px solid #fecaca; display: flex; justify-content: space-between; align-items: center; border-left: 4px solid #ef4444;">
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span style="font-size: 1.25rem;">⚠️</span>
                    <strong style="color: #991b1b; font-size: 1rem;">Thiết Bị Chưa Gán Gateway (${orphanedDevs.length} thiết bị)</strong>
                </div>
            </div>
            <div class="table-responsive" style="margin: 0;">
                <table style="width: 100%; border-collapse: collapse; margin: 0;">
                    <thead>
                        <tr style="background: #ffffff; color: var(--text-secondary); font-size: 0.73rem; text-transform: uppercase; border-bottom: 1px solid #e2e8f0;">
                            <th style="padding: 0.55rem 1rem 0.55rem 1.5rem; text-align: left;">ID</th>
                            <th style="padding: 0.55rem 1rem; text-align: left;">Nhãn Cabin</th>
                            <th style="padding: 0.55rem 1rem; text-align: left;">Địa chỉ MAC</th>
                            <th style="padding: 0.55rem 1rem; text-align: left;">Trạng thái</th>
                            <th style="padding: 0.55rem 1.25rem; text-align: right;">Thao tác</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${orphanedDevs.map(d => `
                            <tr style="border-bottom: 1px solid #f1f5f9;">
                                <td style="padding: 0.65rem 1rem 0.65rem 1.5rem;">#${d.id}</td>
                                <td style="padding: 0.65rem 1rem;"><strong>${escapeHtml(d.label || '')}</strong></td>
                                <td style="padding: 0.65rem 1rem;"><code>${d.mac_address}</code></td>
                                <td style="padding: 0.65rem 1rem;"><span class="status-pill ${d.status}">● ${d.status}</span></td>
                                <td style="padding: 0.65rem 1.25rem; text-align: right;">
                                    <button class="btn btn-secondary btn-sm" onclick="openEditDeviceModal(${d.id}, '${d.mac_address}', '${escapeHtml(d.label || '')}', ${d.gateway_id || 0}, ${d.cabin_order || 1})">Gán Gateway</button>
                                    <button class="btn btn-danger btn-sm" onclick="handleDeleteDevice(${d.id})">Xoá</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
        container.appendChild(orphanCard);
    }

    // Discovered clients not yet associated with any registered Gateway
    const allDiscovered = currentDiscoveredMap["_all"] || [];
    const unassociatedDisc = allDiscovered.filter(c => {
        const cMac = (c.mac_address || '').toUpperCase();
        const claimed = currentAdminGateways.some(gw => 
            (c.gateway_id && c.gateway_id === gw.id) ||
            (c.gateway_mac && gw.mac_address && c.gateway_mac.toUpperCase() === gw.mac_address.toUpperCase()) ||
            (c.gateway_ip && gw.ip_address && c.gateway_ip === gw.ip_address)
        );
        return !claimed;
    });

    if (unassociatedDisc.length > 0) {
        const unassocCard = document.createElement('div');
        unassocCard.style.cssText = 'background: white; border-radius: 8px; border: 1px solid #fed7aa; margin-bottom: 1.25rem; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);';
        unassocCard.innerHTML = `
            <div style="background: #fff7ed; padding: 0.85rem 1.25rem; border-bottom: 1px solid #fed7aa; display: flex; justify-content: space-between; align-items: center; border-left: 4px solid #f97316;">
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span style="font-size: 1.25rem;">📡</span>
                    <strong style="color: #9a3412; font-size: 1rem;">Client ESP Mới Phát Hiện (Chưa gán Gateway) (${unassociatedDisc.length} client)</strong>
                </div>
            </div>
            <div style="padding: 0.75rem 1.25rem; display: flex; flex-direction: column; gap: 0.4rem;">
                ${unassociatedDisc.map(c => `
                    <div style="background: white; border: 1px solid #fed7aa; border-radius: 6px; padding: 0.45rem 0.75rem; display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem;">
                        <div>
                            • MAC: <code style="font-weight: 700; color: #ea580c;">${c.mac_address}</code> | Giấy: <strong>${Math.round(c.paper_level)}%</strong> | Pin: <strong>${Math.round(c.battery)}%</strong> | Từ IP: <strong>${c.gateway_ip || '---'}</strong>
                        </div>
                        <div style="display: flex; gap: 0.35rem;">
                            <button class="btn btn-primary btn-sm" onclick="openAddCabinForGateway(null, null, '${c.mac_address}')" style="padding: 2px 8px; font-size: 0.75rem;">➕ Lưu Client</button>
                            <button class="btn btn-danger btn-sm" onclick="handleDeleteDiscoveredClient('${c.mac_address}')" style="padding: 2px 8px; font-size: 0.75rem;" title="Xóa bỏ client mới phát hiện này">🗑️ Xóa</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
        container.appendChild(unassocCard);
    }
}

function toggleGatewayCollapse(gwId) {
    if (collapsedGateways.has(gwId)) {
        collapsedGateways.delete(gwId);
    } else {
        collapsedGateways.add(gwId);
    }
    renderAdminGatewaysTree();
}

function toggleAllGatewaysCollapse() {
    const btn = document.getElementById('btn-toggle-all-gateways');
    if (collapsedGateways.size === currentAdminGateways.length) {
        collapsedGateways.clear();
        if (btn) btn.innerText = "Thu gọn tất cả";
    } else {
        collapsedGateways = new Set(currentAdminGateways.map(g => g.id));
        if (btn) btn.innerText = "Mở rộng tất cả";
    }
    renderAdminGatewaysTree();
}

async function openAddCabinForGateway(gatewayId, toiletId, defaultMac = '') {
    if (!toiletId) {
        const gw = currentAdminGateways.find(g => g.id === gatewayId);
        if (confirm(`Gateway [${gw ? (gw.mac_address || gw.ip_address) : gatewayId}] chưa được gán vào Nhà vệ sinh nào trên bản đồ.

Bạn có muốn chuyển sang Bản đồ để Đặt vị trí cho Gateway này ngay bây giờ không?`)) {
            assignGatewayToMap(gw ? gw.mac_address : '', gw ? gw.ip_address : '');
        }
        return;
    }
    await fetchAllToilets();
    document.getElementById('add-cabin-modal-title').innerText = "Thêm Thiết Bị / Cabin Cho Gateway";
    document.getElementById('group-add-cabin-toilet-select').style.display = 'block';
    document.getElementById('group-add-cabin-toilet-name').style.display = 'none';

    const sel = document.getElementById('add-cabin-select-toilet');
    sel.innerHTML = '';
    allToiletsCache.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.innerText = `${t.terminal_name} - ${t.floor_name} - ${t.name}`;
        if (t.id === toiletId) opt.selected = true;
        sel.appendChild(opt);
    });

    onAddCabinToiletSelectChange();
    if (defaultMac) {
        document.getElementById('add-cabin-mac').value = defaultMac;
    }
    document.getElementById('modal-add-cabin').style.display = 'flex';
}

async function checkAdminGateway(ip, gwId, isNew, btn) {
    if (!ip) {
        showToast("Gateway chưa có địa chỉ IP để kiểm tra", "LOW");
        return;
    }
    const originalText = btn ? btn.innerText : '🔍 Kiểm tra';
    if (btn) {
        btn.innerText = '⏳ Đang kiểm tra...';
        btn.disabled = true;
    }
    try {
        const res = await apiFetch(`/api/admin/gateways/ping?ip=${encodeURIComponent(ip)}`);
        const data = await res.json();
        const badgeEl = document.getElementById(`gw-status-badge-${gwId}`);
        const lastSeenEl = document.getElementById(`gw-last-seen-${gwId}`);
        if (data.online) {
            showToast(`🟢 Gateway ${ip} đang ONLINE!`, 'OK');
            if (badgeEl) {
                if (isNew) {
                    badgeEl.innerHTML = `<span style="background: #f8fafc; color: #475569; border: 1px solid #cbd5e1; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">⚪ Có tín hiệu (Chưa gán)</span>`;
                } else {
                    badgeEl.innerHTML = `<span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">🟢 Online</span>`;
                }
            }
        } else {
            showToast(`🔴 Gateway ${ip} MẤT KẾT NỐI! ${data.message || ''}`, 'EMPTY');
            if (badgeEl) {
                if (isNew) {
                    badgeEl.innerHTML = `<span style="background: #f8fafc; color: #94a3b8; border: 1px solid #e2e8f0; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">⚪ Mất kết nối (Chưa gán)</span>`;
                } else {
                    badgeEl.innerHTML = `<span style="background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">🔴 Mất kết nối</span>`;
                }
            }
        }
        if (lastSeenEl && data.last_seen) {
            lastSeenEl.innerText = '⏱️ Lần cuối: ' + new Date(data.last_seen).toLocaleTimeString('vi-VN');
        }
    } catch (err) {
        showToast(`Lỗi kiểm tra Gateway: ${err.message}`, 'EMPTY');
    } finally {
        if (btn) {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    }
}

async function checkAllAdminGateways() {
    const btn = document.getElementById('btn-ping-all-gw');
    const originalText = btn ? btn.innerText : '🔍 Kiểm tra tất cả';
    if (btn) {
        btn.innerText = '⏳ Đang kiểm tra...';
        btn.disabled = true;
    }
    try {
        const res = await apiFetch('/api/admin/gateways/ping-all');
        const data = await res.json();
        showToast(`Đã kiểm tra xong ${data.total} Gateway: ${data.online_count} Online, ${data.offline_count} Mất kết nối`, data.offline_count > 0 ? 'EMPTY' : 'OK');
        await loadAdminGateways();
    } catch (err) {
        showToast(`Lỗi kiểm tra danh sách Gateway: ${err.message}`, 'EMPTY');
    } finally {
        if (btn) {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    }
}

async function handleCreateGateway() {
    const macInput = document.getElementById('new-gw-mac');
    const ipInput = document.getElementById('new-gw-ip');
    const mac = macInput ? macInput.value.trim() : '';
    const ip = ipInput ? ipInput.value.trim() : '';
    if (!mac && !ip) {
        alert("Vui lòng nhập Địa chỉ MAC cứng hoặc IP của Gateway");
        return;
    }

    try {
        const res = await apiFetch('/api/admin/gateways', {
            method: 'POST',
            body: JSON.stringify({
                mac_address: mac || null,
                ip_address: ip || null
            })
        });
        if (res.ok) {
            showToast("Đã thêm Gateway mới thành công!", "OK");
            if (macInput) macInput.value = '';
            if (ipInput) ipInput.value = '';
            loadAdminGateways();
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể thêm Gateway");
        }
    } catch (err) {
        alert("Lỗi khi thêm Gateway: " + err.message);
    }
}

async function handleDeleteGateway(id) {
    if (!confirm("Bạn có chắc chắn muốn xoá Gateway này? Các thiết bị thuộc gateway này cũng sẽ bị xoá.")) return;
    try {
        const res = await apiFetch(`/api/admin/gateways/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast("Đã xoá Gateway", "OK");
            loadAdminGateways();
        }
    } catch (err) {}
}

let assignedGatewayMacForPlacement = null;
let assignedGatewayIpForPlacement = null;

function assignGatewayToMap(gatewayMac, gatewayIp) {
    assignedGatewayMacForPlacement = gatewayMac || null;
    assignedGatewayIpForPlacement = gatewayIp || null;
    switchView('dashboard');
    if (!isPlacementMode) {
        togglePlacementMode();
    }
    const label = gatewayMac ? `MAC: ${gatewayMac}` : `IP: ${gatewayIp}`;
    showToast(`Đã chọn Gateway [${label}]. Hãy chọn Nhà ga/Tầng và click vào vị trí trên bản đồ!`, "OK");
}

function openEditDeviceModal(id, mac, label, gatewayId, cabinOrder, paperProfileId) {
    document.getElementById('form-device-id').value = id;
    document.getElementById('form-device-mac').value = mac;
    document.getElementById('form-device-order').value = cabinOrder || 1;
    document.getElementById('form-device-label').value = label;
    document.getElementById('form-device-gw').value = gatewayId;
    const profSelect = document.getElementById('form-device-paper-profile');
    if (profSelect) {
        profSelect.value = paperProfileId || '';
    }
    document.getElementById('modal-device-form').style.display = 'flex';
}

function closeDeviceModal() {
    document.getElementById('modal-device-form').style.display = 'none';
}

async function handleDeviceFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('form-device-id').value;
    const cabinOrder = parseInt(document.getElementById('form-device-order').value) || 1;
    const label = document.getElementById('form-device-label').value.trim();
    const gatewayId = parseInt(document.getElementById('form-device-gw').value);

    try {
        const paperProfileId = parseInt(document.getElementById('form-device-paper-profile')?.value) || null;
        const res = await apiFetch(`/api/admin/devices/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ label, gateway_id: gatewayId, cabin_order: cabinOrder, paper_profile_id: paperProfileId })
        });
        if (res.ok) {
            showToast("Đã cập nhật thông tin thiết bị!", "OK");
            closeDeviceModal();
            loadAdminDevices();
            if (selectedToiletId) {
                selectToilet(selectedToiletId);
            }
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể cập nhật thiết bị");
        }
    } catch (err) {}
}

// ================= ADD CABIN / DEVICE LOGIC =================
let allToiletsCache = [];

async function fetchAllToilets() {
    try {
        const res = await apiFetch('/api/summary');
        if (res.ok) {
            allToiletsCache = await res.json();
        }
    } catch (e) {}
}

function openAddCabinModal() {
    if (!selectedToiletId) {
        showToast("Vui lòng chọn một nhà vệ sinh trên bản đồ trước", "LOW");
        return;
    }
    document.getElementById('add-cabin-modal-title').innerText = "Thêm Cabin Mới Cho Nhà Vệ Sinh";
    document.getElementById('group-add-cabin-toilet-select').style.display = 'none';
    document.getElementById('group-add-cabin-toilet-name').style.display = 'block';
    document.getElementById('add-cabin-toilet-id').value = selectedToiletId;
    
    const toiletName = document.getElementById('panel-toilet-name').innerText;
    document.getElementById('add-cabin-toilet-name-display').value = toiletName;

    // Count existing cabin cards for next order
    const currentCount = document.querySelectorAll('#panel-cabin-list .cabin-card').length;
    const nextOrder = currentCount + 1;
    document.getElementById('add-cabin-order').value = nextOrder;
    document.getElementById('add-cabin-label').value = `Cabin ${nextOrder}`;
    document.getElementById('add-cabin-mac').value = '';

    document.getElementById('modal-add-cabin').style.display = 'flex';
}

async function openAddDeviceAdminModal() {
    await fetchAllToilets();
    document.getElementById('add-cabin-modal-title').innerText = "Thêm Thiết Bị / Cabin Mới";
    document.getElementById('group-add-cabin-toilet-select').style.display = 'block';
    document.getElementById('group-add-cabin-toilet-name').style.display = 'none';

    const sel = document.getElementById('add-cabin-select-toilet');
    sel.innerHTML = '';
    allToiletsCache.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.innerText = `${t.terminal_name} - ${t.floor_name} - ${t.name}`;
        sel.appendChild(opt);
    });

    onAddCabinToiletSelectChange();
    document.getElementById('add-cabin-mac').value = '';
    document.getElementById('modal-add-cabin').style.display = 'flex';
}

function onAddCabinToiletSelectChange() {
    const toiletId = parseInt(document.getElementById('add-cabin-select-toilet').value);
    document.getElementById('add-cabin-toilet-id').value = toiletId;
    const t = allToiletsCache.find(x => x.id === toiletId);
    const nextOrder = (t ? t.device_count : 0) + 1;
    document.getElementById('add-cabin-order').value = nextOrder;
    document.getElementById('add-cabin-label').value = `Cabin ${nextOrder}`;
}

function onCabinOrderInput() {
    const order = document.getElementById('add-cabin-order').value;
    const labelInput = document.getElementById('add-cabin-label');
    if (/^Cabin \d+$/.test(labelInput.value) || !labelInput.value) {
        labelInput.value = `Cabin ${order}`;
    }
}

function closeAddCabinModal() {
    document.getElementById('modal-add-cabin').style.display = 'none';
}

async function handleAddCabinSubmit(e) {
    e.preventDefault();
    const toiletId = parseInt(document.getElementById('add-cabin-toilet-id').value);
    const cabinOrder = parseInt(document.getElementById('add-cabin-order').value) || 1;
    const label = document.getElementById('add-cabin-label').value.trim();
    let mac = document.getElementById('add-cabin-mac').value.trim().toUpperCase();

    // Auto format MAC if entered without colons: AABBCCDDEEFF -> AA:BB:CC:DD:EE:FF
    if (/^[0-9A-F]{12}$/.test(mac)) {
        mac = mac.match(/.{1,2}/g).join(':');
    }

    if (!toiletId) {
        alert("Chưa chọn nhà vệ sinh hợp lệ");
        return;
    }

    try {
        const res = await apiFetch('/api/admin/devices', {
            method: 'POST',
            body: JSON.stringify({
                mac_address: mac,
                toilet_id: toiletId,
                cabin_order: cabinOrder,
                label: label,
                paper_profile_id: parseInt(document.getElementById('add-cabin-paper-profile')?.value) || null
            })
        });

        if (!res.ok) {
            const err = await res.json();
            alert(err.detail || "Không thể thêm cabin");
            return;
        }

        closeAddCabinModal();
        showToast(`Đã thêm ${label} (STT #${cabinOrder}, MAC: ${mac}) thành công!`, "OK");

        // If currently viewing this toilet, reload details
        if (selectedToiletId === toiletId) {
            selectToilet(toiletId);
        }
        // If in admin view, refresh admin devices
        if (document.getElementById('view-admin').style.display !== 'none') {
            loadAdminDevices();
            loadAdminGateways();
        }
    } catch (err) {
        alert("Lỗi kết nối khi thêm thiết bị");
    }
}

async function handleDeleteDevice(id) {
    if (!confirm("Bạn có chắc chắn muốn xoá thiết bị này?")) return;
    try {
        const res = await apiFetch(`/api/admin/devices/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast("Đã xoá thiết bị", "OK");
            loadAdminDevices();
            if (selectedToiletId) {
                selectToilet(selectedToiletId);
            }
        }
    } catch (err) {}
}

// ================= TOAST NOTIFICATION UTILITY =================
function showToast(message, type = 'OK') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast alert-${type}`;
    toast.innerHTML = `<strong>${type === 'OK' ? 'Thông báo' : 'Cảnh báo'}:</strong> ${message}`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.transition = 'opacity 0.4s';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 400);
    }, 4500);
}

// ================= TERMINAL & FLOOR MANAGEMENT (PARENT-CHILD HIERARCHY) =================
let currentAdminTerminals = [];
let collapsedTerminals = new Set();

async function loadAdminTerminals() {
    const container = document.getElementById('admin-terminals-tree-container');
    if (!container) return;

    try {
        const res = await apiFetch('/api/admin/terminals');
        if (!res.ok) {
            container.innerHTML = '<div class="alert alert-danger" style="margin: 1rem 0;">Không thể tải danh sách nhà ga</div>';
            return;
        }
        currentAdminTerminals = await res.json();
        renderAdminTerminalsTree();
    } catch (err) {
        console.error("Error loading admin terminals:", err);
        if (container) {
            container.innerHTML = `<div class="alert alert-danger" style="margin: 1rem 0;">Lỗi kết nối máy chủ: ${escapeHtml(err.message)}</div>`;
        }
    }
}

function renderAdminTerminalsTree() {
    const container = document.getElementById('admin-terminals-tree-container');
    if (!container) return;
    container.innerHTML = '';

    if (!currentAdminTerminals || currentAdminTerminals.length === 0) {
        container.innerHTML = `
            <div style="background: white; border-radius: 8px; border: 1px dashed var(--border-color); padding: 3rem 1.5rem; text-align: center; color: var(--text-secondary);">
                <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🏢</div>
                <h4 style="color: var(--text-primary); margin-bottom: 0.5rem; font-size: 1.1rem;">Chưa có Nhà ga nào trong hệ thống</h4>
                <p style="font-size: 0.9rem; margin-bottom: 1.25rem;">Hãy tạo Nhà ga đầu tiên để bắt đầu thiết lập các tầng và sơ đồ bản đồ.</p>
                <button class="btn btn-primary" onclick="openCreateTerminalModal()">➕ Thêm Nhà ga mới ngay</button>
            </div>
        `;
        return;
    }

    currentAdminTerminals.forEach(term => {
        const isCollapsed = collapsedTerminals.has(term.id);
        const card = document.createElement('div');
        card.className = 'terminal-group-card';
        card.style.cssText = 'background: white; border-radius: 8px; border: 1px solid var(--border-color); margin-bottom: 1.25rem; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);';

        const floors = term.floors || [];

        // Floors rows HTML
        let floorsHtml = '';
        if (floors.length === 0) {
            floorsHtml = `
                <div style="padding: 1.5rem 2.5rem; text-align: center; color: var(--text-secondary); background: #fafbfc; border-top: 1px solid #f1f5f9;">
                    <p style="margin: 0 0 0.5rem 0; font-size: 0.9rem;">Nhà ga này chưa có tầng nào.</p>
                    <button class="btn btn-secondary btn-sm" onclick="openCreateFloorModal(${term.id})">➕ Thêm tầng con đầu tiên cho ${escapeHtml(term.name)}</button>
                </div>
            `;
        } else {
            let floorRows = '';
            floors.forEach(fl => {
                const hasMap = !!fl.map_pdf_path;
                const mapBadge = hasMap
                    ? `<span class="badge badge-success" style="cursor: pointer; padding: 0.35rem 0.6rem;" onclick="window.open('${fl.map_pdf_path}', '_blank')" title="Bấm để xem PDF">✅ Đã có sơ đồ PDF</span>`
                    : `<span class="badge badge-warning" style="padding: 0.35rem 0.6rem;">⚠️ Chưa có bản đồ</span>`;

                const mapBtn = hasMap
                    ? `<button class="btn btn-secondary btn-sm" onclick="openFloorMapDirectModal(${fl.id}, '${escapeHtml(fl.name)}', '${escapeHtml(term.name)}')" title="Đổi file PDF sơ đồ bản đồ" style="margin-right: 0.25rem;">🗺️ Đổi bản đồ</button>`
                    : `<button class="btn btn-primary btn-sm" onclick="openFloorMapDirectModal(${fl.id}, '${escapeHtml(fl.name)}', '${escapeHtml(term.name)}')" title="Tải lên sơ đồ bản đồ PDF" style="margin-right: 0.25rem;">🗺️ Tải lên bản đồ</button>`;

                floorRows += `
                    <tr style="border-bottom: 1px solid #f1f5f9; transition: background 0.15s ease;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='white'">
                        <td style="padding: 0.75rem 1.25rem 0.75rem 2.5rem;">
                            <div style="display: flex; align-items: center; gap: 0.6rem;">
                                <span style="color: #cbd5e1; font-weight: bold; user-select: none;">└─</span>
                                <span style="font-size: 1.1rem;">🗺️</span>
                                <div>
                                    <strong style="color: var(--text-primary); font-size: 0.95rem;">${escapeHtml(fl.name)}</strong>
                                    <span style="color: var(--text-secondary); font-size: 0.75rem; margin-left: 0.4rem;">(ID: #${fl.id})</span>
                                </div>
                            </div>
                        </td>
                        <td style="padding: 0.75rem 1rem;">
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                ${mapBadge}
                                ${hasMap ? `<a href="${fl.map_pdf_path}" target="_blank" style="font-size: 0.8rem; color: var(--primary-color); text-decoration: none; font-weight: 500;" title="Xem file gốc">👁️ Xem</a>` : ''}
                            </div>
                        </td>
                        <td style="padding: 0.75rem 1rem; text-align: center;">
                            <span class="badge ${fl.toilet_count > 0 ? 'badge-success' : 'badge-secondary'}" style="font-size: 0.8rem; padding: 0.3rem 0.6rem;">${fl.toilet_count} toilet</span>
                        </td>
                        <td style="padding: 0.75rem 1.25rem; text-align: right; white-space: nowrap;">
                            ${mapBtn}
                            <button class="btn btn-secondary btn-sm" onclick="openEditFloorModal(${fl.id}, ${term.id}, '${escapeHtml(fl.name)}')" title="Đổi tên tầng" style="margin-right: 0.25rem;">✏️ Sửa</button>
                            <button class="btn btn-danger btn-sm" onclick="handleDeleteFloor(${fl.id}, '${escapeHtml(fl.name)}', ${fl.toilet_count})" title="Xóa tầng">🗑️ Xóa</button>
                        </td>
                    </tr>
                `;
            });

            floorsHtml = `
                <div class="table-responsive" style="margin: 0;">
                    <table style="width: 100%; border-collapse: collapse; margin: 0;">
                        <thead>
                            <tr style="background: #ffffff; color: var(--text-secondary); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e2e8f0;">
                                <th style="padding: 0.6rem 1.25rem 0.6rem 2.5rem; text-align: left;">Tầng con</th>
                                <th style="padding: 0.6rem 1rem; text-align: left;">Sơ đồ Bản đồ PDF</th>
                                <th style="padding: 0.6rem 1rem; text-align: center; width: 140px;">Số Toilet</th>
                                <th style="padding: 0.6rem 1.25rem; text-align: right; width: 260px;">Thao tác Tầng</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${floorRows}
                        </tbody>
                    </table>
                </div>
            `;
        }

        card.innerHTML = `
            <!-- PARENT HEADER: TERMINAL -->
            <div class="terminal-parent-header" style="background: #f8fafc; padding: 0.85rem 1.25rem; border-bottom: ${isCollapsed ? 'none' : '1px solid var(--border-color)'}; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem; border-left: 4px solid var(--primary-color);">
                <div style="display: flex; align-items: center; gap: 0.6rem; cursor: pointer;" onclick="toggleTerminalCollapse(${term.id})" title="Nhấn để thu gọn hoặc mở rộng tầng con">
                    <span style="font-size: 0.85rem; color: var(--text-secondary); width: 14px; text-align: center;">${isCollapsed ? '▶' : '▼'}</span>
                    <span style="font-size: 1.3rem;">🏢</span>
                    <strong style="font-size: 1.15rem; color: var(--text-primary); letter-spacing: 0.01em;">Nhà ga ${escapeHtml(term.name)}</strong>
                    <span style="color: var(--text-secondary); font-size: 0.8rem; margin-right: 0.35rem;">(#${term.id})</span>
                    <span class="badge badge-info" style="font-size: 0.8rem; font-weight: 600; padding: 0.3rem 0.6rem;">${term.floor_count} tầng</span>
                    <span class="badge ${term.toilet_count > 0 ? 'badge-success' : 'badge-secondary'}" style="font-size: 0.8rem; padding: 0.3rem 0.6rem;">${term.toilet_count} toilet</span>
                </div>
                <div style="display: flex; align-items: center; gap: 0.4rem;">
                    <button class="btn btn-primary btn-sm" onclick="openCreateFloorModal(${term.id})" title="Thêm tầng con vào ${escapeHtml(term.name)}">➕ Thêm tầng con</button>
                    <button class="btn btn-secondary btn-sm" onclick="openEditTerminalModal(${term.id}, '${escapeHtml(term.name)}')" title="Đổi tên nhà ga">✏️ Sửa tên</button>
                    <button class="btn btn-danger btn-sm" onclick="handleDeleteTerminal(${term.id}, '${escapeHtml(term.name)}', ${term.floor_count})" title="Xóa nhà ga">🗑️ Xóa</button>
                </div>
            </div>

            <!-- CHILDREN: FLOORS -->
            <div id="term-floors-container-${term.id}" class="terminal-children-body" style="display: ${isCollapsed ? 'none' : 'block'}; background: white;">
                ${floorsHtml}
            </div>
        `;

        container.appendChild(card);
    });
}

function toggleTerminalCollapse(termId) {
    if (collapsedTerminals.has(termId)) {
        collapsedTerminals.delete(termId);
    } else {
        collapsedTerminals.add(termId);
    }
    renderAdminTerminalsTree();
}

function toggleAllTerminalsCollapse() {
    const btn = document.getElementById('btn-toggle-all-terminals');
    if (collapsedTerminals.size === currentAdminTerminals.length) {
        collapsedTerminals.clear();
        if (btn) btn.innerText = "Thu gọn tất cả";
    } else {
        currentAdminTerminals.forEach(t => collapsedTerminals.add(t.id));
        if (btn) btn.innerText = "Mở rộng tất cả";
    }
    renderAdminTerminalsTree();
}

// Terminal Modal Functions
function openCreateTerminalModal() {
    document.getElementById('terminal-modal-title').innerText = "Thêm Nhà Ga Mới";
    document.getElementById('form-terminal-id').value = "";
    document.getElementById('form-terminal-name').value = "";
    document.getElementById('terminal-form-error').style.display = "none";
    document.getElementById('btn-submit-terminal').innerText = "Tạo Nhà Ga";
    document.getElementById('modal-terminal-form').style.display = "flex";
}

function openEditTerminalModal(id, name) {
    document.getElementById('terminal-modal-title').innerText = "Chỉnh Sửa Tên Nhà Ga";
    document.getElementById('form-terminal-id').value = id;
    document.getElementById('form-terminal-name').value = name;
    document.getElementById('terminal-form-error').style.display = "none";
    document.getElementById('btn-submit-terminal').innerText = "Lưu Thay Đổi";
    document.getElementById('modal-terminal-form').style.display = "flex";
}

function closeTerminalModal() {
    document.getElementById('modal-terminal-form').style.display = "none";
}

async function handleTerminalFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('form-terminal-id').value;
    const name = document.getElementById('form-terminal-name').value.trim();
    const errBox = document.getElementById('terminal-form-error');
    errBox.style.display = "none";

    if (!name) {
        errBox.innerText = "Vui lòng nhập tên nhà ga";
        errBox.style.display = "block";
        return;
    }

    try {
        let res;
        if (id) {
            res = await apiFetch(`/api/admin/terminals/${id}`, {
                method: 'PUT',
                body: JSON.stringify({ name })
            });
        } else {
            res = await apiFetch('/api/admin/terminals', {
                method: 'POST',
                body: JSON.stringify({ name })
            });
        }

        if (res.ok) {
            const data = await res.json();
            showToast(data.message || "Lưu nhà ga thành công", "OK");
            closeTerminalModal();
            await loadAdminTerminals();
            await loadTerminals();
            loadAdminMapsOptions();
        } else {
            const err = await res.json();
            errBox.innerText = err.detail || "Không thể lưu nhà ga";
            errBox.style.display = "block";
        }
    } catch (err) {
        errBox.innerText = "Lỗi kết nối máy chủ: " + err.message;
        errBox.style.display = "block";
    }
}

async function handleDeleteTerminal(id, name, floorCount) {
    const confirmMsg = floorCount > 0
        ? `CẢNH BÁO: Nhà ga "${name}" đang có ${floorCount} tầng và các nhà vệ sinh liên quan.\n\nBạn có CHẮC CHẮN muốn xóa nhà ga này và TOÀN BỘ dữ liệu bên trong không?`
        : `Bạn có chắc chắn muốn xóa Nhà ga "${name}" không?`;

    if (!confirm(confirmMsg)) return;

    try {
        const res = await apiFetch(`/api/admin/terminals/${id}`, { method: 'DELETE' });
        if (res.ok) {
            const data = await res.json();
            showToast(data.message || "Đã xóa nhà ga", "OK");
            await loadAdminTerminals();
            await loadTerminals();
            loadAdminMapsOptions();
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể xóa nhà ga");
        }
    } catch (err) {
        alert("Lỗi kết nối máy chủ: " + err.message);
    }
}

// Floor Modal Functions
function openCreateFloorModal(defaultTerminalId = null) {
    document.getElementById('floor-modal-title').innerText = "Thêm Tầng Mới Cho Nhà Ga";
    document.getElementById('form-floor-id').value = "";
    document.getElementById('form-floor-name').value = "";
    document.getElementById('form-floor-map-file').value = "";
    document.getElementById('group-floor-map-upload').style.display = "block";
    document.getElementById('floor-form-error').style.display = "none";
    document.getElementById('btn-submit-floor').innerText = "Tạo Tầng";

    // Populate terminal options
    const termSel = document.getElementById('form-floor-terminal');
    termSel.innerHTML = "";
    currentAdminTerminals.forEach(term => {
        const opt = document.createElement('option');
        opt.value = term.id;
        opt.innerText = term.name;
        termSel.appendChild(opt);
    });

    if (defaultTerminalId) {
        termSel.value = defaultTerminalId;
    }

    document.getElementById('modal-floor-form').style.display = "flex";
}

function openEditFloorModal(floorId, terminalId, floorName) {
    document.getElementById('floor-modal-title').innerText = "Chỉnh Sửa Tầng";
    document.getElementById('form-floor-id').value = floorId;
    document.getElementById('form-floor-name').value = floorName;
    document.getElementById('group-floor-map-upload').style.display = "none";
    document.getElementById('floor-form-error').style.display = "none";
    document.getElementById('btn-submit-floor').innerText = "Lưu Thay Đổi";

    // Populate terminal options
    const termSel = document.getElementById('form-floor-terminal');
    termSel.innerHTML = "";
    currentAdminTerminals.forEach(term => {
        const opt = document.createElement('option');
        opt.value = term.id;
        opt.innerText = term.name;
        termSel.appendChild(opt);
    });
    termSel.value = terminalId;

    document.getElementById('modal-floor-form').style.display = "flex";
}

function closeFloorModal() {
    document.getElementById('modal-floor-form').style.display = "none";
}

async function handleFloorFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('form-floor-id').value;
    const terminalId = parseInt(document.getElementById('form-floor-terminal').value);
    const name = document.getElementById('form-floor-name').value.trim();
    const mapFileInput = document.getElementById('form-floor-map-file');
    const errBox = document.getElementById('floor-form-error');
    errBox.style.display = "none";

    if (!terminalId) {
        errBox.innerText = "Vui lòng chọn nhà ga";
        errBox.style.display = "block";
        return;
    }
    if (!name) {
        errBox.innerText = "Vui lòng nhập tên tầng";
        errBox.style.display = "block";
        return;
    }

    try {
        let res;
        if (id) {
            res = await apiFetch(`/api/admin/floors/${id}`, {
                method: 'PUT',
                body: JSON.stringify({ terminal_id: terminalId, name })
            });
        } else {
            res = await apiFetch('/api/admin/floors', {
                method: 'POST',
                body: JSON.stringify({ terminal_id: terminalId, name })
            });
        }

        if (res.ok) {
            const data = await res.json();
            const newFloorId = data.id || id;

            // If map file was selected during creation, upload it now
            if (!id && mapFileInput && mapFileInput.files.length > 0 && newFloorId) {
                const formData = new FormData();
                formData.append('file', mapFileInput.files[0]);
                try {
                    await apiFetch(`/api/admin/floors/${newFloorId}/map`, {
                        method: 'POST',
                        body: formData
                    });
                } catch (mapErr) {
                    console.warn("Lỗi upload sơ đồ bản đồ:", mapErr);
                }
            }

            showToast(data.message || "Lưu tầng thành công", "OK");
            closeFloorModal();
            await loadAdminTerminals();
            await loadTerminals();
            loadAdminMapsOptions();
        } else {
            const err = await res.json();
            errBox.innerText = err.detail || "Không thể lưu tầng";
            errBox.style.display = "block";
        }
    } catch (err) {
        errBox.innerText = "Lỗi kết nối máy chủ: " + err.message;
        errBox.style.display = "block";
    }
}

async function handleDeleteFloor(floorId, floorName, toiletCount) {
    const confirmMsg = toiletCount > 0
        ? `CẢNH BÁO: Tầng "${floorName}" đang có ${toiletCount} nhà vệ sinh.\n\nBạn có chắc chắn muốn xóa tầng này và toàn bộ nhà vệ sinh thuộc tầng không?`
        : `Bạn có chắc chắn muốn xóa Tầng "${floorName}" không?`;

    if (!confirm(confirmMsg)) return;

    try {
        const res = await apiFetch(`/api/admin/floors/${floorId}`, { method: 'DELETE' });
        if (res.ok) {
            const data = await res.json();
            showToast(data.message || "Đã xóa tầng", "OK");
            await loadAdminTerminals();
            await loadTerminals();
            loadAdminMapsOptions();
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể xóa tầng");
        }
    } catch (err) {
        alert("Lỗi kết nối máy chủ: " + err.message);
    }
}

// Floor Map Direct Upload Modal Functions
function openFloorMapDirectModal(floorId, floorName, terminalName) {
    document.getElementById('floor-map-direct-id').value = floorId;
    document.getElementById('floor-map-direct-title').innerText = `Bản Đồ: ${floorName}`;
    document.getElementById('floor-map-direct-desc').innerText = `Chọn file PDF sơ đồ kiến trúc cho: ${terminalName} - ${floorName}`;
    document.getElementById('floor-map-direct-file').value = "";
    document.getElementById('floor-map-direct-error').style.display = "none";
    document.getElementById('modal-floor-map-direct').style.display = "flex";
}

function closeFloorMapDirectModal() {
    document.getElementById('modal-floor-map-direct').style.display = "none";
}

async function handleFloorMapDirectSubmit(e) {
    e.preventDefault();
    const floorId = document.getElementById('floor-map-direct-id').value;
    const fileInput = document.getElementById('floor-map-direct-file');
    const errBox = document.getElementById('floor-map-direct-error');
    errBox.style.display = "none";

    if (!fileInput.files || fileInput.files.length === 0) {
        errBox.innerText = "Vui lòng chọn file PDF";
        errBox.style.display = "block";
        return;
    }

    const file = fileInput.files[0];
    if (!file.name.toLowerCase().endsWith('.pdf')) {
        errBox.innerText = "Chỉ chấp nhận file định dạng .pdf";
        errBox.style.display = "block";
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const submitBtn = e.target.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.innerText = "Đang xử lý & rasterize...";

        const res = await apiFetch(`/api/admin/floors/${floorId}/map`, {
            method: 'POST',
            body: formData
        });

        submitBtn.disabled = false;
        submitBtn.innerText = "Tải lên & Lưu";

        if (res.ok) {
            const data = await res.json();
            showToast(data.message || "Đã cập nhật bản đồ tầng thành công!", "OK");
            closeFloorMapDirectModal();
            await loadAdminTerminals();
            await loadTerminals();
            loadAdminMapsOptions();
            // If currently viewing this floor on dashboard, re-render
            if (currentFloor && currentFloor.id === parseInt(floorId)) {
                await onFloorChanged();
            }
        } else {
            const err = await res.json();
            errBox.innerText = err.detail || "Không thể tải lên sơ đồ bản đồ";
            errBox.style.display = "block";
        }
    } catch (err) {
        errBox.innerText = "Lỗi kết nối máy chủ: " + err.message;
        errBox.style.display = "block";
    }
}
