// ================= GLOBAL STATE & CONFIG =================
let currentUser = null;
let currentTerminals = [];
let currentFloor = null;
let currentFloorToilets = [];
let selectedToiletId = null;
let currentPdfDoc = null;
let currentPdfPage = null;
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
            setToken(null);
            currentUser = null;
            updateUserUI();
            if (!url.includes('/api/auth/me')) {
                showToast("Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.", "OFFLINE");
                openLoginModal();
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
        } else {
            adminNav.style.display = 'none';
            if (adminMapTools) adminMapTools.style.display = 'none';
            if (adminToiletActions) adminToiletActions.style.display = 'none';
            if (addCabinBtn) addCabinBtn.style.display = 'none';
            if (editToiletBtn) editToiletBtn.style.display = 'none';
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
    try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {}
    setToken(null);
    currentUser = null;
    updateUserUI();
    showToast("Đã đăng xuất", "OFFLINE");
    switchView('dashboard');
}

// ================= REALTIME WEBSOCKET & AUTO-POLLING FALLBACK =================
let autoPollTimer = null;
function startAutoPolling() {
    if (autoPollTimer) return;
    autoPollTimer = setInterval(async () => {
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
    if (msg.event === 'STATE_UPDATE') {
        const data = msg.data;
        // Update floor markers if current floor matches
        if (currentFloor && currentFloor.id === data.floor_id) {
            // Update in-memory currentFloorToilets so subsequent renderMarkers preserves the status
            const t = currentFloorToilets.find(x => x.id === data.toilet_id);
            if (t) {
                t.status = data.status;
                if (data.gateway_online !== undefined) t.gateway_online = data.gateway_online;
            }
            const marker = document.getElementById(`toilet-marker-${data.toilet_id}`);
            if (marker) {
                marker.className = `toilet-marker ${data.status} ${selectedToiletId === data.toilet_id ? 'selected' : ''}`;
                const label = marker.querySelector('.marker-label');
                if (label) {
                    const statusText = (data.status === 'OFFLINE') ? 'Mất kết nối' : (t ? `${Math.round(t.min_paper)}%` : '');
                    label.innerText = `${data.toilet_name || (t ? t.name : '')} (${statusText})`;
                }
            }
        }
        // Update detail panel if this toilet is currently selected
        if (selectedToiletId === data.toilet_id) {
            updateToiletDetailPanelFromWs(data);
        }
    } else if (msg.event === 'DISCOVERED_CLIENTS_UPDATE') {
        const data = msg.data;
        // If current toilet is linked to this gateway IP or toilet ID, update discovered devices
        if (currentSelectedToiletData && (currentSelectedToiletData.gateway_ip === data.gateway_ip || selectedToiletId === data.toilet_id)) {
            currentSelectedToiletData.discovered_devices = data.discovered_devices;
            renderToiletDetailPanel(currentSelectedToiletData);
        }
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
        if (currentPdfPage && currentZoomLevel === 1.0 && currentFloor) {
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
        loadAdminMapsOptions();
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

        renderFloorPdf(currentFloor.map_pdf_path);
    } catch (err) {
        console.error("Error loading floor:", err);
    }
}

// ================= PDF RENDERING & MARKERS =================
function calculateBasePdfScale() {
    if (!currentPdfPage) return 1.0;
    const container = document.getElementById('map-scroll-wrapper');
    if (!container) return 1.0;

    // Available inner dimensions with safe margins
    const paddingX = 24;
    const paddingY = 24;
    const availWidth = Math.max(160, container.clientWidth - paddingX);
    const availHeight = Math.max(160, (container.clientHeight || 500) - paddingY);

    const unscaledViewport = currentPdfPage.getViewport({ scale: 1.0 });
    const scaleX = availWidth / unscaledViewport.width;
    const scaleY = availHeight / unscaledViewport.height;

    // Baseline fit scale
    const fitScale = Math.min(scaleX, scaleY);
    // User requested that what was 75% zoom level is now the standard 100% zoom level (1.75 * 0.75 = 1.3125)
    return fitScale * 1.3125;
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
    if (!currentPdfPage || isRenderingPdf) return;
    isRenderingPdf = true;

    try {
        const scale = basePdfScale * currentZoomLevel;
        const viewport = currentPdfPage.getViewport({ scale: scale });

        const canvas = document.getElementById('pdf-canvas');
        const context = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderContext = {
            canvasContext: context,
            viewport: viewport
        };

        await currentPdfPage.render(renderContext).promise;

        document.getElementById('map-loading').style.display = 'none';
        const canvasContainer = document.getElementById('map-canvas-container');
        canvasContainer.style.display = 'block';
        canvasContainer.style.width = `${viewport.width}px`;
        canvasContainer.style.height = `${viewport.height}px`;

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
    if (!currentPdfPage) return;
    let newZoom = Math.round((currentZoomLevel + delta) * 100) / 100;
    newZoom = Math.max(0.35, Math.min(3.5, newZoom));
    if (newZoom === currentZoomLevel) return;
    currentZoomLevel = newZoom;
    await renderCurrentPdfPage();
}

async function resetZoomMap() {
    if (!currentPdfPage) return;
    basePdfScale = calculateBasePdfScale();
    currentZoomLevel = 1.0;
    await renderCurrentPdfPage();
}

// Window resize handler: auto refit map if at 100% zoom
let mapResizeTimeout = null;
window.addEventListener('resize', () => {
    clearTimeout(mapResizeTimeout);
    mapResizeTimeout = setTimeout(() => {
        if (currentPdfPage && currentZoomLevel === 1.0 && currentFloor) {
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
    const effectiveStatus = isLiveAndInUse ? data.status : 'OFFLINE';

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
        statusPill.innerText = `● ${data.status}`;
    }

    document.getElementById('panel-gw-ip').innerText = data.gateway_ip || 'Chưa gán Gateway';
    const gwStatusEl = document.getElementById('panel-gw-status');
    const pingBtn = document.getElementById('btn-ping-gw');

    if (data.gateway_ip) {
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
                <div style="margin-top: 0.5rem; display: flex; justify-content: space-between; align-items: center;">
                    <button class="btn btn-secondary btn-sm" onclick="viewDeviceChart(${dev.id}, '${dev.label}')">📈 Lịch sử</button>
                    ${(currentUser && currentUser.role === 'admin') ? `
                        <div style="display: flex; gap: 0.35rem;">
                            <button class="btn btn-secondary btn-sm" onclick="openEditDeviceModal(${dev.id}, '${dev.mac_address}', '${dev.label}', ${data.gateway_id || 0}, ${dev.cabin_order || 1})" title="Sửa thông tin cabin">✏️ Sửa</button>
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
                <div style="margin-top: 0.5rem; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 0.75rem; color: #b45309; font-weight: 600;">
                        ⚡ Đang phát sóng (Chưa lưu)
                    </span>
                    <button class="btn btn-primary btn-sm" onclick="quickSaveDiscoveredDevice('${d.mac_address}', ${data.gateway_id || 0}, ${data.id})" title="Thêm client này vào hệ thống và lưu lại">
                        ➕ Thêm vào App (Lưu)
                    </button>
                </div>
            `;
            discSection.appendChild(card);
        });

        cabinList.appendChild(discSection);
    }
}

function updateToiletDetailPanelFromWs(wsData) {
    if (currentSelectedToiletData && currentSelectedToiletData.id === wsData.toilet_id) {
        currentSelectedToiletData.status = wsData.status;
        currentSelectedToiletData.devices = wsData.devices;
        if (wsData.gateway_online !== undefined) {
            currentSelectedToiletData.gateway_online = wsData.gateway_online;
        }
        if (wsData.gateway_ip) {
            currentSelectedToiletData.gateway_ip = wsData.gateway_ip;
        }
        if (wsData.discovered_devices !== undefined) {
            currentSelectedToiletData.discovered_devices = wsData.discovered_devices;
        }
    }
    renderToiletDetailPanel(currentSelectedToiletData || wsData);
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
    const gwInput = document.getElementById('new-toilet-gw-ip');
    if (assignedGatewayIpForPlacement) {
        gwInput.value = assignedGatewayIpForPlacement;
    } else {
        gwInput.value = '';
    }
    document.getElementById('modal-add-toilet').style.display = 'flex';
}

function closeAddToiletModal() {
    document.getElementById('modal-add-toilet').style.display = 'none';
}

async function handleAddToiletSubmit(e) {
    e.preventDefault();
    if (!currentFloor || !pendingPlacementCoords) return;

    const name = document.getElementById('new-toilet-name').value.trim();
    const gwIp = document.getElementById('new-toilet-gw-ip').value.trim();

    try {
        const res = await apiFetch('/api/admin/toilets', {
            method: 'POST',
            body: JSON.stringify({
                floor_id: currentFloor.id,
                name: name,
                x: pendingPlacementCoords.x,
                y: pendingPlacementCoords.y,
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
        assignedGatewayIpForPlacement = null;
        showToast("Đã thêm nhà vệ sinh mới!", "OK");
        await onFloorChanged();
    } catch (err) {
        alert("Lỗi kết nối");
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
    const gwIp = currentSelectedToiletData.gateway_ip || '';
    document.getElementById('edit-toilet-id').value = currentSelectedToiletData.id;
    document.getElementById('edit-toilet-floor-id').value = currentFloor ? currentFloor.id : '';
    document.getElementById('edit-toilet-terminal-id').value = currentFloor ? currentFloor.terminal_id : '';
    document.getElementById('edit-toilet-name').value = currentSelectedToiletData.name;
    document.getElementById('edit-toilet-gw-ip').value = gwIp;
    document.getElementById('edit-toilet-x').value = currentSelectedToiletData.x;
    document.getElementById('edit-toilet-y').value = currentSelectedToiletData.y;
    document.getElementById('modal-edit-toilet').style.display = 'flex';
    
    // Check and show live discovered clients for this Gateway IP
    checkDiscoveredClientsForModal(gwIp);
}

async function checkDiscoveredClientsForModal(ip) {
    const preview = document.getElementById('edit-toilet-discovered-preview');
    if (!preview) return;
    const cleanIp = (ip || '').trim();
    if (!cleanIp) {
        preview.style.display = 'none';
        return;
    }
    try {
        const res = await apiFetch(`/api/gateways/discovered?ip=${encodeURIComponent(cleanIp)}`);
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
                <div style="font-weight: 600; margin-bottom: 4px;">📡 Đã phát hiện ${clients.length} Client đang phát sóng tới IP này:</div>
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
            preview.innerHTML = `ℹ️ <em>Chưa có Client nào gửi tín hiệu tới IP này (sẽ tự động hiển thị ngay khi Client bắt đầu phát sóng).</em>`;
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
    const gwIp = document.getElementById('edit-toilet-gw-ip').value.trim();
    const x = parseFloat(document.getElementById('edit-toilet-x').value);
    const y = parseFloat(document.getElementById('edit-toilet-y').value);

    try {
        const res = await apiFetch(`/api/admin/toilets/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
                name: name,
                gateway_ip: gwIp,
                x: x,
                y: y
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
        alert("Lỗi kết nối khi cập nhật");
    }
}

function openEditToiletModalById(id, name, gwIp, x, y, floorId, terminalId) {
    if (!currentUser || currentUser.role !== 'admin') {
        showToast("Vui lòng đăng nhập quyền Quản trị viên (Admin) để sửa nhà vệ sinh", "LOW");
        openLoginModal();
        return;
    }
    const cleanGw = (gwIp && gwIp !== 'None' && gwIp !== 'Chưa gán') ? gwIp : '';
    document.getElementById('edit-toilet-id').value = id;
    document.getElementById('edit-toilet-floor-id').value = floorId || (currentFloor ? currentFloor.id : '');
    document.getElementById('edit-toilet-terminal-id').value = terminalId || (currentFloor ? currentFloor.terminal_id : '');
    document.getElementById('edit-toilet-name').value = name || '';
    document.getElementById('edit-toilet-gw-ip').value = cleanGw;
    document.getElementById('edit-toilet-x').value = (x !== undefined && x !== null) ? x : 0.5;
    document.getElementById('edit-toilet-y').value = (y !== undefined && y !== null) ? y : 0.5;
    document.getElementById('modal-edit-toilet').style.display = 'flex';
    checkDiscoveredClientsForModal(cleanGw);
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
                            <button class="btn btn-secondary btn-sm" onclick="openEditToiletModalById(${item.id}, '${item.name.replace(/'/g, "\\'")}', '${item.gateway_ip === 'Chưa gán' ? '' : item.gateway_ip}', ${item.x !== undefined ? item.x : 0.5}, ${item.y !== undefined ? item.y : 0.5}, ${item.floor_id}, ${item.terminal_id})" title="Sửa thông tin">
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
    const tabs = ['users', 'maps', 'gateways', 'paper'];
    tabs.forEach(t => {
        const el = document.getElementById(`admin-tab-${t}`);
        if (el) el.style.display = (t === tabName) ? 'block' : 'none';
    });

    const btns = document.querySelectorAll('#view-admin .tab-btn');
    const idxMap = { 'users': 0, 'maps': 1, 'gateways': 2, 'paper': 3 };
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
    } else if (tabName === 'maps') {
        loadAdminMapsOptions();
    }
}

async function loadAdminPaperSettings() {
    try {
        const res = await apiFetch('/api/settings/paper');
        if (!res.ok) return;
        const cfg = await res.json();
        if (document.getElementById('setting-empty-dist')) {
            document.getElementById('setting-empty-dist').value = cfg.empty_distance_mm || 140;
        }
        if (document.getElementById('setting-roll-thick')) {
            document.getElementById('setting-roll-thick').value = cfg.roll_thickness_mm || 110;
        }
        if (document.getElementById('setting-warn-low')) {
            document.getElementById('setting-warn-low').value = cfg.warn_low_cm || 1.5;
        }
        if (document.getElementById('setting-warn-low-uses')) {
            document.getElementById('setting-warn-low-uses').value = cfg.warn_low_uses || 60;
        }
        if (document.getElementById('setting-warn-mid')) {
            document.getElementById('setting-warn-mid').value = cfg.warn_mid_cm || 1.0;
        }
        if (document.getElementById('setting-warn-mid-uses')) {
            document.getElementById('setting-warn-mid-uses').value = cfg.warn_mid_uses || 35;
        }
        if (document.getElementById('setting-warn-empty')) {
            document.getElementById('setting-warn-empty').value = cfg.warn_empty_cm || 0.5;
        }
        if (document.getElementById('setting-warn-empty-uses')) {
            document.getElementById('setting-warn-empty-uses').value = cfg.warn_empty_uses || 15;
        }
        if (document.getElementById('setting-sensor-offset')) {
            document.getElementById('setting-sensor-offset').value = cfg.sensor_offset_mm || 0;
        }
        updatePaperPreviewTable();
    } catch (e) {
        console.error("Error loading paper settings:", e);
    }
}

function updatePaperPreviewTable() {
    const emptyDist = parseFloat(document.getElementById('setting-empty-dist')?.value) || 160;
    const rollThick = parseFloat(document.getElementById('setting-roll-thick')?.value) || 110;
    const sensorOffset = parseFloat(document.getElementById('setting-sensor-offset')?.value) || 0;
    const warnLow = parseFloat(document.getElementById('setting-warn-low')?.value) || 1.5;
    const warnLowUses = parseInt(document.getElementById('setting-warn-low-uses')?.value) || 60;
    const warnMid = parseFloat(document.getElementById('setting-warn-mid')?.value) || 1.0;
    const warnMidUses = parseInt(document.getElementById('setting-warn-mid-uses')?.value) || 35;
    const warnEmpty = parseFloat(document.getElementById('setting-warn-empty')?.value) || 0.5;
    const warnEmptyUses = parseInt(document.getElementById('setting-warn-empty-uses')?.value) || 15;

    const fullDist = Math.max(0, emptyDist - rollThick);
    const distLow = Math.round(emptyDist - warnLow * 10);
    const distMid = Math.round(emptyDist - warnMid * 10);
    const distEmpty = Math.round(emptyDist - warnEmpty * 10);

    const emptyBadge = document.getElementById('preview-empty-dist-calc');
    if (emptyBadge) {
        emptyBadge.innerHTML = `👉 Đo &ge; <strong>${emptyDist} mm</strong> &rarr; Báo Hết (0%)`;
    }
    const fullBadge = document.getElementById('preview-full-dist-calc');
    if (fullBadge) {
        fullBadge.innerHTML = `👉 Đo &le; <strong>${fullDist} mm</strong> (${emptyDist} - ${rollThick}) &rarr; Báo Đầy 100%`;
    }
    const offsetBadge = document.getElementById('preview-offset-calc');
    if (offsetBadge) {
        offsetBadge.innerHTML = `👉 Đang bù trừ: <strong>${sensorOffset} mm</strong>`;
    }

    const tbody = document.getElementById('paper-auto-calc-table');
    if (tbody) {
        tbody.innerHTML = `
            <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 6px 10px;"><strong>${(rollThick/10).toFixed(1)} cm</strong> (Đầy nguyên cuộn)</td>
                <td style="padding: 6px 10px; color: #166534; font-weight: 700;">Khoảng cách = ${fullDist} mm ${sensorOffset ? `<span style="font-size:0.7rem; color:#4338ca;">(gốc: ${fullDist + sensorOffset}mm)</span>` : ''}</td>
                <td style="padding: 6px 10px; font-weight: 600;">~${Math.round(warnLowUses + ((rollThick/10 - warnLow)/0.5)*25)} lượt</td>
                <td style="padding: 6px 10px;"><span class="status-pill OK" style="font-size: 0.7rem;">OK (Đầy giấy)</span></td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background: #f0fdf4;">
                <td style="padding: 6px 10px;"><strong>&gt; ${warnLow} cm</strong> (Nhiều hơn ${warnLow} cm)</td>
                <td style="padding: 6px 10px; color: #166534; font-weight: 700;">Khoảng cách &lt; ${distLow} mm ${sensorOffset ? `<span style="font-size:0.7rem; color:#4338ca;">(gốc: &lt; ${distLow + sensorOffset}mm)</span>` : ''}</td>
                <td style="padding: 6px 10px; font-weight: 600;">&gt; ${warnLowUses} lượt</td>
                <td style="padding: 6px 10px;"><span class="status-pill OK" style="font-size: 0.7rem;">OK (Không cảnh báo)</span></td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background: #fefce8;">
                <td style="padding: 6px 10px;"><strong>&le; ${warnLow} cm</strong> (Còn ${warnLow} cm)</td>
                <td style="padding: 6px 10px; color: #b45309; font-weight: 700;">Khoảng cách &ge; ${distLow} mm ${sensorOffset ? `<span style="font-size:0.7rem; color:#4338ca;">(gốc: &ge; ${distLow + sensorOffset}mm)</span>` : ''}</td>
                <td style="padding: 6px 10px; font-weight: 600;">&approx; ${warnLowUses} lượt</td>
                <td style="padding: 6px 10px;"><span class="status-pill LOW" style="font-size: 0.7rem;">LOW (Cảnh báo Sắp hết)</span></td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background: #fffbeb;">
                <td style="padding: 6px 10px;"><strong>&le; ${warnMid} cm</strong> (Còn ${warnMid} cm)</td>
                <td style="padding: 6px 10px; color: #b45309; font-weight: 700;">Khoảng cách &ge; ${distMid} mm ${sensorOffset ? `<span style="font-size:0.7rem; color:#4338ca;">(gốc: &ge; ${distMid + sensorOffset}mm)</span>` : ''}</td>
                <td style="padding: 6px 10px; font-weight: 600;">&approx; ${warnMidUses} lượt</td>
                <td style="padding: 6px 10px;"><span class="status-pill LOW" style="font-size: 0.7rem;">LOW (Cảnh báo Sắp hết)</span></td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background: #fef2f2;">
                <td style="padding: 6px 10px;"><strong>&le; ${warnEmpty} cm</strong> (Còn ${warnEmpty} cm)</td>
                <td style="padding: 6px 10px; color: #dc2626; font-weight: 700;">Khoảng cách &ge; ${distEmpty} mm ${sensorOffset ? `<span style="font-size:0.7rem; color:#4338ca;">(gốc: &ge; ${distEmpty + sensorOffset}mm)</span>` : ''}</td>
                <td style="padding: 6px 10px; font-weight: 600;">&approx; ${warnEmptyUses} lượt</td>
                <td style="padding: 6px 10px;"><span class="status-pill EMPTY" style="font-size: 0.7rem;">EMPTY (Cảnh báo Hết giấy)</span></td>
            </tr>
            <tr style="background: #fafafa;">
                <td style="padding: 6px 10px;"><strong>0.0 cm</strong> (Hết sạch cuộn)</td>
                <td style="padding: 6px 10px; color: #dc2626; font-weight: 700;">Khoảng cách &ge; ${emptyDist} mm ${sensorOffset ? `<span style="font-size:0.7rem; color:#4338ca;">(gốc: &ge; ${emptyDist + sensorOffset}mm)</span>` : ''}</td>
                <td style="padding: 6px 10px; font-weight: 600;">0 lượt</td>
                <td style="padding: 6px 10px;"><span class="status-pill EMPTY" style="font-size: 0.7rem;">EMPTY (Hết sạch)</span></td>
            </tr>
        `;
    }

    testCalculateSensorDist();
}

function testCalculateSensorDist() {
    const emptyDist = parseFloat(document.getElementById('setting-empty-dist')?.value) || 160;
    const rollThick = parseFloat(document.getElementById('setting-roll-thick')?.value) || 110;
    const sensorOffset = parseFloat(document.getElementById('setting-sensor-offset')?.value) || 0;
    const warnLow = parseFloat(document.getElementById('setting-warn-low')?.value) || 1.5;
    const warnLowUses = parseInt(document.getElementById('setting-warn-low-uses')?.value) || 60;
    const warnMid = parseFloat(document.getElementById('setting-warn-mid')?.value) || 1.0;
    const warnMidUses = parseInt(document.getElementById('setting-warn-mid-uses')?.value) || 35;
    const warnEmpty = parseFloat(document.getElementById('setting-warn-empty')?.value) || 0.5;
    const warnEmptyUses = parseInt(document.getElementById('setting-warn-empty-uses')?.value) || 15;

    const sensorDistInput = document.getElementById('test-sensor-dist');
    const resEl = document.getElementById('test-sensor-result');
    if (!resEl || !sensorDistInput) return;

    const rawDist = parseFloat(sensorDistInput.value);
    if (isNaN(rawDist) || rawDist < 0) {
        resEl.innerHTML = '<span style="color: #64748b;">Nhập số mm hợp lệ...</span>';
        return;
    }

    const sensorDist = Math.max(0, rawDist - sensorOffset);
    let thickMm = (sensorDist >= emptyDist) ? 0 : (emptyDist - sensorDist);
    if (thickMm > rollThick) thickMm = rollThick;
    const thickCm = (thickMm / 10).toFixed(2);
    const pct = ((thickMm / rollThick) * 100).toFixed(1);

    let uses = 0;
    const numThickCm = parseFloat(thickCm);
    if (numThickCm <= 0) uses = 0;
    else if (numThickCm <= warnEmpty) uses = Math.round((numThickCm / warnEmpty) * warnEmptyUses);
    else if (numThickCm <= warnMid) uses = Math.round(warnEmptyUses + ((numThickCm - warnEmpty) / (warnMid - warnEmpty)) * (warnMidUses - warnEmptyUses));
    else if (numThickCm <= warnLow) uses = Math.round(warnMidUses + ((numThickCm - warnMid) / (warnLow - warnMid)) * (warnLowUses - warnMidUses));
    else uses = Math.round(warnLowUses + ((numThickCm - warnLow) / 0.5) * 25);

    let stColor = '#166534', stText = 'Bình thường (OK) - Không cảnh báo';
    if (numThickCm <= warnEmpty) {
        stColor = '#dc2626'; stText = 'Cảnh báo HẾT GIẤY (EMPTY)';
    } else if (numThickCm <= warnLow) {
        stColor = '#b45309'; stText = 'Cảnh báo SẮP HẾT (LOW)';
    }

    resEl.innerHTML = `
        <span>👉 Cảm biến đo: <strong>${rawDist} mm</strong> ${sensorOffset ? `(Bù trừ -${sensorOffset}mm = <strong>${sensorDist}mm</strong>)` : ''} &rarr; Độ dày giấy: <strong style="color: #0284c7;">${thickCm} cm</strong> (${pct}%) | Còn lại: <strong style="color: #0284c7;">~${uses} lượt dùng</strong> | Báo: <strong style="color: ${stColor};">${stText}</strong></span>
    `;
}

async function handleSavePaperSettings(e) {
    e.preventDefault();
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
        const res = await apiFetch('/api/admin/settings/paper', {
            method: 'PUT',
            body: JSON.stringify({
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
            showToast("Đã lưu thông số cuộn giấy & bù trừ sai số thành công!", "OK");
            updatePaperPreviewTable();
            // If currently viewing a toilet, refresh details
            if (selectedToiletId) {
                selectToilet(selectedToiletId);
            }
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể lưu cấu hình");
        }
    } catch (err) {
        alert("Lỗi kết nối khi lưu cấu hình");
    }
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

// Gateways & Devices Management
async function loadAdminGateways() {
    try {
        const res = await apiFetch('/api/admin/gateways');
        if (!res.ok) return;
        const gateways = await res.json();

        let discoveredMap = {};
        try {
            const discRes = await apiFetch('/api/gateways/discovered');
            if (discRes.ok) {
                discoveredMap = await discRes.json();
            }
        } catch (e) {}

        const tbody = document.getElementById('admin-gateways-table');
        tbody.innerHTML = '';
        gateways.forEach(gw => {
            const discList = discoveredMap[gw.ip_address] || [];
            let discBadge = '';
            if (discList.length > 0) {
                discBadge = `<br><span class="badge-live-pulse" style="margin-top: 3px; font-size: 0.65rem;" title="${discList.map(c => c.mac_address).join(', ')}">📡 +${discList.length} client mới</span>`;
            }

            // Tag CHỜ GÁN nếu Gateway chưa được gán vào Toilet nào (để màu xám)
            const newTag = gw.is_new 
                ? `<span style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; font-weight: 600; margin-left: 6px; display: inline-block;">CHỜ GÁN</span>` 
                : '';

            // Trạng thái: Những gateway KHÔNG ĐƯỢC GÁN vào WC thì để màu xám (⚪)
            // Chỉ những cái nào ĐÃ GÁN VÀ CÓ TÍN HIỆU ĐANG ĐƯỢC SỬ DỤNG mới để màu xanh (🟢)
            let statusBadge = '';
            if (gw.is_new) {
                // Chưa gán địa chỉ / vị trí -> màu xám
                statusBadge = gw.is_online
                    ? `<span style="background: #f8fafc; color: #475569; border: 1px solid #cbd5e1; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">⚪ Có tín hiệu (Chưa gán)</span>`
                    : `<span style="background: #f8fafc; color: #94a3b8; border: 1px solid #e2e8f0; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">⚪ Mất kết nối (Chưa gán)</span>`;
            } else {
                // Đã gán vào nhà vệ sinh
                statusBadge = gw.is_online
                    ? `<span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">🟢 Online</span>`
                    : `<span style="background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">🔴 Mất kết nối</span>`;
            }

            // Nút hành động: Nếu chưa gán toilet thì gợi ý thêm vị trí lên Map
            const actionBtn = gw.is_new
                ? `<button class="btn btn-primary btn-sm" style="margin-right: 4px;" onclick="assignGatewayToMap('${gw.ip_address}')">📍 Đặt lên Map</button>`
                : '';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${gw.id}</td>
                <td><strong>${gw.ip_address}</strong> ${newTag}</td>
                <td id="gw-status-badge-${gw.id}">${statusBadge}</td>
                <td><strong style="color: #2563eb;">${gw.terminal_name}</strong></td>
                <td>${gw.floor_name}</td>
                <td>${gw.toilet_name}</td>
                <td>${gw.device_count} ${discBadge}</td>
                <td id="gw-last-seen-${gw.id}">${gw.last_seen ? new Date(gw.last_seen).toLocaleTimeString('vi-VN') : 'Chưa có'}</td>
                <td>
                    ${actionBtn}
                    <button class="btn btn-secondary btn-sm" id="btn-ping-gw-${gw.id}" style="margin-right: 4px;" onclick="checkAdminGateway('${gw.ip_address}', ${gw.id}, ${gw.is_new ? 'true' : 'false'}, this)" title="Kiểm tra tín hiệu Gateway này">🔍 Kiểm tra</button>
                    <button class="btn btn-danger btn-sm" onclick="handleDeleteGateway(${gw.id})">Xoá</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Also populate select options in device edit form
        const gwSelect = document.getElementById('form-device-gw');
        gwSelect.innerHTML = '';
        gateways.forEach(gw => {
            const opt = document.createElement('option');
            opt.value = gw.id;
            opt.innerText = `${gw.ip_address} (${gw.toilet_name})`;
            gwSelect.appendChild(opt);
        });
    } catch (err) {}
}

async function checkAdminGateway(ip, gwId, isNew, btn) {
    if (!ip) return;
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
                    badgeEl.innerHTML = `<span style="background: #f8fafc; color: #475569; border: 1px solid #cbd5e1; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">⚪ Có tín hiệu (Chưa gán)</span>`;
                } else {
                    badgeEl.innerHTML = `<span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">🟢 Online</span>`;
                }
            }
        } else {
            showToast(`🔴 Gateway ${ip} MẤT KẾT NỐI! ${data.message || ''}`, 'EMPTY');
            if (badgeEl) {
                if (isNew) {
                    badgeEl.innerHTML = `<span style="background: #f8fafc; color: #94a3b8; border: 1px solid #e2e8f0; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">⚪ Mất kết nối (Chưa gán)</span>`;
                } else {
                    badgeEl.innerHTML = `<span style="background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">🔴 Mất kết nối</span>`;
                }
            }
        }
        if (lastSeenEl && data.last_seen) {
            lastSeenEl.innerText = new Date(data.last_seen).toLocaleTimeString('vi-VN');
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
    const ipInput = document.getElementById('new-gw-ip');
    const ip = ipInput.value.trim();
    if (!ip) return;

    try {
        const res = await apiFetch(`/api/admin/gateways?ip_address=${encodeURIComponent(ip)}`, { method: 'POST' });
        if (res.ok) {
            showToast("Đã thêm Gateway mới!", "OK");
            ipInput.value = '';
            loadAdminGateways();
        } else {
            const err = await res.json();
            alert(err.detail || "Không thể thêm Gateway");
        }
    } catch (err) {}
}

async function handleDeleteGateway(id) {
    if (!confirm("Bạn có chắc chắn muốn xoá Gateway này? Các thiết bị thuộc gateway này cũng sẽ bị xoá.")) return;
    try {
        const res = await apiFetch(`/api/admin/gateways/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast("Đã xoá Gateway", "OK");
            loadAdminGateways();
            loadAdminDevices();
        }
    } catch (err) {}
}

let assignedGatewayIpForPlacement = null;

function assignGatewayToMap(gatewayIp) {
    assignedGatewayIpForPlacement = gatewayIp;
    // Chuyển sang View Bản Đồ Tầng (view-dashboard)
    switchView('dashboard');
    // Bật chế độ đặt vị trí trên bản đồ
    if (!isPlacementMode) {
        togglePlacementMode();
    }
    showToast(`Đã chọn Gateway ${gatewayIp}. Hãy chọn Nhà ga/Tầng và click vào vị trí trên bản đồ!`, "OK");
}

async function loadAdminDevices() {
    try {
        const res = await apiFetch('/api/admin/devices');
        if (!res.ok) return;
        const devices = await res.json();

        const tbody = document.getElementById('admin-devices-table');
        tbody.innerHTML = '';
        devices.forEach(d => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${d.id}</td>
                <td><strong style="color: var(--primary);">#${d.cabin_order || 1}</strong></td>
                <td><code>${d.mac_address}</code></td>
                <td><strong>${d.label}</strong></td>
                <td>${d.gateway_ip}</td>
                <td>${d.toilet_name}</td>
                <td>${Math.round(d.paper_level)}%</td>
                <td>${Math.round(d.battery)}%</td>
                <td><span class="status-pill ${d.status}">● ${d.status}</span></td>
                <td>
                    <button class="btn btn-secondary btn-sm" onclick="openEditDeviceModal(${d.id}, '${d.mac_address}', '${d.label}', ${d.gateway_id}, ${d.cabin_order || 1})">Sửa</button>
                    <button class="btn btn-danger btn-sm" onclick="handleDeleteDevice(${d.id})">Xoá</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {}
}

function openEditDeviceModal(id, mac, label, gatewayId, cabinOrder) {
    document.getElementById('form-device-id').value = id;
    document.getElementById('form-device-mac').value = mac;
    document.getElementById('form-device-order').value = cabinOrder || 1;
    document.getElementById('form-device-label').value = label;
    document.getElementById('form-device-gw').value = gatewayId;
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
        const res = await apiFetch(`/api/admin/devices/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ label, gateway_id: gatewayId, cabin_order: cabinOrder })
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
                label: label
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
